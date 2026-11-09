import {
  SENDER_RESOLVER_PORT,
  FEATURE_OFF_SENDER,
  type SenderResolverPort,
} from '../../shared/ports/sender-resolver.port';
import { ChangeRequestTemplatesService } from '../change-requests/change-request-templates.service';
import { customerRecipientHash } from '../../shared/messaging/change-request-messaging';
import type { CreditDenialCode } from '../../shared/billing/credit-eligibility';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import { hasCrossedCreditsWarning } from '../../shared/analytics/product-events';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  MESSAGING_PORT,
  ConfirmedMessageRejection,
  type MessagingPort,
} from '../../shared/ports/messaging.port';
import { integrations } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from './billing-entitlement.service';
import { UsageAlertService } from './usage-alert.service';
import { CreditEligibilityService } from './credit-eligibility.service';
import {
  resolveTemplateSendPurpose,
  toSentTemplateIdentity,
  type SelectedCodTemplate,
  type SentTemplateIdentity,
  type TemplateSendPurpose,
} from '../../shared/messaging/cod-template-selector';
import { selectTemplateForSend } from '../../shared/messaging/template-selector';
import { applyLogoHeader } from '../../shared/messaging/logo-header.policy';
import {
  classifyDeliveryFailure,
  NO_WHATSAPP_SEND_REASON,
} from '../../shared/verification/delivery-failure.policy';
import { storeTemplateKeys } from '../../shared/messaging/store-template-selection';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import { MessageTextsService } from '../message-texts/message-texts.service';
import {
  formatOrderTotal,
  legacyOrderTotal,
} from '../../shared/messaging/message-values';
import {
  buildOrderDetailValues,
  canFillTemplate,
} from '../../shared/messaging/order-detail-values';
import type { TemplateLanguage } from '../../shared/messaging/template-registry.types';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import { withSerializableRetry } from '../../shared/database/serializable-retry';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import {
  VerificationMessageDispatchesRepository,
  type DispatchAcceptanceResult,
  type DispatchRecord,
} from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  MerchantMessageFailure,
  UNKNOWN_SENDER_OUTCOME,
} from '../../shared/ports/sender-recovery.port';
import {
  SENDER_EVENT_PORT,
  type SenderEventPort,
} from '../../shared/ports/sender-recovery.port';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';

export type SendKind = 'initial' | 'follow_up';

export interface SendOutcome {
  status:
    | 'sent'
    | 'sent_untracked'
    | 'failed'
    | 'plan_limit_reached'
    | 'skipped'
    | 'outcome_unknown'
    | 'recovery_pending';
  reason?: string;
  waMessageId?: string;
  sentAt?: string;
  recoveryKind?: SendKind;
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
  generation: number;
  confirmationCycle: number;
  waMessageId: string;
  variantKey: string;
  templateName: string;
  languageCode: string;
  resolvedLanguage: string;
  purpose: TemplateSendPurpose;
}

const ACCEPTANCE_FAILURE_CODES: Record<
  Exclude<DispatchAcceptanceResult['outcome'], 'accepted'>,
  string
> = {
  not_found: 'dispatch_row_missing',
  verification_missing: 'verification_row_missing',
  unacceptable_state: 'dispatch_not_acceptable',
};

export interface InitialSendOptions {
  /** Free onboarding test: honoured only for synthetic test orders. */
  billingExempt?: boolean;
  /**
   * The language a test message goes out in, whatever the store's language
   * setting and the recipient's number say. Honoured only for synthetic test
   * orders.
   */
  testLanguage?: TemplateLanguage;
  /**
   * An updated confirmation names the cycle it will start. It is a new
   * message of that cycle, charged and sent like any confirmation; its
   * acceptance starts the cycle, and until then nothing about it is written
   * onto the verification.
   */
  confirmationCycle?: number;
}

