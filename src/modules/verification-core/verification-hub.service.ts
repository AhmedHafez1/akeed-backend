import { Inject, Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  ORDER_TAGGING_PORT,
  type OrderTaggingPort,
} from '../../shared/ports/order-tagging.port';
import { integrations, orders } from '../../infrastructure/database/schema';
import { OrderEligibilityService } from './order-eligibility.service';
import { VerificationSendService } from './verification-send.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { adjustForQuietHours } from '../../shared/utils/quiet-hours.util';
import { isBillingStatusActive } from '../../shared/utils/billing.util';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

type IntegrationRecord = typeof integrations.$inferSelect;

type SkippedResult = { skipped: true; reason: string };
type ProcessedResult = { orderId: string; verificationId: string };
type HandleNewOrderResult = SkippedResult | ProcessedResult;

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    @Inject(ORDER_TAGGING_PORT) private orderTaggingPort: OrderTaggingPort,
    private orderEligibilityService: OrderEligibilityService,
    private verificationSendService: VerificationSendService,
    private readonly billingEntitlementService: BillingEntitlementService,
    private readonly automationProducer: VerificationAutomationProducer,
  ) {}

  async handleNewOrder(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): Promise<HandleNewOrderResult> {
    const skipReason = this.validateIntegrationCanVerify(
      orderData,
      integration,
    );
    if (skipReason) {
      return { skipped: true, reason: skipReason };
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
      return { orderId: order.id, verificationId: existingVerification.id };
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
          reason: 'plan_limit_reached',
        }),
      );
      return { skipped: true, reason: 'plan_limit_reached' };
    }

    const verification = await this.verificationsRepo.create({
      orgId: order.orgId,
      orderId: order.id,
      status: 'pending',
    });

    await this.dispatchInitialSend(verification, order, integration);

    return { orderId: order.id, verificationId: verification.id };
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
    if (!order) return;

    if (status === 'confirmed' || status === 'canceled') {
      await this.tagExternalOrder(order, status);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a skip reason string if the integration is not eligible for
   * verification, or `null` if processing should continue.
   */
  private validateIntegrationCanVerify(
    orderData: NormalizedOrder,
    integration: IntegrationRecord,
  ): string | null {
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

    if (!integration.isActive) {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-order-eligibility-check',
          outcome: 'skipped',
          orgId: integration.orgId,
          integrationId: integration.id,
          orderId: orderData.externalOrderId,
          reason: 'integration_inactive',
        }),
      );
      return 'integration_inactive';
    }

    if (!isBillingStatusActive(integration.billingStatus)) {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-order-eligibility-check',
          outcome: 'skipped',
          orgId: integration.orgId,
          integrationId: integration.id,
          orderId: orderData.externalOrderId,
          reason: 'billing_not_active',
          billingStatus: integration.billingStatus ?? 'unknown',
        }),
      );
      return 'billing_not_active';
    }

    return null;
  }

  private async findOrCreateOrder(orderData: NormalizedOrder) {
    const existing = await this.ordersRepo.findByExternalId(
      orderData.externalOrderId,
      orderData.orgId,
    );
    if (existing) return existing;

    return this.ordersRepo.create(this.toOrderInsertPayload(orderData));
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
    } else if (sendOutcome.status === 'plan_limit_reached') {
      await this.verificationsRepo.updateByIdForOrg(
        verification.id,
        order.orgId,
        {
          status: 'failed',
          metadata: {
            reason: 'plan_limit_reached',
            kind: 'initial',
          },
        },
      );
    }
  }

  private async tagExternalOrder(
    order: Awaited<ReturnType<OrdersRepository['findById']>> &
      Record<string, unknown>,
    status: 'confirmed' | 'canceled',
  ): Promise<void> {
    if (order.externalOrderId.startsWith('akeed-test-')) {
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-shopify-tag-update',
          outcome: 'skipped',
          orgId: String(order.orgId),
          orderId: String(order.externalOrderId),
          reason: 'test_order',
        }),
      );
      return;
    }

    const tag = status === 'confirmed' ? 'Akeed: Verified' : 'Akeed: Canceled';
    const integration = order.integration as IntegrationRecord;

    if (!integration?.platformStoreUrl) {
      this.logger.warn(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-shopify-tag-update',
          outcome: 'skipped',
          orgId: String(order.orgId),
          orderId: String(order.externalOrderId),
          reason: 'missing_linked_integration',
        }),
      );
      return;
    }

    try {
      await this.orderTaggingPort.addOrderTag(
        integration,
        order.externalOrderId,
        tag,
      );
      this.logger.log(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-shopify-tag-update',
          outcome: 'success',
          orgId: String(order.orgId),
          shopDomain: integration.platformStoreUrl,
          orderId: String(order.externalOrderId),
          tag,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(VerificationHubService.name, {
          action: 'verification-shopify-tag-update',
          outcome: 'failure',
          orgId: String(order.orgId),
          shopDomain: integration.platformStoreUrl,
          orderId: String(order.externalOrderId),
          tag,
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
    };
  }
}
