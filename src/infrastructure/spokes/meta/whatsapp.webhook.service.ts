import { Injectable, Logger, Optional } from '@nestjs/common';
import { VerificationsRepository } from '../../database/repositories/verifications.repository';
import { VerificationHubService } from '../../../modules/verification-core/verification-hub.service';
import { AdminStoreLifecyclesRepository } from '../../database/repositories/admin-store-lifecycles.repository';
import {
  WhatsAppMessageDto,
  WhatsAppStatusDto,
  WhatsAppWebhookPayloadDto,
} from './dto/whatsapp-webhook.dto';
import { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { VerificationMessageDispatchesRepository } from '../../database/repositories/verification-message-dispatches.repository';
import {
  CustomerReplyIntent,
  resolveButtonPayload,
  resolveReplyText,
} from '../../../shared/verification/customer-reply-intent';
import { AUTOMATION_FINAL_STATUSES } from '../../../shared/verification/verification-lifecycle';
import { MessageImprovementSwitches } from '../../../shared/config/message-improvement-switches';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../../shared/config/whatsapp-template.config';
import { VerificationServiceMessagesRepository } from '../../database/repositories/verification-service-messages.repository';
import { VerificationAutomationProducer } from '../../../modules/verification-automation/verification-automation.producer';
import { VerificationAutoCancellationsRepository } from '../../database/repositories/verification-auto-cancellations.repository';
import { VerificationSendService } from '../../../modules/verification-core/verification-send.service';
import { classifyOwnNumberFailure } from './own-number/own-number-send-failure.policy';
import { CustomerMessagesRepository } from '../../database/repositories/customer-messages.repository';
import type { MerchantReplySender } from '../../../shared/messaging/merchant-reply-sender';
import { VerificationChangeRequestsRepository } from '../../database/repositories/verification-change-requests.repository';
import { LEGACY_CONFIRMATION_CYCLE } from '../../../shared/verification/change-request.policy';

/** How a stored event is being run. */
export interface WebhookRunOptions {
  /** An earlier run of this event started and did not finish. */
  isRetry?: boolean;
  receivedAt?: string;
  receivingOrgId?: string;
  receivingSender?: MerchantReplySender;
  replyBindings?: Readonly<Record<string, string>>;
}

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private verificationsRepo: VerificationsRepository,
    private verificationHub: VerificationHubService,
    private readonly messageDispatches: VerificationMessageDispatchesRepository,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
    @Optional()
    private readonly improvementSwitches?: MessageImprovementSwitches,
    @Optional()
    private readonly serviceMessages?: VerificationServiceMessagesRepository,
    @Optional()
    private readonly automation?: VerificationAutomationProducer,
    @Optional()
    private readonly autoCancellations?: VerificationAutoCancellationsRepository,
    @Optional() private readonly senderRecovery?: VerificationSendService,
    @Optional() private readonly customerMessages?: CustomerMessagesRepository,
    @Optional()
    private readonly changeRequests?: VerificationChangeRequestsRepository,
  ) {}

  /**
   * The customer's own answer settles an open change request of the current
   * cycle, before any merchant contact. Runs after the answer was written,
   * and again on a retry of the event. Never throws: the answer is saved.
   */
  private async resolveChangeRequest(
    verificationId: string,
    intent: CustomerReplyIntent,
    message: WhatsAppMessageDto,
  ): Promise<void> {
    if (!this.changeRequests) return;
    try {
      const resolved = await this.changeRequests.resolveByCustomerAnswer({
        verificationId,
        intent,
        eventId: message.id,
        occurredAt: this.messageTime(message),
      });
      if (resolved) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-change-request-resolve',
            outcome: 'success',
            verificationId,
            resolution: resolved.request.resolution ?? 'unknown',
          }),
        );
      }
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-change-request-resolve',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  /**
   * Record a confirm or cancel against the order's automatic cancellation.
   * Returns true when that cancellation already reached the store: the order's
   * status is then left alone, and a Confirm is flagged for the merchant.
   * A message Akeed cannot read as an answer never gets here. Never throws.
   */
  private async recordCustomerAnswer(
    verificationId: string,
    intent: CustomerReplyIntent,
    message: WhatsAppMessageDto,
  ): Promise<boolean> {
    if (!this.autoCancellations) return false;
    try {
      const { committed } = await this.autoCancellations.recordCustomerAnswer({
        verificationId,
        intent,
        receivedAt: this.messageTime(message),
      });
      return committed;
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-record-customer-answer',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
      return false;
    }
  }

  private switches() {
    return (
      this.improvementSwitches?.current() ?? MESSAGE_IMPROVEMENT_SWITCHES_OFF
    );
  }

  /** The provider's time of a customer message, ISO; now when it has none. */
  private messageTime(message: WhatsAppMessageDto): string {
    const seconds = Number(message.timestamp);
    return Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toISOString()
      : new Date().toISOString();
  }

  /**
   * The verification a typed reply answers, by the message it quotes. A
   * reminder repoints `wa_message_id`, so a reply to the first message is
   * also found through the dispatch that sent it.
   */
  private async findRepliedVerification(contextWamid: string) {
    if (this.customerMessages) {
      const target = await this.customerMessages.findQuoted(contextWamid);
      return target ? this.verificationsRepo.findById(target.id) : undefined;
    }
    const direct = await this.verificationsRepo.findByWaMessageId(contextWamid);
    if (direct) return direct;
    const dispatch =
      await this.messageDispatches.findByProviderMessageId(contextWamid);
    return dispatch
      ? await this.verificationsRepo.findById(dispatch.verificationId)
      : undefined;
  }

  /**
   * A typed reply that quotes an open verification's message but
   * reads as no answer. The reply is stored without its text and one nudge
   * is queued. Without `context.id` nothing is stored or sent: matching by
   * phone could pick another store's order (decision 8). Never throws: the
   * reply was already logged as unresolved.
   */
  private async followUpUnresolvedReply(
    message: WhatsAppMessageDto,
    options: WebhookRunOptions,
  ): Promise<void> {
    const body = message.text?.body;
    const contextWamid = message.context?.id;
    if (!body || !contextWamid || !message.id) return;
    if (resolveReplyText(body)) return;
    try {
      const verification = await this.findRepliedVerification(contextWamid);
      if (
        !verification ||
        (options.receivingOrgId &&
          verification.orgId !== options.receivingOrgId) ||
        verification.merchantCanceledAt ||
        AUTOMATION_FINAL_STATUSES.includes(verification.status)
      ) {
        return;
      }
      const repliedAt = this.messageTime(message);
      await this.serviceMessages?.recordUnresolvedReply({
        orgId: verification.orgId,
        verificationId: verification.id,
        providerMessageId: message.id,
        receivedAt: repliedAt,
      });
      await this.automation?.enqueueUnresolvedReplyNudge({
        verificationId: verification.id,
        orgId: verification.orgId,
        repliedAt,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-unresolved-reply',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    }
  }

  /** Queue one acknowledgment. Never throws. */
  private async queueAcknowledgment(
    verificationId: string,
    intent: CustomerReplyIntent,
    message: WhatsAppMessageDto,
    options: WebhookRunOptions,
  ): Promise<void> {
    try {
      const verification =
        await this.verificationsRepo.findById(verificationId);
      if (
        !verification ||
        (options.receivingSender
          ? verification.orgId !== options.receivingOrgId
          : !(await this.messageDispatches.acknowledgmentEnabledForVerification(
              verificationId,
              verification.orgId,
              this.messageTime(message),
            )))
      )
        return;
      await this.automation?.enqueueAcknowledgment({
        verificationId,
        orgId: verification.orgId,
        repliedAt: this.messageTime(message),
        intent,
        ...(options.receivingSender
          ? { receivingSender: options.receivingSender }
          : {}),
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-acknowledgment-enqueue',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  async processIncoming(
    payload: WhatsAppWebhookPayloadDto,
  ): Promise<{ status: string; message?: string }> {
    try {
      await this.processIncomingOrThrow(payload);
      return { status: 'success' };
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-process',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
      // Always return 200 OK to prevent Meta from disabling the webhook
      return { status: 'error', message: 'Internal Server Error' };
    }
  }

  /** For the worker, whose retries depend on seeing the failure. */
  async processIncomingOrThrow(
    payload: WhatsAppWebhookPayloadDto,
    options: WebhookRunOptions = {},
  ): Promise<void> {
    const entries = payload.entry ?? [];
    const messageCount = entries.reduce(
      (total, entry) =>
        total +
        (entry.changes ?? []).reduce(
          (sum, change) => sum + (change.value?.messages?.length ?? 0),
          0,
        ),
      0,
    );
    const statusCount = entries.reduce(
      (total, entry) =>
        total +
        (entry.changes ?? []).reduce(
          (sum, change) => sum + (change.value?.statuses?.length ?? 0),
          0,
        ),
      0,
    );

    // Counts, not just "we got something": a subscription that delivers
    // statuses but no messages (or the reverse) is a Meta-side field
    // configuration problem, and this is the line that tells them apart.
    this.logger.log(
      buildBackendLog(WhatsAppWebhookService.name, {
        action: 'whatsapp-webhook-receive',
        outcome: 'success',
        messageCount,
        statusCount,
      }),
    );

    for (const entry of entries) {
      const changes = entry.changes ?? [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value) continue;

        await this.handleMessages(value.messages ?? [], options);
        await this.handleStatuses(value.statuses ?? [], {
          phoneNumberId: value.metadata?.phone_number_id,
          wabaId: entry.id,
        });
      }
    }
  }

  /**
   * Resolve which verification a customer reply is answering, and what it says.
   *
   * Two routes, in order of trustworthiness:
   *  - a quick-reply button carries the verification id in its own payload;
   *  - a free-text answer carries nothing, so it is matched by `context.id`,
   *    the wamid of the message it quotes: the confirmation, or a reminder
   *    sent later, which replaces the verification's own wamid.
   *
   * Anything that resolves to neither is returned as `null` and logged by the
   * caller, so an unhandled reply shape stops being invisible.
   */
  private async resolveReply(
    message: WhatsAppMessageDto,
    options: WebhookRunOptions,
  ): Promise<{
    verificationId: string;
    intent: CustomerReplyIntent;
    via: 'button' | 'text';
    /** The confirmation cycle the button belongs to; legacy buttons have none. */
    cycle?: number;
  } | null> {
    const buttonPayload =
      message.button?.payload ?? message.interactive?.button_reply?.id;
    if (buttonPayload) {
      const resolved = resolveButtonPayload(buttonPayload);
      if (resolved) {
        return {
          verificationId: resolved.verificationId,
          intent: resolved.intent,
          via: 'button',
        };
      }
    }

    const body = message.text?.body;
    const contextWamid = message.context?.id;
    if (!body) return null;

    const intent = resolveReplyText(body);
    if (!intent) return null;

    const bound = message.id ? options.replyBindings?.[message.id] : undefined;
    if (bound) return { verificationId: bound, intent, via: 'text' };
    if (!contextWamid) return null;

    const verification = await this.findRepliedVerification(contextWamid);
    if (!verification) return null;

    return { verificationId: verification.id, intent, via: 'text' };
  }

  /**
   * Whether an earlier run of this event saved this very answer and may have
   * stopped before telling the store. `updateStatus` then matches no row, so
   * a retry can't tell that apart from a repeat without looking.
   */
  private holdsCustomerAnswer(
    verification: Awaited<ReturnType<VerificationsRepository['findById']>>,
    answer: CustomerReplyIntent,
  ): boolean {
    if (verification?.status !== answer) return false;
    return answer === 'confirmed'
      ? verification.confirmationSource === 'customer'
      : verification.cancellationSource === 'customer';
  }

  private async handleMessages(
    messages: WhatsAppMessageDto[],
    options: WebhookRunOptions,
  ) {
    for (const message of messages) {
      const resolved = await this.resolveReply(message, options);
      if (!resolved) {
        this.logger.warn(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            messageType: message.type,
            hasButtonPayload: Boolean(
              message.button?.payload ?? message.interactive?.button_reply?.id,
            ),
            hasText: Boolean(message.text?.body),
            hasContext: Boolean(message.context?.id),
            reason: 'unresolved_reply',
          }),
        );
        if (this.switches().unresolvedReplyNudge && !options.receivingSender) {
          await this.followUpUnresolvedReply(message, options);
        }
        continue;
      }

      const { verificationId, intent: newStatus, via } = resolved;

      // Block customer reply if merchant already canceled (no_reply escalation)
      const existing = await this.verificationsRepo.findById(verificationId);
      if (
        options.receivingOrgId &&
        existing?.orgId !== options.receivingOrgId
      ) {
        this.logger.warn(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            orgId: options.receivingOrgId,
            reason: 'foreign_verification',
          }),
        );
        continue;
      }
      // A button of a cycle an updated confirmation retired changes nothing.
      if (
        via === 'button' &&
        existing &&
        (resolved.cycle ?? LEGACY_CONFIRMATION_CYCLE) !==
          (existing.confirmationCycle ?? LEGACY_CONFIRMATION_CYCLE)
      ) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            verificationId,
            reason: 'stale_confirmation_cycle',
          }),
        );
        continue;
      }
      if (existing?.merchantCanceledAt) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            verificationId,
            reason: 'merchant_already_canceled',
          }),
        );
        continue;
      }

      const cancellationCommitted = await this.recordCustomerAnswer(
        verificationId,
        newStatus,
        message,
      );

      // The store is canceling, or canceled, this order on Akeed's request.
      // A Confirm was flagged for the merchant to review instead.
      if (cancellationCommitted) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            verificationId,
            reason: 'auto_cancel_committed',
          }),
        );
        continue;
      }

      // Set cancellationSource for customer-initiated cancellations
      const extraUpdates: Record<string, unknown> = {};
      if (newStatus === 'canceled') {
        extraUpdates.cancellationSource = 'customer';
      }
      if (newStatus === 'confirmed') {
        extraUpdates.confirmationSource = 'customer';
      }

      const rows = await this.verificationsRepo.updateStatus(
        verificationId,
        newStatus,
        undefined,
        message.timestamp,
        extraUpdates,
      );

      // A retry finishes what the run before it left: the answer is saved, so
      // the store may never have heard it.
      const finishing =
        rows.length === 0 &&
        options.isRetry === true &&
        this.holdsCustomerAnswer(existing, newStatus);

      if (rows.length > 0 || finishing) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'success',
            verificationId,
            status: newStatus,
            via,
            ...(finishing ? { reason: 'finishing_saved_answer' } : {}),
          }),
        );
        await this.resolveChangeRequest(verificationId, newStatus, message);
        await this.verificationHub.finalizeVerification(
          verificationId,
          newStatus,
          ...(finishing ? ([{ skipIfSynced: true }] as const) : []),
        );
        await this.adminLifecycles?.recordMessageStatus({
          verificationId,
          status: newStatus,
          occurredAt: message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : undefined,
        });
        if (options.receivingSender || this.switches().acknowledgment) {
          await this.queueAcknowledgment(
            verificationId,
            newStatus,
            message,
            options,
          );
        }
      } else {
        this.logger.warn(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'skipped',
            verificationId,
            status: newStatus,
            via,
            reason: 'already_terminal_or_not_found',
          }),
        );
      }
    }
  }

  private async isServiceMessageReceipt(
    wamid: string,
    status: VerificationStatus,
  ): Promise<boolean> {
    if (!this.serviceMessages) {
      return false;
    }
    const matched =
      status === 'failed'
        ? await this.serviceMessages.recordDeliveryFailure(wamid)
        : await this.serviceMessages.isServiceMessage(wamid);
    if (matched) {
      this.logger.log(
        buildBackendLog(WhatsAppWebhookService.name, {
          action: 'whatsapp-webhook-handle-status',
          outcome: 'skipped',
          wamid,
          status,
          reason: 'service_message',
        }),
      );
    }
    return matched;
  }

  private async handleStatuses(
    statuses: WhatsAppStatusDto[],
    routing: { phoneNumberId?: string; wabaId?: string } = {},
  ) {
    const allowedStatuses: VerificationStatus[] = [
      'delivered',
      'read',
      'failed',
    ];

    for (const statusObj of statuses) {
      const wamid = statusObj.id;
      const status = statusObj.status;
      if (!wamid || !status) continue;

      if (
        ['sent', 'delivered', 'read', 'failed'].includes(status) &&
        this.messageDispatches.recordMerchantReceipt
      ) {
        const seconds = Number(statusObj.timestamp);
        const occurredAt =
          Number.isFinite(seconds) && seconds > 0
            ? new Date(seconds * 1000).toISOString()
            : new Date().toISOString();
        const merchant = await this.messageDispatches.recordMerchantReceipt({
          providerMessageId: wamid,
          attemptId: statusObj.biz_opaque_callback_data,
          ...routing,
          status: status as 'sent' | 'delivered' | 'read' | 'failed',
          occurredAt,
          ...(status === 'failed'
            ? {
                failure: classifyOwnNumberFailure({
                  code: statusObj.errors?.[0]?.code,
                }),
              }
            : {}),
        });
        if (merchant) {
          await this.senderRecovery?.enqueueRecovery(
            merchant.orgId,
            merchant.dispatchId,
          );
          if (
            status === 'failed' &&
            String(statusObj.errors?.[0]?.code) === '131026' &&
            (await this.verificationsRepo.findById(merchant.verificationId))
              ?.status === 'no_whatsapp'
          )
            await this.verificationHub.markNoWhatsApp(
              merchant.verificationId,
              'receipt',
            );
          continue;
        }
      }

      const typedStatus = status as VerificationStatus;
      if (!allowedStatuses.includes(typedStatus)) continue;

      // Legacy free texts and nudges have no billing dispatch. Paid thank-you
      // receipts proceed through the ledger even while sending is disabled.
      if (await this.isServiceMessageReceipt(wamid, typedStatus)) continue;

      const failureInfo =
        typedStatus === 'failed' && statusObj.errors?.[0]
          ? {
              code: statusObj.errors[0].code,
              title: statusObj.errors[0].title,
            }
          : undefined;

      const occurredAt = statusObj.timestamp
        ? new Date(Number(statusObj.timestamp) * 1000).toISOString()
        : new Date().toISOString();
      // A receipt can beat the commit that records its wamid. It is parked
      // rather than dropped, and the acceptance applies it when it lands.
      const resolution = await this.messageDispatches.resolveOrParkReceipt({
        ...(routing.phoneNumberId && routing.wabaId
          ? {
              senderReceiptContext: {
                ...routing,
                ...(typedStatus === 'failed'
                  ? {
                      failure: classifyOwnNumberFailure({
                        code: failureInfo?.code,
                      }),
                    }
                  : {}),
              },
            }
          : {}),
        providerMessageId: wamid,
        status: typedStatus as 'delivered' | 'read' | 'failed',
        occurredAt,
        ...(failureInfo ? { failureInfo } : {}),
      });
      if (resolution.outcome === 'parked') {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-status',
            outcome: 'retry',
            wamid,
            status: typedStatus,
            reason: 'awaiting_acceptance',
          }),
        );
        continue;
      }
      const dispatch =
        resolution.outcome === 'dispatch' ? resolution.dispatch : undefined;
      let creditProjection: Awaited<
        ReturnType<
          VerificationMessageDispatchesRepository['recordProviderStatus']
        >
      >;
      if (dispatch) {
        creditProjection = await this.messageDispatches.recordProviderStatus(
          dispatch.id,
          typedStatus as 'delivered' | 'read' | 'failed',
          occurredAt,
          ...(failureInfo ? ([failureInfo] as const) : []),
        );
      }
      // A follow-up receipt is evidence like any other: if the reminder was
      // delivered or read, the customer did receive and open a message, and the
      // row must say so. The concern this used to guard against — a late
      // follow-up receipt disturbing a verification the customer already
      // answered — is enforced one level down, where `updateStatus` refuses to
      // overwrite `confirmed`, `canceled` or `no_reply` for any non-reply status.
      const rows =
        creditProjection?.verificationRows ??
        (dispatch
          ? await this.verificationsRepo.updateStatus(
              dispatch.verificationId,
              typedStatus,
              undefined,
              statusObj.timestamp,
              ...(failureInfo ? ([undefined, failureInfo] as const) : []),
            )
          : await this.verificationsRepo.updateStatusByWamid(
              wamid,
              typedStatus,
              statusObj.timestamp,
              ...(failureInfo ? ([failureInfo] as const) : []),
            ));

      if (rows.length > 0) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-status',
            outcome: 'success',
            wamid,
            status: typedStatus,
            ...(dispatch ? { messageKind: dispatch.kind } : {}),
            ...(failureInfo
              ? {
                  providerErrorCode: failureInfo.code ?? 'unknown',
                  providerErrorTitle: failureInfo.title ?? 'unknown',
                }
              : {}),
          }),
        );
        // Only the write that moved the row gets here with `no_whatsapp`: a
        // duplicate or late receipt matches no row once the status is
        // protected, and a receipt after a delivery leaves the status as is.
        if (typedStatus === 'failed' && rows[0]?.status === 'no_whatsapp') {
          await this.verificationHub.markNoWhatsApp(rows[0].id, 'receipt');
        }
        if (
          (typedStatus === 'delivered' || typedStatus === 'read') &&
          rows[0]
        ) {
          await this.adminLifecycles?.recordMessageStatus({
            verificationId: rows[0].id,
            status: typedStatus,
            occurredAt: statusObj.timestamp
              ? new Date(Number(statusObj.timestamp) * 1000).toISOString()
              : undefined,
          });
        }
      } else {
        this.logger.warn(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-status',
            outcome: 'skipped',
            wamid,
            status: typedStatus,
            reason: 'verification_not_found',
          }),
        );
      }
    }
  }
}
