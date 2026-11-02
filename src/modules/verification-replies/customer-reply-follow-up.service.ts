import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { UsageAlertService } from '../verification-core/usage-alert.service';
import { withSerializableRetry } from '../../shared/database/serializable-retry';
import type { DispatchRecord } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationServiceMessagesRepository } from '../../infrastructure/database/repositories/verification-service-messages.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  acknowledgmentOptedIn,
  acknowledgmentStyle,
  CUSTOMER_SERVICE_WINDOW_MS,
  fillMessageText,
  type MessageTextPurpose,
  type ServiceMessageKind,
  type ServiceMessageSkipReason,
} from '../../shared/messaging/message-texts.types';
import { resolveTemplateLanguageForPhone } from '../../shared/messaging/template-language';
import type { TemplateLanguage } from '../../shared/messaging/template-registry.types';
import {
  MESSAGING_PORT,
  type MessagingPort,
} from '../../shared/ports/messaging.port';
import type { CustomerReplyIntent } from '../../shared/verification/customer-reply-intent';
import { AUTOMATION_FINAL_STATUSES } from '../../shared/verification/verification-lifecycle';
import { MessageTextsService } from '../message-texts/message-texts.service';

/** What a webhook hands over: no reply text, ever. */
export interface CustomerReplyFollowUp {
  kind: ServiceMessageKind;
  verificationId: string;
  orgId: string;
  /** The provider's time of the customer's message, ISO. */
  repliedAt: string;
  /** For an acknowledgment: what the customer answered. */
  intent?: CustomerReplyIntent;
}

/** Why no message was attempted, for logs. No row is written for these. */
type IneligibleReason =
  | 'switch_off'
  | 'verification_not_found'
  | 'test_order'
  | 'merchant_canceled'
  | 'not_customer_answer'
  | 'verification_closed'
  | 'already_handled'
  | 'merchant_disabled';

export type CustomerReplyFollowUpOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'skipped' | 'failed'; reason: ServiceMessageSkipReason }
  | { outcome: 'ineligible'; reason: IneligibleReason };

const TEXT_PURPOSES: Record<'confirmed' | 'canceled', MessageTextPurpose> = {
  confirmed: 'ack_confirmed',
  canceled: 'ack_canceled',
};

/**
 * The acknowledgment after a customer confirms or cancels, and the nudge
 * after a typed reply Akeed could not read.
 *
 * Meta does not document what a retried free-form send does, so: best
 * effort, sent once and never retried, and the verification's outcome is
 * final before anything is attempted and never depends on it. The row is
 * claimed before the send, so a replay or a crash never sends twice.
 * Acknowledgments reserve normal message capacity; nudges remain free.
 *
 * Reaches the provider only through `MessagingPort`.
 */
@Injectable()
export class CustomerReplyFollowUpService {
  private readonly logger = new Logger(CustomerReplyFollowUpService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly messageDispatches: VerificationMessageDispatchesRepository,
    private readonly serviceMessages: VerificationServiceMessagesRepository,
    private readonly messageTexts: MessageTextsService,
    @Inject(MESSAGING_PORT) private readonly messagingPort: MessagingPort,
    @Optional() private readonly switches?: MessageImprovementSwitches,
    @Optional() private readonly usageAlerts?: UsageAlertService,
  ) {}

  /** Whether this kind of message is on at all. */
  isEnabled(kind: ServiceMessageKind): boolean {
    const switches =
      this.switches?.current() ?? MESSAGE_IMPROVEMENT_SWITCHES_OFF;
    return kind === 'acknowledgment'
      ? switches.acknowledgment
      : switches.unresolvedReplyNudge;
  }

  async handle(
    request: CustomerReplyFollowUp,
  ): Promise<CustomerReplyFollowUpOutcome> {
    const result = await this.run(request);
    const logFields = {
      action: 'customer-reply-follow-up',
      kind: request.kind,
      verificationId: request.verificationId,
      orgId: request.orgId,
    };
    if (result.outcome === 'sent') {
      this.logger.log(
        buildBackendLog(CustomerReplyFollowUpService.name, {
          ...logFields,
          outcome: 'success',
          wamid: result.providerMessageId,
        }),
      );
    } else if (result.outcome === 'failed') {
      this.logger.error(
        buildBackendLog(CustomerReplyFollowUpService.name, {
          ...logFields,
          outcome: 'failure',
          reason: result.reason,
        }),
      );
    } else {
      this.logger.log(
        buildBackendLog(CustomerReplyFollowUpService.name, {
          ...logFields,
          outcome: 'skipped',
          reason: result.reason,
        }),
      );
    }
    return result;
  }

