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
import { CreditApprovalService } from './credit-approval.service';
import {
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
} from '../../shared/messaging/cod-template-catalog';
import {
  buildDispatchKey,
  VerificationMessageDispatchesRepository,
  type DispatchAcceptanceResult,
} from '../../infrastructure/database/repositories/verification-message-dispatches.repository';

export type SendKind = 'initial' | 'follow_up';

export interface SendOutcome {
  status:
    | 'sent'
    | 'sent_untracked'
    | 'failed'
    | 'plan_limit_reached'
    | 'skipped'
    | 'outcome_unknown';
  reason?: string;
  waMessageId?: string;
  sentAt?: string;
}

/**
 * Everything needed to find this send again once something has gone wrong with
 * it. Carried through every failure log so an occurrence stays investigable
 * after the fact, including when the row it names is no longer reachable.
 */
interface SendIdentity {
  orgId: string;
  orderId: string;
  verificationId: string;
  kind: SendKind;
  dispatchId: string;
  dispatchKey: string;
  waMessageId: string;
}

const ACCEPTANCE_FAILURE_CODES: Record<
  Exclude<DispatchAcceptanceResult['outcome'], 'accepted'>,
  string
> = {
  not_found: 'dispatch_row_missing',
  verification_missing: 'verification_row_missing',
  unacceptable_state: 'dispatch_not_acceptable',
};

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
        | 'billing_not_active'
        | 'standalone_approval_required';
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
    private readonly creditApproval: CreditApprovalService,
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

    const approvalDenial = await this.creditApproval.resolveDenial(integration);
    if (approvalDenial) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'loadContext.creditApproval',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId,
          reason: approvalDenial,
        }),
      );
      return { context: null, reason: approvalDenial };
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
            verificationId: verification.id,
            kind,
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
        // The merchant-facing reference, not the source's internal identifier.
        // `externalOrderId` is a dedupe key -- a Shopify order id, or the
        // `manual-<hash>` synthesised from an idempotency key -- so sending it
        // showed customers an opaque string instead of the order they placed.
        // It stays as the fallback for rows whose number was never captured.
        orderNumber: order.orderNumber?.trim() || order.externalOrderId,
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
        'missing_provider_message_id',
      );
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
    }

    const sentAt = new Date().toISOString();

    // Past this point the provider has given us a message id, so the message
    // was sent. Everything below is bookkeeping: it may fail, but it must never
    // rewrite that fact into a failure — doing so is what left verifications
    // `failed`/`pending` with a NULL `wa_message_id`, breaking the delivery and
    // read webhooks (they resolve against that id) and zeroing every
    // `last_sent_at`-derived dashboard metric.

    // Identity of the send, restated for every diagnostic below. The dispatch
    // id alone was not enough to investigate a failure after the fact: without
    // the tenant, the order and the logical dispatch key there is nothing to
    // query the ledger by once the row itself is unreachable.
    const sendIdentity = {
      orgId: verification.orgId,
      orderId: order.id,
      verificationId: verification.id,
      kind,
      dispatchId: dispatchClaim.dispatch.id,
      dispatchKey: buildDispatchKey(verification.id, kind),
      waMessageId,
    };

    try {
      const accepted = await this.messageDispatches.markAccepted({
        dispatchId: dispatchClaim.dispatch.id,
        providerMessageId: waMessageId,
        sentAt,
        verificationId: verification.id,
        kind,
      });
      if (accepted.outcome !== 'accepted') {
        this.logger.error(
          buildBackendLog('VerificationSendService', {
            action: 'sendOnce.persistAcceptance',
            outcome: 'failure',
            ...sendIdentity,
            errorCode: ACCEPTANCE_FAILURE_CODES[accepted.outcome],
            acceptanceOutcome: accepted.outcome,
            ...(accepted.outcome === 'unacceptable_state'
              ? {
                  dispatchState: accepted.state,
                  attemptCount: accepted.attemptCount,
                }
              : {}),
          }),
        );
        return this.salvageAcceptance(sendIdentity, sentAt);
      }
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.persistAcceptance',
          outcome: 'failure',
          ...sendIdentity,
          ...normalizeError(error),
        }),
      );
      return this.salvageAcceptance(sendIdentity, sentAt);
    }

    return { status: 'sent', waMessageId, sentAt };
  }

  /**
   * Salvages a send whose acceptance could not be written to the dispatch
   * ledger.
   *
   * The ledger goes to `outcome_unknown` so the anomaly is visible to staff and
   * the lease-reclaim path will not re-send it, while the verification still
   * receives the acceptance the provider actually confirmed. If staff later
   * resolve the dispatch as accepted, `markAccepted`'s repair path re-runs the
   * same idempotent projection; if they reject it, that is a decision made on
   * the evidence rather than a silent guess made here.
   *
   * Both writes are row-guarded, so both can match nothing. When the salvage
   * lands on no row and the verification itself is gone, the message reached
   * the customer and nothing in the database records it. Reporting that as
   * `sent` is what kept it invisible: the caller went on to schedule follow-up
   * and escalation work against a row that no longer existed. It returns
   * `sent_untracked` instead -- still not a failure, because the customer was
   * messaged, but never something to build more automation on top of.
   */
  private async salvageAcceptance(
    identity: SendIdentity,
    sentAt: string,
  ): Promise<SendOutcome> {
    let ledgerParked = 0;
    try {
      ledgerParked = await this.messageDispatches.markOutcomeUnknown(
        identity.dispatchId,
        'acceptance_persistence_failed',
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'salvageAcceptance.markUnknown',
          outcome: 'failure',
          ...identity,
          ...normalizeError(error),
        }),
      );
    }

    let projectedRows = 0;
    try {
      projectedRows =
        await this.messageDispatches.projectAcceptanceWithoutLedger({
          verificationId: identity.verificationId,
          kind: identity.kind,
          providerMessageId: identity.waMessageId,
          sentAt,
        });
    } catch (error) {
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'salvageAcceptance.projection',
          outcome: 'failure',
          ...identity,
          ...normalizeError(error),
        }),
      );
    }

    if (ledgerParked > 0 || projectedRows > 0) {
      return { status: 'sent', waMessageId: identity.waMessageId, sentAt };
    }

    this.logger.error(
      buildBackendLog('VerificationSendService', {
        action: 'sendOnce.orphanedSend',
        outcome: 'failure',
        ...identity,
        errorCode: 'send_not_recorded',
        ledgerParked,
        projectedRows,
      }),
    );
    return {
      status: 'sent_untracked',
      reason: 'send_not_recorded',
      waMessageId: identity.waMessageId,
      sentAt,
    };
  }

  /**
   * Records a send that never produced a provider message id.
   *
   * Only for the genuinely ambiguous cases — the provider call threw, or
   * returned no `wamid`. A send that *did* get a message id is not a failure
   * and must go through {@link salvageAcceptance} instead.
   */
  private async markProviderOutcomeUnknown(
    dispatchId: string,
    verificationId: string,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.messageDispatches.markFailedProviderOutcome(
        dispatchId,
        errorCode,
      );
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
  }
}
