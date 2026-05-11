import { Injectable, Logger } from '@nestjs/common';
import { VerificationsRepository } from '../../database/repositories/verifications.repository';
import { VerificationHubService } from '../../../modules/verification-core/verification-hub.service';
import {
  WhatsAppMessageDto,
  WhatsAppStatusDto,
  WhatsAppWebhookPayloadDto,
} from './dto/whatsapp-webhook.dto';
import { VerificationStatus } from '../../../shared/interfaces/verification.interface';

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private verificationsRepo: VerificationsRepository,
    private verificationHub: VerificationHubService,
  ) {}

  async processIncoming(
    payload: WhatsAppWebhookPayloadDto,
  ): Promise<{ status: string; message?: string }> {
    try {
      await this.handleIncoming(payload);
      return { status: 'success' };
    } catch (error) {
      this.logger.error('Error handling webhook payload:', error);
      // Always return 200 OK to prevent Meta from disabling the webhook
      return { status: 'error', message: 'Internal Server Error' };
    }
  }

  private async handleIncoming(payload: WhatsAppWebhookPayloadDto) {
    this.logger.log('Received WhatsApp webhook payload');

    const entries = payload.entry ?? [];
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

  private async handleMessages(messages: WhatsAppMessageDto[]) {
    for (const message of messages) {
      if (message.type !== 'button' && message.type !== 'interactive') continue;

      const buttonPayload =
        message.button?.payload ?? message.interactive?.button_reply?.id;
      if (!buttonPayload) continue;

      const parts = buttonPayload.split('_');
      if (parts.length !== 2) continue;

      const action = parts[0].toLowerCase();
      const verificationId = parts[1];

      let newStatus: 'confirmed' | 'canceled' | null = null;
      if (action === 'confirm' || action === 'yes') newStatus = 'confirmed';
      if (action === 'cancel' || action === 'no') newStatus = 'canceled';
      if (!newStatus) continue;

      // Block customer reply if merchant already canceled (no_reply escalation)
      const existing =
        await this.verificationsRepo.findById(verificationId);
      if (existing?.merchantCanceledAt) {
        this.logger.log(
          `Ignoring customer reply for verification ${verificationId} — merchant already canceled`,
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
          `Updated verification ${verificationId} to ${newStatus}`,
        );
        await this.verificationHub.finalizeVerification(
          verificationId,
          newStatus,
        );
      } else {
        this.logger.warn(
          `No rows updated for verification ${verificationId} → ${newStatus} (already terminal or not found)`,
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

      const rows = await this.verificationsRepo.updateStatusByWamid(
        wamid,
        typedStatus,
        statusObj.timestamp,
      );

      if (rows.length > 0) {
        this.logger.log(
          `Updated verification wamid=${wamid} to ${typedStatus}`,
        );
      } else {
        this.logger.warn(
          `No verification matched wamid=${wamid} for status ${typedStatus}`,
        );
      }
    }
  }
}
