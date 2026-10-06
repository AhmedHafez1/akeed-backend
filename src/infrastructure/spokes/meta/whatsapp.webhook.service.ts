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
  ) {}

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
    const direct = await this.verificationsRepo.findByWaMessageId(contextWamid);
    if (direct) return direct;
    const dispatch =
      await this.messageDispatches.findByProviderMessageId(contextWamid);
    return dispatch
      ? await this.verificationsRepo.findById(dispatch.verificationId)
      : undefined;
  }

  /**
   * US-08-07c: a typed reply that quotes an open verification's message but
   * reads as no answer. The reply is stored without its text and one nudge
   * is queued. Without `context.id` nothing is stored or sent: matching by
   * phone could pick another store's order (decision 8). Never throws: the
   * reply was already logged as unresolved.
   */
  private async followUpUnresolvedReply(
    message: WhatsAppMessageDto,
  ): Promise<void> {
    const body = message.text?.body;
    const contextWamid = message.context?.id;
    if (!body || !contextWamid || !message.id) return;
    if (resolveReplyText(body)) return;
    try {
      const verification = await this.findRepliedVerification(contextWamid);
      if (
        !verification ||
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

  /** US-08-07b: queue one acknowledgment. Never throws. */
  private async queueAcknowledgment(
    verificationId: string,
    intent: CustomerReplyIntent,
    message: WhatsAppMessageDto,
  ): Promise<void> {
    try {
      const verification =
        await this.verificationsRepo.findById(verificationId);
      if (!verification) return;
      await this.automation?.enqueueAcknowledgment({
        verificationId,
        orgId: verification.orgId,
        repliedAt: this.messageTime(message),
        intent,
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
      await this.handleIncoming(payload);
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

  private async handleIncoming(payload: WhatsAppWebhookPayloadDto) {
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
        const value = change.value;
        if (!value) continue;

        await this.handleMessages(value.messages ?? []);
        await this.handleStatuses(value.statuses ?? []);
      }
    }
  }

  /**
   * Resolve which verification a customer reply is answering, and what it says.
   *
   * Two routes, in order of trustworthiness:
   *  - a quick-reply button carries the verification id in its own payload;
   *  - a free-text answer carries nothing, so it is matched by `context.id`,
   *    the wamid of the template the customer replied to.
   *
   * Anything that resolves to neither is returned as `null` and logged by the
   * caller, so an unhandled reply shape stops being invisible.
   */
  private async resolveReply(message: WhatsAppMessageDto): Promise<{
    verificationId: string;
    intent: CustomerReplyIntent;
    via: 'button' | 'text';
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
    if (!body || !contextWamid) return null;

    const intent = resolveReplyText(body);
    if (!intent) return null;

    const verification =
      await this.verificationsRepo.findByWaMessageId(contextWamid);
    if (!verification) return null;

    return { verificationId: verification.id, intent, via: 'text' };
  }

  private async handleMessages(messages: WhatsAppMessageDto[]) {
    for (const message of messages) {
      const resolved = await this.resolveReply(message);
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
        if (this.switches().unresolvedReplyNudge) {
          await this.followUpUnresolvedReply(message);
        }
        continue;
      }

      const { verificationId, intent: newStatus, via } = resolved;

      // Block customer reply if merchant already canceled (no_reply escalation)
      const existing = await this.verificationsRepo.findById(verificationId);
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

      if (rows.length > 0) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-message',
            outcome: 'success',
            verificationId,
            status: newStatus,
            via,
          }),
        );
        await this.verificationHub.finalizeVerification(
          verificationId,
          newStatus,
        );
        await this.adminLifecycles?.recordMessageStatus({
          verificationId,
          status: newStatus,
          occurredAt: message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : undefined,
        });
        if (this.switches().acknowledgment) {
          await this.queueAcknowledgment(verificationId, newStatus, message);
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
    const switches = this.switches();
    if (
      !this.serviceMessages ||
      (!switches.acknowledgment && !switches.unresolvedReplyNudge)
    ) {
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

  private async handleStatuses(statuses: WhatsAppStatusDto[]) {
    const allowedStatuses: VerificationStatus[] = [
      'delivered',
      'read',
      'failed',
    ];

    for (const statusObj of statuses) {
      const wamid = statusObj.id;
      const status = statusObj.status;
      if (!wamid || !status) continue;

      const typedStatus = status as VerificationStatus;
      if (!allowedStatuses.includes(typedStatus)) continue;

      // An acknowledgment or a nudge (US-08-07 b, c) is no dispatch: its
      // receipt touches only its own row, and a failure marks it failed.
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
