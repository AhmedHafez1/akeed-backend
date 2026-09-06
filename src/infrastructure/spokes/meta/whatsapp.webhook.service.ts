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

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private verificationsRepo: VerificationsRepository,
    private verificationHub: VerificationHubService,
    private readonly messageDispatches: VerificationMessageDispatchesRepository,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
  ) {}

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

      const dispatch =
        await this.messageDispatches.findByProviderMessageId(wamid);
      if (dispatch) {
        const occurredAt = statusObj.timestamp
          ? new Date(Number(statusObj.timestamp) * 1000).toISOString()
          : new Date().toISOString();
        await this.messageDispatches.recordProviderStatus(
          dispatch.id,
          typedStatus as 'delivered' | 'read' | 'failed',
          occurredAt,
        );
      }
      const rows = dispatch
        ? dispatch.kind === 'follow_up'
          ? []
          : await this.verificationsRepo.updateStatus(
              dispatch.verificationId,
              typedStatus,
              undefined,
              statusObj.timestamp,
            )
        : await this.verificationsRepo.updateStatusByWamid(
            wamid,
            typedStatus,
            statusObj.timestamp,
          );

      if (dispatch?.kind === 'follow_up') {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-status',
            outcome: 'success',
            wamid,
            verificationId: dispatch.verificationId,
            status: typedStatus,
            messageKind: dispatch.kind,
          }),
        );
        continue;
      }

      if (rows.length > 0) {
        this.logger.log(
          buildBackendLog(WhatsAppWebhookService.name, {
            action: 'whatsapp-webhook-handle-status',
            outcome: 'success',
            wamid,
            status: typedStatus,
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
