import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  MESSAGING_PORT,
  type MessagingPort,
} from '../../shared/ports/messaging.port';
import { integrations } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from './billing-entitlement.service';
import {
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
} from '../../shared/messaging/cod-template-catalog';
import { isBillingStatusActive } from '../../shared/utils/billing.util';

export type SendKind = 'initial' | 'follow_up';

export interface SendOutcome {
  status: 'sent' | 'failed' | 'plan_limit_reached' | 'skipped';
  reason?: string;
  waMessageId?: string;
  sentAt?: string;
}

interface ResolvedContext {
  verification: NonNullable<
    Awaited<ReturnType<VerificationsRepository['findById']>>
  >;
  order: NonNullable<Awaited<ReturnType<OrdersRepository['findById']>>>;
  integration: typeof integrations.$inferSelect;
}

type ContextLoadResult =
  | { context: ResolvedContext; reason?: never }
  | {
      context: null;
      reason:
        | 'verification_not_found'
        | 'integration_inactive'
        | 'billing_not_active';
    };

/**
 * Shared service that performs the actual WhatsApp template send
 * (initial or follow-up) for an existing verification record.
 *
 * Responsibilities:
 *  - Reload the verification, order and integration with current state.
 *  - Reserve a billing slot at the moment of sending.
 *  - Call MessagingPort.sendVerificationTemplate.
 *  - Translate the response into a verification status update
 *    (`sent` on success, `failed` on send error / missing wamid).
 *  - Release the billing reservation when sending fails.
 *
 * Higher-level scheduling, quiet-hours adjustment, and follow-up/no-reply
 * sequencing live in `VerificationHubService` and the automation processor.
 */
@Injectable()
export class VerificationSendService {
  private readonly logger = new Logger(VerificationSendService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly billingEntitlementService: BillingEntitlementService,
    @Inject(MESSAGING_PORT) private readonly messagingPort: MessagingPort,
  ) {}

  async sendInitial(verificationId: string): Promise<SendOutcome> {
    const result = await this.loadContext(verificationId);
    if (!result.context) {
      return { status: 'skipped', reason: result.reason };
    }
    return this.sendOnce(result.context, 'initial');
  }

  async sendFollowUp(verificationId: string): Promise<SendOutcome> {
    const result = await this.loadContext(verificationId);
    if (!result.context) {
      return { status: 'skipped', reason: result.reason };
    }
    return this.sendOnce(result.context, 'follow_up');
  }

  private async loadContext(
    verificationId: string,
  ): Promise<ContextLoadResult> {
    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) {
      return { context: null, reason: 'verification_not_found' };
    }

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) {
      return { context: null, reason: 'verification_not_found' };
    }

    const integration =
      (order.integration as typeof integrations.$inferSelect | null) ??
      (await this.integrationsRepo
        .findActiveByOrgAndPlatform(order.orgId, 'shopify')
        .catch((error) => {
          this.logger.error(
            buildBackendLog('VerificationSendService', {
              action: 'loadContext.lookupIntegration',
              outcome: 'failure',
              orgId: order.orgId,
              ...normalizeError(error),
            }),
          );
          return null;
        })) ??
      null;

    if (!integration) {
      return { context: null, reason: 'verification_not_found' };
    }

    if (!integration.isActive) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'loadContext.integrationEligibility',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId,
          reason: 'integration_inactive',
        }),
      );
      return { context: null, reason: 'integration_inactive' };
    }

    if (!isBillingStatusActive(integration.billingStatus)) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'loadContext.integrationEligibility',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId,
          billingStatus: integration.billingStatus ?? 'unknown',
          reason: 'billing_not_active',
        }),
      );
      return { context: null, reason: 'billing_not_active' };
    }

    return { context: { verification, order, integration } };
  }

  private async sendOnce(
    ctx: ResolvedContext,
    kind: SendKind,
  ): Promise<SendOutcome> {
    const { verification, order, integration } = ctx;
    const templateSelection = {
      ar: isArabicCodTemplateVariant(integration.codTemplateArVariant)
        ? integration.codTemplateArVariant
        : undefined,
      en: isEnglishCodTemplateVariant(integration.codTemplateEnVariant)
        ? integration.codTemplateEnVariant
        : undefined,
    };

    const reservation =
      await this.billingEntitlementService.reserveVerificationSlot(integration);
    if (!reservation.allowed) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.planLimitReached',
          outcome: 'skipped',
          integrationId: integration.id,
          verificationId: verification.id,
          kind,
          consumedCount: reservation.consumedCount,
          includedLimit: reservation.includedLimit,
        }),
      );
      return {
        status: 'plan_limit_reached',
        reason: `plan_limit:${reservation.consumedCount}/${reservation.includedLimit}`,
      };
    }

    let response: Awaited<
      ReturnType<MessagingPort['sendVerificationTemplate']>
    > | null = null;

    try {
      response = await this.messagingPort.sendVerificationTemplate({
        to: order.customerPhone,
        customerName: order.customerName,
        storeName: integration.storeName,
        orderNumber: order.externalOrderId,
        totalPrice: `${order.totalPrice} ${order.currency ?? ''}`.trim(),
        verificationId: verification.id,
        preferredLanguage: integration.defaultLanguage,
        templateSelection,
      });
    } catch (error) {
      const errInfo = normalizeError(error);
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.whatsappSend',
          outcome: 'failure',
          verificationId: verification.id,
          kind,
          ...errInfo,
        }),
      );
      await this.safeReleaseUsage({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      // Follow-up delivery failures should not invalidate the initial
      // verification request; the automation worker records metadata and leaves
      // the verification awaiting the customer's original response.
      if (kind === 'initial') {
        await this.safeMarkFailed(verification.id);
      }
      return { status: 'failed', reason: 'send_error' };
    }

    const waMessageId = response?.messages?.[0]?.id;
    if (!waMessageId) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.missingWamid',
          outcome: 'failure',
          verificationId: verification.id,
          kind,
        }),
      );
      await this.safeReleaseUsage({
        integrationId: integration.id,
        periodStart: reservation.periodStart,
      });
      // Same rationale as send exceptions: a follow-up failure should not mark
      // the whole verification failed after the initial message was sent.
      if (kind === 'initial') {
        await this.safeMarkFailed(verification.id);
      }
      return { status: 'failed', reason: 'missing_wamid' };
    }

    const sentAt = new Date().toISOString();

    if (kind === 'initial') {
      await this.verificationsRepo.updateStatus(
        verification.id,
        'sent',
        waMessageId,
      );
    }

    return { status: 'sent', waMessageId, sentAt };
  }

  private async safeReleaseUsage(params: {
    integrationId: string;
    periodStart: string;
  }): Promise<void> {
    try {
      await this.billingEntitlementService.releaseVerificationSlot(params);
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'safeReleaseUsage',
          outcome: 'failure',
          integrationId: params.integrationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  private async safeMarkFailed(verificationId: string): Promise<void> {
    try {
      await this.verificationsRepo.updateStatus(verificationId, 'failed');
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'safeMarkFailed',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }
}
