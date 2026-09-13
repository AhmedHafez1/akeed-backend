import { Injectable, Logger, Optional } from '@nestjs/common';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { integrations, orders } from '../../infrastructure/database/schema';
import { OrderEligibilityService } from './order-eligibility.service';
import { VerificationSendService } from './verification-send.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { CreditEligibilityService } from './credit-eligibility.service';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { adjustForQuietHours } from '../../shared/utils/quiet-hours.util';
import { isSendFailureReason } from '../../shared/verification/verification-lifecycle';
import {
  isSyntheticOrder,
  isSyntheticTestOrderId,
} from '../../shared/commerce/synthetic-order';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

type IntegrationRecord = typeof integrations.$inferSelect;

type SkippedResult = { skipped: true; reason: string; orderId?: string };
type ProcessedResult = { orderId: string; verificationId: string };
type HandleNewOrderResult = SkippedResult | ProcessedResult;
type SyntheticTestResult =
  | SkippedResult
  | (ProcessedResult & {
      deliveryStatus:
        | 'sent'
        | 'sent_untracked'
        | 'failed'
        | 'plan_limit_reached'
        | 'skipped'
        | 'outcome_unknown';
      reason?: string;
    });
type PreparedVerification = {
  order: Awaited<ReturnType<OrdersRepository['create']>>;
  verification: {
    id: string;
    status?: string | null;
    lastSentAt?: string | null;
  };
  existing: boolean;
};

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    private orderEligibilityService: OrderEligibilityService,
    private verificationSendService: VerificationSendService,
    private readonly billingEntitlementService: BillingEntitlementService,
    private readonly creditEligibility: CreditEligibilityService,
    private readonly automationProducer: VerificationAutomationProducer,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
  ) {}

  async handleNewOrder(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<HandleNewOrderResult> {
    const skipReason = await this.validateIntegrationCanVerify(
      orderData,
      integration,
    );
    if (skipReason) {
      return { skipped: true, reason: skipReason };
    }

    const isTestOrder = isSyntheticTestOrderId(orderData.externalOrderId);
    if (!isTestOrder) {
      await this.adminLifecycles?.markMilestone(
        integration.id,
        'firstEligibleOrderAt',
        undefined,
        { eligible_real_cod_detected: 'captured_exact' },
      );
    }

    this.logger.log(
      buildBackendLog(VerificationHubService.name, {
        action: 'verification-order-process',
        outcome: 'success',
        orgId: integration.orgId,
        shopDomain: integration.platformStoreUrl,
        integrationId: integration.id,
        orderId: orderData.externalOrderId,
      }),
    );

    const prepared = await this.prepareVerification(orderData, integration);
    if ('skipped' in prepared) return prepared;
    const { order, verification } = prepared;
    if (prepared.existing) {
      // A re-delivered or merchant-retried ingestion event may resume a
      // verification that never actually sent. Both guards below are status
      // based, and the dispatch ledger keys one logical send per verification,
      // so this is safe for every platform: an already-sent verification is
      // never re-sent.
      const reopened =
        await this.verificationsRepo.reopenRetryableInitialFailure(
          verification.id,
          order.orgId,
        );
      if (
        reopened ||
        (verification.status === 'pending' && !verification.lastSentAt)
      ) {
        await this.dispatchInitialSend(verification, order, integration);
      }
      return { orderId: order.id, verificationId: verification.id };
    }

    await this.dispatchInitialSend(verification, order, integration);

    return { orderId: order.id, verificationId: verification.id };
  }

  async handleSyntheticTestOrder(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<SyntheticTestResult> {
    const sourceReason = await this.validateSyntheticTestSource(
      orderData,
      integration,
    );
    if (sourceReason) return { skipped: true, reason: sourceReason };

    const prepared = await this.prepareVerification(orderData, integration);
    if ('skipped' in prepared) return prepared;
    const { order, verification } = prepared;
    if (prepared.existing) {
      return {
        orderId: order.id,
        verificationId: verification.id,
        deliveryStatus: 'skipped',
        reason: 'verification_already_exists',
      };
    }
    const delivery = await this.verificationSendService.sendInitial(
      verification.id,
    );

    await this.applyInitialSendFailure(verification.id, order.orgId, delivery);

    return {
      orderId: order.id,
      verificationId: verification.id,
      deliveryStatus: delivery.status,
      reason: delivery.reason,
    };
  }

  /**
   * Schedules the follow-up send and the no-reply escalation, applying
   * quiet-hours adjustment and ensuring no-reply runs strictly after a
   * follow-up attempt when follow-ups are enabled.
   */
  async scheduleFollowUpAndEscalation(params: {
    verificationId: string;
    orgId: string;
    integration: IntegrationRecord;
    baselineSentAt: Date;
  }): Promise<void> {
    const { integration, baselineSentAt } = params;
    const baseMs = baselineSentAt.getTime();

    const quietConfig = {
      enabled: integration.quietHoursEnabled,
      start: integration.quietHoursStart,
      end: integration.quietHoursEnd,
      timezone: integration.timezone,
    };

    let followUpDueAt: Date | null = null;
    if (
      integration.followUpEnabled &&
      (integration.followUpDelayMinutes ?? 0) > 0
    ) {
      followUpDueAt = adjustForQuietHours(
        new Date(baseMs + integration.followUpDelayMinutes * 60_000),
        quietConfig,
      );
      await this.automationProducer.enqueueFollowUp({
        verificationId: params.verificationId,
        orgId: params.orgId,
        dueAt: followUpDueAt,
      });
    }

    const escalationMinutes = Math.max(
      0,
      integration.escalationDelayMinutes ?? 0,
    );
    if (integration.escalationEnabled && escalationMinutes > 0) {
      let escalationDueAt = adjustForQuietHours(
        new Date(baseMs + escalationMinutes * 60_000),
        quietConfig,
      );

      // Preserve at least one follow-up attempt before no-reply fires.
      if (followUpDueAt && escalationDueAt <= followUpDueAt) {
        escalationDueAt = new Date(followUpDueAt.getTime() + 60_000);
      }

      await this.automationProducer.enqueueNoReplyEscalation({
        verificationId: params.verificationId,
        orgId: params.orgId,
        dueAt: escalationDueAt,
      });
    }
  }

  async finalizeVerification(verificationId: string, status: string) {
    this.logger.log(
      buildBackendLog(VerificationHubService.name, {
        action: 'verification-finalize',
        outcome: 'success',
        verificationId,
        status,
      }),
    );

    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) return;

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order || order.orgId !== verification.orgId) return;

    if (
      !isSyntheticOrder(order) &&
      (status === 'confirmed' || status === 'canceled')
    ) {
      await this.synchronizeExternalOrder(
        order,
        status,
        verification.id,
        verification.orgId,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a skip reason string if the integration is not eligible for
   * verification, or `null` if processing should continue.
   */
  private async validateIntegrationCanVerify(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<string | null> {
    const eligibility =
      this.orderEligibilityService.evaluateOrderForVerification({
        order: orderData,
        integration,
      });
    if (!eligibility.eligible) {
      const signalSuffix = eligibility.matchedSignal
        ? `, signal=${eligibility.matchedSignal}`
        : '';
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-order-eligibility-check',
          outcome: 'skipped',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          orderId: orderData.externalOrderId,
          reason: `${eligibility.reason}${signalSuffix}`,
        }),
      );
      return eligibility.reason;
    }

    if (!integration.isAutoVerifyEnabled) {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-order-eligibility-check',
          outcome: 'skipped',
          orgId: integration.orgId,
          integrationId: integration.id,
          orderId: orderData.externalOrderId,
          reason: 'auto_verify_disabled',
        }),
      );
      return 'auto_verify_disabled';
    }

    if (integration.onboardingStatus !== 'completed') {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-order-eligibility-check',
          outcome: 'skipped',
          orgId: integration.orgId,
          integrationId: integration.id,
          orderId: orderData.externalOrderId,
          reason: 'onboarding_incomplete',
          onboardingStatus: integration.onboardingStatus ?? 'unknown',
        }),
      );
      return 'onboarding_incomplete';
    }

    return (
      this.billingEntitlementService.evaluateAccess(integration, {
        id: orderData.integrationId,
        orgId: orderData.orgId,
      }).reason ?? (await this.creditEligibility.resolveDenial(integration))
    );
  }

  private async validateSyntheticTestSource(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<string | null> {
    if (
      orderData.orgId !== integration.orgId ||
      orderData.integrationId !== integration.id
    ) {
      return 'source_identity_mismatch';
    }
    if (!integration.isActive) return 'integration_inactive';
    if (integration.onboardingStatus !== 'completed') {
      return 'onboarding_incomplete';
    }
    return (
      this.billingEntitlementService.evaluateAccess(integration, {
        id: orderData.integrationId,
        orgId: orderData.orgId,
      }).reason ?? (await this.creditEligibility.resolveDenial(integration))
    );
  }

  private async findOrCreateOrder(orderData: NormalizedOrder) {
    const existing = await this.ordersRepo.findBySourceExternalId({
      orgId: orderData.orgId,
      integrationId: orderData.integrationId,
      externalOrderId: orderData.externalOrderId,
    });
    if (existing) return existing;

    return this.ordersRepo.create(this.toOrderInsertPayload(orderData));
  }

  private async prepareVerification(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<SkippedResult | PreparedVerification> {
    const order = await this.findOrCreateOrder(orderData);
    const existingVerification = await this.verificationsRepo.findByOrderId(
      order.id,
    );
    if (existingVerification) {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-create-for-order',
          outcome: 'skipped',
          orgId: integration.orgId,
          integrationId: integration.id,
          orderId: order.id,
          verificationId: existingVerification.id,
          reason: 'verification_already_exists',
        }),
      );
      return {
        order,
        verification: existingVerification,
        existing: true,
      };
    }

    const slotCheck =
      await this.billingEntitlementService.hasAvailableSlot(integration);
    if (!slotCheck.available) {
      this.logger.warn(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-create-for-order',
          outcome: 'skipped',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          orderId: order.id,
          consumedCount: slotCheck.consumedCount,
          includedLimit: slotCheck.includedLimit,
          reason: slotCheck.reason ?? 'plan_limit_reached',
        }),
      );
      return {
        skipped: true,
        reason: slotCheck.reason ?? 'plan_limit_reached',
        orderId: order.id,
      };
    }

    const created = await this.verificationsRepo.createForOrderIfAbsent({
      orgId: order.orgId,
      orderId: order.id,
      status: 'pending',
    });
    return {
      order,
      verification: created.verification,
      existing: !created.created,
    };
  }

  /**
   * Routes to the delayed or immediate send path based on integration config.
   */
  private async dispatchInitialSend(
    verification: { id: string },
    order: { id: string; orgId: string },
    integration: IntegrationRecord,
  ): Promise<void> {
    const sendDelayMinutes = Math.max(0, integration.sendDelayMinutes ?? 0);
    const quietConfig = {
      enabled: integration.quietHoursEnabled,
      start: integration.quietHoursStart,
      end: integration.quietHoursEnd,
      timezone: integration.timezone,
    };
    const desiredDueAt = new Date(Date.now() + sendDelayMinutes * 60_000);
    const adjustedDueAt = adjustForQuietHours(desiredDueAt, quietConfig);

    if (
      sendDelayMinutes > 0 ||
      adjustedDueAt.getTime() > desiredDueAt.getTime()
    ) {
      await this.automationProducer.enqueueInitialSend({
        verificationId: verification.id,
        orgId: order.orgId,
        dueAt: adjustedDueAt,
      });

      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-initial-send-schedule',
          outcome: 'success',
          orgId: order.orgId,
          verificationId: verification.id,
          dueAt: adjustedDueAt.toISOString(),
        }),
      );
      return;
    }

    const sendOutcome = await this.verificationSendService.sendInitial(
      verification.id,
    );

    if (sendOutcome.status === 'sent') {
      await this.scheduleFollowUpAndEscalation({
        verificationId: verification.id,
        orgId: order.orgId,
        integration,
        baselineSentAt: sendOutcome.sentAt
          ? new Date(sendOutcome.sentAt)
          : new Date(),
      });
      return;
    }

    if (sendOutcome.status === 'sent_untracked') {
      // The message reached the customer, but nothing in the database records
      // it -- so there is no row to schedule follow-up or escalation against,
      // and no failure to project either. The send path has already logged the
      // orphan with everything needed to investigate it.
      return;
    }

    await this.applyInitialSendFailure(
      verification.id,
      order.orgId,
      sendOutcome,
    );
  }

  /**
   * Projects a non-delivering initial send outcome onto the verification.
   *
   * Shared by the immediate send path, the synthetic test path and the
   * automation processor so the outcome-to-status mapping exists once. Outcomes
   * that are neither a plan-limit rejection nor a recognised send failure leave
   * the verification untouched for a later retry.
   */
  async applyInitialSendFailure(
    verificationId: string,
    orgId: string,
    outcome: { status: string; reason?: string },
  ): Promise<void> {
    let reason: string | undefined;
    if (outcome.status === 'plan_limit_reached') {
      // Always the canonical constant: the retry taxonomy
      // (reopenRetryableInitialFailure, the dashboard lifecycle projection)
      // matches this reason by exact string, so a decorated variant such as
      // `plan_limit:1000/1000` would silently make the order unretryable.
      reason = 'plan_limit_reached';
    } else if (
      outcome.status === 'skipped' &&
      isSendFailureReason(outcome.reason)
    ) {
      reason = outcome.reason;
    }
    if (!reason) {
      // `outcome_unknown` and transient skips (`dispatch_in_progress`) land
      // here. Leaving the verification untouched is correct — the send path
      // owns those projections — but returning silently made a stranded row
      // look like a clean success in the logs, which is how these went
      // unnoticed at `pending`.
      this.logger.warn(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-initial-send-unhandled',
          outcome: 'skipped',
          orgId,
          verificationId,
          status: outcome.status,
          reason: outcome.reason ?? 'unspecified',
        }),
      );
      return;
    }

    await this.verificationsRepo.updateByIdForOrg(verificationId, orgId, {
      status: 'failed',
      metadata: { reason, kind: 'initial' },
    });
  }

  private async synchronizeExternalOrder(
    order: NonNullable<Awaited<ReturnType<OrdersRepository['findById']>>>,
    status: 'confirmed' | 'canceled',
    verificationId: string,
    orgId: string,
  ): Promise<void> {
    if (!order.integrationId) {
      this.logger.warn(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-outcome-dispatch',
          outcome: 'skipped',
          orgId,
          verificationId,
          reason: 'missing_linked_integration',
        }),
      );
      return;
    }
    try {
      await this.commerceOutcomes.dispatch({
        orgId,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        action:
          status === 'confirmed'
            ? 'customer_confirmation'
            : 'customer_cancellation',
        correlationId: verificationId,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-outcome-dispatch',
          outcome: 'failure',
          orgId,
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  private toOrderInsertPayload(
    orderData: NormalizedOrder,
  ): typeof orders.$inferInsert {
    return {
      orgId: orderData.orgId,
      integrationId: orderData.integrationId,
      externalOrderId: orderData.externalOrderId,
      orderNumber: orderData.orderNumber,
      customerPhone: orderData.customerPhone,
      customerName: orderData.customerName,
      totalPrice: orderData.totalPrice,
      currency: orderData.currency,
      paymentMethod: orderData.paymentMethod,
      rawPayload: orderData.rawPayload,
      isTest: isSyntheticTestOrderId(orderData.externalOrderId),
    };
  }
}