  private async run(
    request: CustomerReplyFollowUp,
  ): Promise<CustomerReplyFollowUpOutcome> {
    if (!this.isEnabled(request.kind)) return ineligible('switch_off');

    const verification = await this.verificationsRepo.findById(
      request.verificationId,
    );
    if (!verification || verification.orgId !== request.orgId) {
      return ineligible('verification_not_found');
    }
    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order || order.orgId !== verification.orgId) {
      return ineligible('verification_not_found');
    }
    if (order.isTest === true) return ineligible('test_order');
    if (
      request.kind === 'acknowledgment' &&
      !acknowledgmentOptedIn(
        order.integration?.acknowledgmentEnabled,
        order.integration?.acknowledgmentEnabledAt,
        request.repliedAt,
      )
    )
      return ineligible('merchant_disabled');
    if (verification.merchantCanceledAt) return ineligible('merchant_canceled');

    let purpose: MessageTextPurpose;
    if (request.kind === 'acknowledgment') {
      const intent = request.intent;
      const answered =
        (intent === 'confirmed' &&
          verification.status === 'confirmed' &&
          verification.confirmationSource === 'customer') ||
        (intent === 'canceled' &&
          verification.status === 'canceled' &&
          verification.cancellationSource === 'customer');
      if (!intent || !answered) return ineligible('not_customer_answer');
      purpose = TEXT_PURPOSES[intent];
    } else {
      if (AUTOMATION_FINAL_STATUSES.includes(verification.status as never)) {
        return ineligible('verification_closed');
      }
      purpose = 'unresolved_reply_nudge';
    }

    const claim = await this.serviceMessages.claim({
      orgId: verification.orgId,
      verificationId: verification.id,
      kind: request.kind,
      repliedAt: request.repliedAt,
    });
    if (!claim) return ineligible('already_handled');

    const integration = order.integration;
    const sent = await this.messageDispatches.findLatestAcceptedIdentity(
      verification.id,
    );
    const language: TemplateLanguage =
      sent?.resolvedLanguage ??
      resolveTemplateLanguageForPhone(
        integration?.defaultLanguage,
        order.customerPhone ?? '',
      );
    const style = acknowledgmentStyle(sent?.variantKey);

    const repliedAt = Date.parse(request.repliedAt);
    if (
      !Number.isFinite(repliedAt) ||
      Date.now() - repliedAt >= CUSTOMER_SERVICE_WINDOW_MS
    ) {
      return this.notSent(claim.id, 'skipped', 'outside_window', {
        purpose,
        language,
      });
    }

    const text = await this.messageTexts.resolve(purpose, language, style);
    const storeName =
      integration?.storeName?.trim() ||
      (
        await this.messageTexts.resolve('fallback_store_name', language)
      )?.body.trim();
    if (!text || !storeName || !this.messagingPort.sendFreeFormText) {
      return this.notSent(claim.id, 'skipped', 'text_unavailable', {
        purpose,
        language,
      });
    }
    const body = fillMessageText(text.body, {
      order: order.orderNumber?.trim() || order.externalOrderId,
      store: storeName,
    });
    const identity = { purpose, language, style: text.style };

