import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
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
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';

export type SendKind = 'initial' | 'follow_up';

export interface SendOutcome {
  status:
    | 'sent'
    | 'failed'
    | 'plan_limit_reached'
    | 'skipped'
    | 'outcome_unknown';
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
        | 'missing_linked_integration'
        | 'source_identity_mismatch'
        | 'integration_inactive'
        | 'billing_not_active';
    };

/**
 * Shared service that performs the actual WhatsApp template send
 * (initial or follow-up) for an existing verification record.
 *
 * Responsibilities:
 *  - Reload the verification, order and integration with current state.
 *  - Claim one logical dispatch and reserve usage transactionally.
 *  - Call MessagingPort.sendVerificationTemplate.
 *  - Persist provider acceptance and verification projection atomically.
 *  - Preserve ambiguous provider outcomes for audited reconciliation.
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
    private readonly billingEntitlementService: BillingEntitlementService,
    private readonly messageDispatches: VerificationMessageDispatchesRepository,
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

    const integration = order.integration;
    if (!integration) {
      return { context: null, reason: 'missing_linked_integration' };
    }
    if (
      order.orgId !== verification.orgId ||
      order.integrationId !== integration.id ||
      integration.orgId !== verification.orgId
    ) {
      return { context: null, reason: 'source_identity_mismatch' };
    }

    const access = this.billingEntitlementService.evaluateAccess(integration);
    if (access.reason) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'loadContext.integrationEligibility',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId,
          reason: access.reason,
        }),
      );
      return { context: null, reason: access.reason };
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

    const templateName =
      kind === 'initial'
        ? (verification.templateName ?? 'cod_verification')
        : `${verification.templateName ?? 'cod_verification'}:follow_up`;
    const dispatchClaim = await this.messageDispatches.claim({
      orgId: order.orgId,
      integrationId: integration.id,
      verificationId: verification.id,
      kind,
      templateName,
      languageCode: integration.defaultLanguage ?? 'auto',
      leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (dispatchClaim.outcome === 'blocked') {
      if (dispatchClaim.reason !== 'plan_limit_reached') {
        this.logger.warn(
          buildBackendLog('VerificationSendService', {
            action: 'sendOnce.entitlementEligibility',
            outcome: 'skipped',
            orgId: order.orgId,
            integrationId: integration.id,
            verificationId: verification.id,
            kind,
            reason: dispatchClaim.reason,
          }),
        );
        return { status: 'skipped', reason: dispatchClaim.reason };
      }
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.planLimitReached',
          outcome: 'skipped',
          integrationId: integration.id,
          verificationId: verification.id,
          kind,
          consumedCount: dispatchClaim.consumedCount,
          includedLimit: dispatchClaim.includedLimit,
        }),
      );
      return {
        status: 'plan_limit_reached',
        reason: 'plan_limit_reached',
      };
    }
    if (dispatchClaim.outcome === 'accepted') {
      const providerMessageId = dispatchClaim.dispatch.providerMessageId;
      const acceptedAt = dispatchClaim.dispatch.acceptedAt;
      // The ledger already records an accepted send, so nothing new goes out.
      // Re-run the acceptance projection anyway: if the verification's own
      // status lagged behind the ledger (the historical failure mode, and what
      // made rows read `pending` after their message had been delivered and
      // read), this is the only moment that can pull it back into agreement.
      if (providerMessageId) {
        try {
          await this.messageDispatches.markAccepted({
            dispatchId: dispatchClaim.dispatch.id,
            providerMessageId,
            sentAt: acceptedAt ?? new Date().toISOString(),
          });
        } catch (error) {
          // A failed repair must not turn a successful past send into an error;
          // the row simply stays as it was and the next attempt tries again.
          this.logger.warn(
            buildBackendLog('VerificationSendService', {
              action: 'sendOnce.repairAcceptedProjection',
              outcome: 'retry',
              verificationId: verification.id,
              kind,
              ...normalizeError(error),
            }),
          );
        }
      }
      return {
        status: 'sent',
        waMessageId: providerMessageId ?? undefined,
        sentAt: acceptedAt ?? undefined,
      };
    }
    if (dispatchClaim.outcome === 'busy') {
      return { status: 'skipped', reason: 'dispatch_in_progress' };
    }
    if (dispatchClaim.outcome === 'outcome_unknown') {
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
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
      await this.markProviderOutcomeUnknown(
        dispatchClaim.dispatch.id,
        verification.id,
        verification.orgId,
        kind,
        'provider_exception',
      );
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
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
      await this.markProviderOutcomeUnknown(
        dispatchClaim.dispatch.id,
        verification.id,
        verification.orgId,
        kind,
        'missing_provider_message_id',
      );
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
    }

    const sentAt = new Date().toISOString();

    try {
      const accepted = await this.messageDispatches.markAccepted({
        dispatchId: dispatchClaim.dispatch.id,
        providerMessageId: waMessageId,
        sentAt,
      });
      // `undefined` means the ledger row was in a state the acceptance could not
      // be applied to, so the verification projection did not run either.
      // Reporting `sent` here is what previously let a real send leave the row
      // at `pending` with no `wa_message_id` — which also broke the delivery and
      // read webhooks, since they resolve against that id.
      if (!accepted) {
        this.logger.error(
          buildBackendLog('VerificationSendService', {
            action: 'sendOnce.persistAcceptance',
            outcome: 'failure',
            verificationId: verification.id,
            kind,
            errorCode: 'dispatch_not_acceptable',
          }),
        );
        await this.markProviderOutcomeUnknown(
          dispatchClaim.dispatch.id,
          verification.id,
          verification.orgId,
          kind,
          'acceptance_persistence_failed',
        );
        return {
          status: 'outcome_unknown',
          reason: 'provider_outcome_unknown',
        };
      }
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.persistAcceptance',
          outcome: 'failure',
          verificationId: verification.id,
          kind,
          ...normalizeError(error),
        }),
      );
      await this.markProviderOutcomeUnknown(
        dispatchClaim.dispatch.id,
        verification.id,
        verification.orgId,
        kind,
        'acceptance_persistence_failed',
      );
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
    }

    return { status: 'sent', waMessageId, sentAt };
  }

  private async markProviderOutcomeUnknown(
    dispatchId: string,
    verificationId: string,
    orgId: string,
    kind: SendKind,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.messageDispatches.markOutcomeUnknown(dispatchId, errorCode);
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'markProviderOutcomeUnknown',
          outcome: 'failure',
          dispatchId,
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
    try {
      await this.verificationsRepo.updateByIdForOrg(verificationId, orgId, {
        status: kind === 'initial' ? 'failed' : undefined,
        metadata:
          kind === 'initial'
            ? { reason: 'provider_outcome_unknown', kind }
            : {
                follow_up_failed: 'provider_outcome_unknown',
                follow_up_failed_at: new Date().toISOString(),
              },
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'markProviderOutcomeUnknownProjection',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }
}
