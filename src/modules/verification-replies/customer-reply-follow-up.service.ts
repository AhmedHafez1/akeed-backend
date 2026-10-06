import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationServiceMessagesRepository } from '../../infrastructure/database/repositories/verification-service-messages.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
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
  | 'already_handled';

export type CustomerReplyFollowUpOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'skipped' | 'failed'; reason: ServiceMessageSkipReason }
  | { outcome: 'ineligible'; reason: IneligibleReason };

const TEXT_PURPOSES: Record<'confirmed' | 'canceled', MessageTextPurpose> = {
  confirmed: 'ack_confirmed',
  canceled: 'ack_canceled',
};

/** `ar.egyptian_v2` reads as `egyptian`: texts are written per dialect. */
function baseStyleOf(variantKey: string | null | undefined): string | null {
  const style = variantKey?.split('.')[1];
  return style ? style.replace(/_v\d+$/, '') : null;
}

/**
 * The acknowledgment after a customer confirms or cancels, and the nudge
 * after a typed reply Akeed could not read (US-08-07 b, c).
 *
 * Built under the contract record's worst-case rule for 4.10.8: best
 * effort, sent once and never retried, and the verification's outcome is
 * final before anything is attempted and never depends on it. The row is
 * claimed before the send, so a replay or a crash never sends twice. These
 * messages are free at the provider (record 4.10.5): no usage, dispatch or
 * credit row is written.
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
    const style = baseStyleOf(sent?.variantKey);

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
      return this.notSent(claim.id, 'failed', 'provider_error', identity);
    }

    switch (result.outcome) {
      case 'accepted':
        await this.serviceMessages.markSent({
          id: claim.id,
          providerMessageId: result.providerMessageId,
          sentAt: new Date().toISOString(),
          text: identity,
        });
        return {
          outcome: 'sent',
          providerMessageId: result.providerMessageId,
        };
      case 'window_closed':
        return this.notSent(claim.id, 'skipped', 'window_closed', identity);
      case 'rejected':
        return this.notSent(claim.id, 'failed', 'provider_rejected', identity);
      default:
        return this.notSent(claim.id, 'failed', 'provider_error', identity);
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