    let dispatch: DispatchRecord | undefined;
    if (request.kind === 'acknowledgment') {
      if (!integration || integration.orgId !== request.orgId)
        return this.notSent(
          claim.id,
          'skipped',
          'billing_unavailable',
          identity,
        );
      const billed = await withSerializableRetry(() =>
        this.messageDispatches.claim({
          orgId: request.orgId,
          integrationId: integration.id,
          verificationId: verification.id,
          kind: 'acknowledgment',
          repliedAt: request.repliedAt,
          templateName: null,
          languageCode: language,
          leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      );
      if (billed.outcome !== 'claimed')
        return this.notSent(
          claim.id,
          'skipped',
          'billing_unavailable',
          identity,
        );
      const claimedDispatch = billed.dispatch;
      dispatch = claimedDispatch;
      try {
        await this.serviceMessages.linkDispatch(
          claim.id,
          request.orgId,
          dispatch.id,
        );
      } catch (error) {
        // No provider call has begun, so this hold can be safely released. If
        // the release fails too, the lease sweeper parks it for staff.
        await this.ledgerStep(
          'customer-reply-follow-up.release',
          request.orgId,
          verification.id,
          undefined,
          () =>
            this.messageDispatches.resolveNotAccepted(
              claimedDispatch.id,
              undefined,
              true,
            ),
        );
        throw error;
      }
    }

    let result: Awaited<
      ReturnType<NonNullable<MessagingPort['sendFreeFormText']>>
    >;
    try {
      result = await this.messagingPort.sendFreeFormText({
        to: order.customerPhone,
        body,
        verificationId: verification.id,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(CustomerReplyFollowUpService.name, {
          action: 'customer-reply-follow-up.send',
          outcome: 'failure',
          kind: request.kind,
          verificationId: verification.id,
          ...normalizeError(error),
        }),
      );
      if (dispatch) await this.parkUnclearSend(dispatch, request.orgId);
      return this.notSent(claim.id, 'failed', 'provider_error', identity);
    }

    switch (result.outcome) {
      case 'accepted':
        if (dispatch) {
          const acceptedDispatch = dispatch;
          const recorded = await this.ledgerStep(
            'customer-reply-follow-up.acceptance',
            request.orgId,
            verification.id,
            result.providerMessageId,
            async () => {
              const accepted = await this.messageDispatches.markAccepted({
                dispatchId: acceptedDispatch.id,
                verificationId: verification.id,
                kind: 'acknowledgment',
                generation: acceptedDispatch.generation,
                providerMessageId: result.providerMessageId,
                sentAt: new Date().toISOString(),
              });
              if (accepted.outcome !== 'accepted')
                throw new Error('Acknowledgment acceptance was not recorded');
            },
          );
          // The message was sent: keep its id on the dispatch so receipts and
          // staff resolution see an accepted send, never a refundable one.
          if (!recorded)
            await this.ledgerStep(
              'customer-reply-follow-up.salvage',
              request.orgId,
              verification.id,
              result.providerMessageId,
              () =>
                this.messageDispatches.markOutcomeUnknown(
                  acceptedDispatch.id,
                  'acceptance_persistence_failed',
                  result.providerMessageId,
                ),
            );
        }
        await this.serviceMessages.markSent({
          id: claim.id,
          providerMessageId: result.providerMessageId,
          sentAt: new Date().toISOString(),
          text: identity,
        });
        if (dispatch) await this.usageAlerts?.evaluateOrg(request.orgId);
        return {
          outcome: 'sent',
          providerMessageId: result.providerMessageId,
        };
      case 'window_closed':
        if (dispatch)
          await withSerializableRetry(() =>
            this.messageDispatches.resolveNotAccepted(
              dispatch.id,
              undefined,
              true,
            ),
          );
        return this.notSent(claim.id, 'skipped', 'window_closed', identity);
      case 'rejected':
        if (dispatch)
          await withSerializableRetry(() =>
            this.messageDispatches.resolveNotAccepted(
              dispatch.id,
              undefined,
              true,
            ),
          );
        return this.notSent(claim.id, 'failed', 'provider_rejected', identity);
      default:
        if (dispatch) await this.parkUnclearSend(dispatch, request.orgId);
        return this.notSent(claim.id, 'failed', 'provider_error', identity);
    }
  }

  /**
   * A send with no clear answer, as for initial sends: Shopify plan usage is
   * released while it is unresolved, and a prepaid credit stays held until
   * staff resolve it.
   */
  private async parkUnclearSend(
    dispatch: DispatchRecord,
    orgId: string,
  ): Promise<void> {
    await this.ledgerStep(
      'customer-reply-follow-up.unclear',
      orgId,
      dispatch.verificationId,
      undefined,
      () =>
        this.messageDispatches.markFailedProviderOutcome(
          dispatch.id,
          'provider_error',
        ),
    );
  }

  /**
   * One billing write after the provider call. It never throws: the send has
   * happened, and the lease sweeper parks a dispatch left `sending`.
   */
  private async ledgerStep(
    action: string,
    orgId: string,
    verificationId: string,
    wamid: string | undefined,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await withSerializableRetry(work);
      return true;
    } catch (error) {
      this.logger.error(
        buildBackendLog(CustomerReplyFollowUpService.name, {
          action,
          outcome: 'failure',
          orgId,
          verificationId,
          ...(wamid ? { wamid } : {}),
          ...normalizeError(error),
        }),
      );
      return false;
    }
  }

  private async notSent(
    id: string,
    state: 'skipped' | 'failed',
    reason: ServiceMessageSkipReason,
    text: {
      purpose: MessageTextPurpose;
      language: TemplateLanguage;
      style?: string;
    },
  ): Promise<CustomerReplyFollowUpOutcome> {
    await this.serviceMessages.markNotSent({ id, state, reason, text });
    return { outcome: state, reason };
  }
}

function ineligible(reason: IneligibleReason): CustomerReplyFollowUpOutcome {
  return { outcome: 'ineligible', reason };
}