interface ResolvedContext {
  billingExempt: boolean;
  testLanguage?: TemplateLanguage;
  confirmationCycle?: number;
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
        | CreditDenialCode;
    };

/**
 * Shared service that performs the actual WhatsApp template send
 * (initial or follow-up) for an existing verification record.
 *
 * Responsibilities:
 *  - Reload the verification, order and integration with current state.
 *  - Select the template from the registry, then claim one logical dispatch
 *    with that identity and reserve usage transactionally.
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
    private readonly creditEligibility: CreditEligibilityService,
    private readonly messageDispatches: VerificationMessageDispatchesRepository,
    @Inject(MESSAGING_PORT) private readonly messagingPort: MessagingPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly templateRegistry: TemplateRegistryPort,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
    @Optional()
    private readonly improvementSwitches?: MessageImprovementSwitches,
    @Optional()
    private readonly messageTexts?: MessageTextsService,
    @Optional()
    private readonly usageAlerts?: UsageAlertService,
    @Inject(SENDER_RESOLVER_PORT)
    private readonly senderResolver: SenderResolverPort = {
      resolve: () => Promise.resolve(FEATURE_OFF_SENDER),
    },
    @Optional() private readonly automation?: VerificationAutomationProducer,
    @Optional()
    @Inject(SENDER_EVENT_PORT)
    private readonly senderEvents?: SenderEventPort,
    @Optional()
    private readonly changeTemplates?: ChangeRequestTemplatesService,
  ) {}

  private switches() {
    return (
      this.improvementSwitches?.current() ?? MESSAGE_IMPROVEMENT_SWITCHES_OFF
    );
  }

  async sendInitial(
    verificationId: string,
    options: InitialSendOptions = {},
  ): Promise<SendOutcome> {
    const result = await this.loadContext(
      verificationId,
      options.billingExempt === true,
    );
    if (!result.context) {
      return { status: 'skipped', reason: result.reason };
    }
    const { context } = result;
    return this.sendOnce(
      {
        ...context,
        ...(options.testLanguage && context.order.isTest === true
          ? { testLanguage: options.testLanguage }
          : {}),
        ...(options.confirmationCycle !== undefined
          ? { confirmationCycle: options.confirmationCycle }
          : {}),
      },
      'initial',
    );
  }

  async sendFollowUp(verificationId: string): Promise<SendOutcome> {
    const result = await this.loadContext(verificationId);
    if (!result.context) {
      return { status: 'skipped', reason: result.reason };
    }
    return this.sendOnce(result.context, 'follow_up');
  }

  /**
   * Funnel bookkeeping only; the message has already been claimed and must
   * still go out if this write fails.
   */
  private async recordCreditsWarning(
    integrationId: string,
    usage: { consumedAfter: number; includedLimit: number },
  ): Promise<void> {
    try {
      await this.adminLifecycles?.markMilestone(
        integrationId,
        'credits80At',
        undefined,
        { credits_80: 'captured_exact' },
      );
      await this.adminLifecycles?.recordEvent(integrationId, 'credits_80', {
        consumed: usage.consumedAfter,
        limit: usage.includedLimit,
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.creditsWarning',
          outcome: 'failure',
          integrationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  private async loadContext(
    verificationId: string,
    requestBillingExempt = false,
    retainedCharge = false,
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

    const billingExempt = requestBillingExempt && order.isTest === true;
    if (billingExempt) {
      if (!integration.isActive) {
        return { context: null, reason: 'integration_inactive' };
      }
      return {
        context: { verification, order, integration, billingExempt },
      };
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

    const creditDenial = retainedCharge
      ? null
      : await this.creditEligibility.resolveDenial(integration);
    if (creditDenial) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'loadContext.creditEligibility',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId,
          reason: creditDenial,
        }),
      );
      return { context: null, reason: creditDenial };
    }

    return {
      context: { verification, order, integration, billingExempt: false },
    };
  }

  async enqueueRecovery(orgId: string, dispatchId: string): Promise<void> {
    const dispatch = await this.messageDispatches.findSenderRecovery(
      orgId,
      dispatchId,
    );
    if (
      !dispatch ||
      !dispatch.senderRecoveryDueAt ||
      (!['retry', 'fallback'].includes(dispatch.senderRecoveryState ?? '') &&
        !dispatch.senderAutomationPending)
    )
      return;
    try {
      const event = await this.messageDispatches.senderFailureEvent(
        orgId,
        dispatchId,
      );
      if (event) await this.senderEvents?.emit(event);
      await this.automation?.cancelPendingReminders({
        orgId,
        verificationId: dispatch.verificationId,
      });
      await this.automation?.enqueueSenderRecovery({
        orgId,
        dispatchId,
        verificationId: dispatch.verificationId,
        action: dispatch.senderRecoveryState === 'retry' ? 'retry' : 'fallback',
        dueAt: dispatch.senderRecoveryDueAt,
        version: dispatch.senderRecoveryVersion,
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(VerificationSendService.name, {
          action: 'sender-recovery-enqueue',
          outcome: 'retry',
          orgId,
          dispatchId,
          ...normalizeError(error),
        }),
      );
    }
  }

  async hasSenderRecovery(verificationId: string, orgId: string) {
    return this.messageDispatches.hasSenderRecovery(verificationId, orgId);
  }

  async acknowledgeRecoveryAutomation(orgId: string, dispatchId: string) {
    await this.messageDispatches.acknowledgeRecoveryAutomation(
      orgId,
      dispatchId,
    );
  }

  async sweepSenderRecovery(): Promise<void> {
    for (const work of await this.messageDispatches.dueSenderRecovery())
      await this.enqueueRecovery(work.orgId, work.dispatchId);
  }

  async resumeSenderRecovery(
    orgId: string,
    dispatchId: string,
  ): Promise<SendOutcome> {
    const dispatch = await this.messageDispatches.findSenderRecovery(
      orgId,
      dispatchId,
    );
    if (
      !dispatch ||
      (!['retry', 'fallback'].includes(dispatch.senderRecoveryState ?? '') &&
        !dispatch.senderAutomationPending)
    )
      return { status: 'skipped', reason: 'recovery_finished' };
    const loaded = await this.loadContext(
      dispatch.verificationId,
      (dispatch.metadata as { billingExempt?: boolean })?.billingExempt ===
        true,
      true,
    );
    if (
      !loaded.context ||
      loaded.context.verification.orgId !== orgId ||
      [
        'confirmed',
        'canceled',
        'expired',
        'no_reply',
        'no_whatsapp',
        'blocked',
      ].includes(loaded.context.verification.status)
    ) {
      await this.messageDispatches.finishSenderRecovery(
        orgId,
        dispatchId,
        true,
      );
      await this.acknowledgeRecoveryAutomation(orgId, dispatchId);
      return { status: 'skipped', reason: 'verification_closed' };
    }
    if (
      dispatch.senderRecoveryState === 'complete' &&
      dispatch.senderAutomationPending
    ) {
      const accepted = await this.messageDispatches.recoveryAcceptance(
        orgId,
        dispatchId,
      );
      if (!accepted?.providerMessageId)
        await this.acknowledgeRecoveryAutomation(orgId, dispatchId);
      return accepted?.providerMessageId
        ? {
            status: 'sent',
            waMessageId: accepted.providerMessageId,
            sentAt: accepted.acceptedAt ?? undefined,
            recoveryKind: dispatch.kind as SendKind,
          }
        : { status: 'skipped', reason: 'recovery_finished' };
    }
    const result = await this.sendOnce(
      loaded.context,
      dispatch.kind as SendKind,
      {
        ...(dispatch.senderRecoveryState === 'retry'
          ? {
              retryDispatch: dispatch,
              template: dispatch.senderRecoveryTemplate ?? undefined,
            }
          : { fallbackFrom: dispatch }),
      },
    );
    if (
      dispatch.senderRecoveryState === 'fallback' &&
      !['recovery_pending'].includes(result.status) &&
      !(result.status === 'skipped' && result.reason === 'dispatch_in_progress')
    )
      await this.messageDispatches.finishSenderRecovery(
        orgId,
        dispatchId,
        false,
        result.status === 'sent',
      );
    return { ...result, recoveryKind: dispatch.kind as SendKind };
  }

  private async sendOnce(
    ctx: ResolvedContext,
    kind: SendKind,
    recovery: {
      retryDispatch?: DispatchRecord;
      fallbackFrom?: DispatchRecord;
      template?: SelectedCodTemplate;
    } = {},
  ): Promise<SendOutcome> {
    const { verification, order, integration } = ctx;
    const switches = this.switches();
    // Selected before the claim, so the ledger row and the message are built
    // from the same values and a send whose outcome is never learned still
    // says which template it carried.
    const selection = recovery.template
      ? {
          template: recovery.template,
          language: recovery.template.language,
          storedKey: null,
          fallbackReason: null,
        }
      : selectTemplateForSend(await this.templateRegistry.listTemplates(), {
          preferredLanguage: ctx.testLanguage ?? integration.defaultLanguage,
          phoneNumber: order.customerPhone,
          ...storeTemplateKeys(integration),
          guardrail: {
            enabled: this.templateRegistry.sendGuardrailEnabled?.() === true,
          },
          kind,
          arAuto: integration.codTemplateArAuto,
          switches,
          // A template that shows items or an address is sent only to an order
          // that has them; any other order gets the language default.
          canFill: (variables) => canFillTemplate(variables, order),
        });
    if (!selection.template) {
      // No default to fall back to: skipped before the claim, so no usage is
      // reserved and no other template is guessed.
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.templateSelection',
          outcome: 'skipped',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId: verification.id,
          kind,
          resolvedLanguage: selection.language,
          storedTemplateKey: selection.storedKey,
          reason: 'template_unavailable',
        }),
      );
      return { status: 'skipped', reason: 'template_unavailable' };
    }
    // A store with the logo header on sends the image twin of the same
    // template when one exists; the text template stays the recorded identity.
    let template = selection.template;
    const sender = recovery.fallbackFrom
      ? {
          ...FEATURE_OFF_SENDER,
          reason:
            recovery.fallbackFrom.lastErrorCode === 'outcome_unknown'
              ? 'outcome_unknown'
              : `send_failed:${recovery.fallbackFrom.lastErrorCode ?? 'unknown'}`,
        }
      : recovery.retryDispatch
        ? {
            kind: 'merchant_own' as const,
            connectionId: recovery.retryDispatch.senderConnectionId,
            reason: recovery.retryDispatch.senderReason ?? 'own_number',
            units: 1 as const,
          }
        : await this.senderResolver.resolve({
            orgId: order.orgId,
            template,
          });
    if (
      integration.changeRequestsEnabled &&
      !recovery.retryDispatch &&
      this.changeTemplates &&
      (!selection.fallbackReason || selection.fallbackReason === 'key_missing')
    ) {
      const variant = await this.changeTemplates.selectVariant(
        selection.template,
        integration,
        sender,
      );
      template = variant.template;
      if (!variant.ready)
        this.logger.warn(
          buildBackendLog('VerificationSendService', {
            action: 'sendOnce.changeRequestFallback',
            outcome: 'skipped',
            orgId: order.orgId,
            integrationId: integration.id,
            verificationId: verification.id,
            reason: variant.reason,
          }),
        );
      if (variant.sendable === false)
        return { status: 'skipped', reason: 'template_unavailable' };
    } else if (sender.kind === 'akeed_system') {
      template = await this.withLogoHeader(template, integration);
    }
    // A store with no stored choice is the normal state of a new source, so
    // that is the one fallback neither logged nor recorded on the dispatch.
    const recordedFallback =
      selection.fallbackReason && selection.fallbackReason !== 'key_missing'
        ? {
            fallbackReason: selection.fallbackReason,
            skippedKey: selection.storedKey,
          }
        : {};
    if (
      selection.fallbackReason &&
      selection.fallbackReason !== 'key_missing'
    ) {
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.templateFallback',
          outcome: 'success',
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId: verification.id,
          kind,
          storedTemplateKey: selection.storedKey,
          variantKey: template.variantKey,
          resolvedLanguage: template.language,
          reason: selection.fallbackReason,
        }),
      );
    }
    const purpose = resolveTemplateSendPurpose({
      kind,
      isTestOrder: order.isTest === true,
    });
    const dispatchClaim = recovery.retryDispatch
      ? {
          outcome: 'claimed' as const,
          dispatch: recovery.retryDispatch,
          usage: undefined,
        }
      : await this.messageDispatches.claim({
          orgId: order.orgId,
          integrationId: integration.id,
          verificationId: verification.id,
          kind,
          changeRequestButtons: Boolean(template.changeRequestOfKey),
          recipientHash: customerRecipientHash(order.customerPhone),
          templateName:
            template.imageHeader?.templateName ?? template.templateName,
          languageCode:
            template.imageHeader?.languageCode ?? template.languageCode,
          identity: {
            variantKey: template.variantKey,
            purpose,
            language: template.language,
            ...recordedFallback,
          },
          leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
          billingExempt: ctx.billingExempt,
          ...(ctx.confirmationCycle !== undefined
            ? { confirmationCycle: ctx.confirmationCycle }
            : {}),
          sender,
          ...(recovery.fallbackFrom
            ? {
                fallbackForDispatchId: recovery.fallbackFrom.id,
                chargeRule: 'fallback' as const,
              }
            : {}),
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
            generation: dispatchClaim.dispatch.generation,
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
    if (
      dispatchClaim.outcome === 'claimed' &&
      dispatchClaim.usage &&
      hasCrossedCreditsWarning(dispatchClaim.usage)
    ) {
      await this.recordCreditsWarning(integration.id, dispatchClaim.usage);
    }
    if (dispatchClaim.outcome === 'claimed' && !ctx.billingExempt) {
      // The claim has just taken usage or a credit hold. Checked in the
      // background: the alert may email, and the customer's message must not
      // wait for it. It never throws.
      void this.usageAlerts?.evaluateOrg(order.orgId);
    }
    if (dispatchClaim.outcome === 'busy') {
      return { status: 'skipped', reason: 'dispatch_in_progress' };
    }
    if (dispatchClaim.outcome === 'outcome_unknown') {
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
    }

    // Reclaims retain the sender the first attempt recorded, even when the
    // resolver now chooses differently. A new message gets a fresh decision.
    const claimedSender = dispatchClaim.dispatch.senderKind
      ? {
          kind: dispatchClaim.dispatch.senderKind,
          connectionId: dispatchClaim.dispatch.senderConnectionId ?? null,
          reason: dispatchClaim.dispatch.senderReason ?? 'feature_off',
          units: 1 as const,
        }
      : sender;
    if (claimedSender.kind === 'merchant_own') {
      template = { ...template, imageHeader: undefined };
    }
    const merchantAttempt =
      claimedSender.kind === 'merchant_own'
        ? await this.messageDispatches.beginMerchantAttempt(
            order.orgId,
            dispatchClaim.dispatch.id,
            template,
            !!recovery.retryDispatch,
          )
        : null;
    if (claimedSender.kind === 'merchant_own' && !merchantAttempt)
      return { status: 'skipped', reason: 'dispatch_in_progress' };
    let response: Awaited<
      ReturnType<MessagingPort['sendVerificationTemplate']>
    > | null = null;
    const detailValues = buildOrderDetailValues(
      order,
      template.variables,
      template.language,
    );

    try {
      response = await this.messagingPort.sendVerificationTemplate({
        beforeTemplateAttempt:
          claimedSender.kind === 'akeed_system'
            ? async (identity) => {
                await this.messageDispatches.recordTemplateAttempt(
                  order.orgId,
                  dispatchClaim.dispatch.id,
                  dispatchClaim.dispatch.generation,
                  identity,
                );
              }
            : undefined,
        to: order.customerPhone,
        customerName: order.customerName,
        storeName: integration.storeName,
        // The merchant-facing reference, not the source's internal identifier.
        // `externalOrderId` is a dedupe key -- a Shopify order id, or the
        // `manual-<hash>` synthesised from an idempotency key -- so sending it
        // showed customers an opaque string instead of the order they placed.
        // It stays as the fallback for rows whose number was never captured.
        orderNumber: order.orderNumber?.trim() || order.externalOrderId,
        totalPrice: switches.amountFormatting
          ? formatOrderTotal(
              order.totalPrice,
              order.currency,
              template.language,
            )
          : legacyOrderTotal(order.totalPrice, order.currency),
        verificationId: verification.id,
        confirmationCycle: dispatchClaim.dispatch.confirmationCycle,
        template,
        sender: claimedSender,
        dispatchContext: {
          orgId: order.orgId,
          dispatchId: dispatchClaim.dispatch.id,
          ...(merchantAttempt ? { merchantAttempt } : {}),
        },
        ...(Object.keys(detailValues).length ? { detailValues } : {}),
        ...(switches.localizedFallbacks
          ? await this.localizedFallbacks({
              language: template.language,
              customerName: order.customerName,
              storeName: integration.storeName,
              verificationId: verification.id,
            })
          : {}),
      });
    } catch (error) {
      if (claimedSender.kind === 'merchant_own') {
        const failure =
          error instanceof MerchantMessageFailure
            ? error.failure
            : UNKNOWN_SENDER_OUTCOME;
        await this.messageDispatches.failMerchantAttempt(
          order.orgId,
          dispatchClaim.dispatch.id,
          merchantAttempt,
          failure,
        );
        await this.enqueueRecovery(order.orgId, dispatchClaim.dispatch.id);
        if (failure.action === 'fail')
          return {
            status: 'failed',
            reason:
              failure.code === '131026'
                ? NO_WHATSAPP_SEND_REASON
                : 'provider_not_accepted',
          };
        if (
          failure.action === 'fallback' ||
          dispatchClaim.dispatch.senderRetryCount >= 2
        )
          return this.resumeSenderRecovery(
            order.orgId,
            dispatchClaim.dispatch.id,
          );
        return { status: 'recovery_pending' };
      }
      const errInfo = normalizeError(error);
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.whatsappSend',
          outcome: 'failure',
          verificationId: verification.id,
          kind,
          ...this.templateLogFields(template, purpose),
          ...errInfo,
        }),
      );
      // The number cannot receive WhatsApp: a refusal the provider confirmed,
      // whatever the accounting mode, so no usage is counted for it.
      if (
        error instanceof ConfirmedMessageRejection &&
        classifyDeliveryFailure(error.providerErrorCode) === 'no_whatsapp'
      ) {
        await this.messageDispatches.resolveNotAccepted(
          dispatchClaim.dispatch.id,
          undefined,
          true,
          error.providerErrorCode,
        );
        return { status: 'failed', reason: NO_WHATSAPP_SEND_REASON };
      }
      if (
        error instanceof ConfirmedMessageRejection &&
        dispatchClaim.dispatch.accountingMode === 'prepaid_credit'
      ) {
        await this.messageDispatches.resolveNotAccepted(
          dispatchClaim.dispatch.id,
          undefined,
          true,
        );
        return { status: 'failed', reason: 'provider_not_accepted' };
      }
      await this.markProviderOutcomeUnknown(
        dispatchClaim.dispatch.id,
        verification.id,
        'provider_exception',
      );
      return { status: 'outcome_unknown', reason: 'provider_outcome_unknown' };
    }

    const waMessageId = response?.messages?.[0]?.id;
    if (!waMessageId) {
      if (merchantAttempt) {
        await this.messageDispatches.failMerchantAttempt(
          order.orgId,
          dispatchClaim.dispatch.id,
          merchantAttempt,
          UNKNOWN_SENDER_OUTCOME,
        );
        return this.resumeSenderRecovery(
          order.orgId,
          dispatchClaim.dispatch.id,
        );
      }
      this.logger.error(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.missingWamid',
          outcome: 'failure',
          verificationId: verification.id,
          kind,
          ...this.templateLogFields(template, purpose),
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
    // What the adapter says it sent is the record; an adapter that does not
    // report it leaves the identity the claim already wrote.
    const reportedTemplate = response?.template;

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
      dispatchKey: dispatchClaim.dispatch.dispatchKey,
      generation: dispatchClaim.dispatch.generation,
      confirmationCycle: dispatchClaim.dispatch.confirmationCycle,
      waMessageId,
      ...this.templateLogFields(reportedTemplate ?? template, purpose),
    };
    // The salvage path has no ledger row to read the identity back from.
    const salvageTemplate = toSentTemplateIdentity(
      reportedTemplate ?? template,
    );

    if (merchantAttempt) {
      try {
        const accepted = await this.messageDispatches.acceptMerchantAttempt(
          order.orgId,
          dispatchClaim.dispatch.id,
          merchantAttempt,
          waMessageId,
          sentAt,
        );
        if (!accepted) {
          await this.enqueueRecovery(order.orgId, dispatchClaim.dispatch.id);
          return { status: 'recovery_pending' };
        }
        void this.senderEvents?.emit({
          orgId: order.orgId,
          connectionId: claimedSender.connectionId,
          signupGeneration:
            dispatchClaim.dispatch.senderConnectionGeneration ?? undefined,
          kind: 'changed',
          dedupeKey: `accepted:${dispatchClaim.dispatch.id}`,
        });
        return { status: 'sent', waMessageId, sentAt };
      } catch (error) {
        this.logger.warn(
          buildBackendLog(VerificationSendService.name, {
            action: 'merchant-acceptance-persistence',
            outcome: 'retry',
            ...sendIdentity,
            ...normalizeError(error),
          }),
        );
        return this.salvageAcceptance(sendIdentity, sentAt, salvageTemplate);
      }
    }

    try {
      // A deadlock or serialization failure rolls the whole acceptance back,
      // so running it again repeats only bookkeeping for the wamid in hand:
      // the provider is not called again. Salvage is for what retrying
      // cannot fix.
      const accepted = await withSerializableRetry((attempt) => {
        if (attempt > 1)
          this.logger.warn(
            buildBackendLog('VerificationSendService', {
              action: 'sendOnce.persistAcceptance',
              outcome: 'retry',
              ...sendIdentity,
              attempt,
            }),
          );
        return this.messageDispatches.markAccepted({
          dispatchId: dispatchClaim.dispatch.id,
          providerMessageId: waMessageId,
          sentAt,
          verificationId: verification.id,
          kind,
          generation: dispatchClaim.dispatch.generation,
          sentTemplate: reportedTemplate,
        });
      });
      if (
        accepted.outcome === 'accepted' &&
        claimedSender.reason !== 'feature_off' &&
        claimedSender.reason !== 'no_connection'
      ) {
        void this.senderEvents?.emit({
          orgId: order.orgId,
          connectionId: claimedSender.connectionId,
          kind: 'changed',
          dedupeKey: `accepted:${dispatchClaim.dispatch.id}`,
        });
      }
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
        return this.salvageAcceptance(sendIdentity, sentAt, salvageTemplate);
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
      return this.salvageAcceptance(sendIdentity, sentAt, salvageTemplate);
    }

    return { status: 'sent', waMessageId, sentAt };
  }

  /**
   * The staff-managed words for a missing customer or store name, read only
   * for the name that is missing. A missing text leaves that word
   * to the adapter, as before, and says so in the log; it never stops the
   * send.
   */
  private async localizedFallbacks(params: {
    language: TemplateLanguage;
    customerName: string | null | undefined;
    storeName: string | null | undefined;
    verificationId: string;
  }): Promise<{ fallbacks?: { customer?: string; store?: string } }> {
    const missing = {
      customer: !(params.customerName ?? '').trim(),
      store: !(params.storeName ?? '').trim(),
    };
    if (!missing.customer && !missing.store) return {};
    const read = async (
      purpose: 'fallback_customer_name' | 'fallback_store_name',
    ): Promise<string | undefined> => {
      try {
        const text = await this.messageTexts?.resolve(purpose, params.language);
        if (text) return text.body.trim();
      } catch (error) {
        this.logger.warn(
          buildBackendLog('VerificationSendService', {
            action: 'sendOnce.localizedFallback',
            outcome: 'failure',
            verificationId: params.verificationId,
            purpose,
            resolvedLanguage: params.language,
            ...normalizeError(error),
          }),
        );
        return undefined;
      }
      this.logger.warn(
        buildBackendLog('VerificationSendService', {
          action: 'sendOnce.localizedFallback',
          outcome: 'skipped',
          verificationId: params.verificationId,
          purpose,
          resolvedLanguage: params.language,
          reason: 'message_text_unavailable',
        }),
      );
      return undefined;
    };
    const fallbacks = {
      ...(missing.customer
        ? { customer: await read('fallback_customer_name') }
        : {}),
      ...(missing.store ? { store: await read('fallback_store_name') } : {}),
    };
    const found = Object.fromEntries(
      Object.entries(fallbacks).filter(([, value]) => value),
    );
    return Object.keys(found).length ? { fallbacks: found } : {};
  }

  /** Which template a send carried, for logs: identifiers only, no text. */
  private async withLogoHeader(
    template: SelectedCodTemplate,
    integration: ResolvedContext['integration'],
  ): Promise<SelectedCodTemplate> {
    if (!integration.logoHeaderEnabled || !integration.logoBannerUrl) {
      return template;
    }
    return applyLogoHeader(template, {
      enabled: true,
      bannerUrl: integration.logoBannerUrl,
      twins: (await this.templateRegistry.listImageTwins?.()) ?? [],
      guardrail: {
        enabled: this.templateRegistry.sendGuardrailEnabled?.() === true,
      },
    });
  }

  private templateLogFields(
    template: SentTemplateIdentity,
    purpose: TemplateSendPurpose,
  ) {
    return {
      variantKey: template.variantKey,
      templateName: template.templateName,
      languageCode: template.languageCode,
      resolvedLanguage: template.language,
      purpose,
    };
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
    template: SentTemplateIdentity,
  ): Promise<SendOutcome> {
    // The projection goes first, as it does inside `markAccepted`: parking
    // the ledger row applies receipts that beat this send, and a failure
    // receipt applied before the projection would be overwritten by `sent`.
    let projectedRows = 0;
    try {
      projectedRows =
        await this.messageDispatches.projectAcceptanceWithoutLedger({
          verificationId: identity.verificationId,
          kind: identity.kind,
          providerMessageId: identity.waMessageId,
          sentAt,
          template,
          confirmationCycle: identity.confirmationCycle,
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

    let ledgerParked = 0;
    try {
      ledgerParked = await this.messageDispatches.markOutcomeUnknown(
        identity.dispatchId,
        'acceptance_persistence_failed',
        identity.waMessageId,
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
