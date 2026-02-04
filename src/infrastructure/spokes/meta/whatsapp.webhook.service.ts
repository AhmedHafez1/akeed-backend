import { Injectable, Logger } from '@nestjs/common';
import { VerificationsRepository } from '../../database/repositories/verifications.repository';
import { VerificationHubService } from 'src/core/services/verification-hub.service';
import { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import { VerificationStatus } from 'src/core/interfaces/verification.interface';

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
    this.logger.log('Received WhatsApp webhook payload:', payload);

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      return;
    }

    // Handle Button Replies
    const message = value.messages?.[0];
    if (message?.type === 'button') {
      const buttonReplyId = message.button?.payload;

      if (buttonReplyId) {
        const parts = buttonReplyId.split('_');
        if (parts.length === 2) {
          const action = parts[0].toLowerCase();
          const verificationId = parts[1];

          let newStatus: 'confirmed' | 'canceled' | null = null;
          if (action === 'confirm' || action === 'yes') newStatus = 'confirmed';
          if (action === 'cancel' || action === 'no') newStatus = 'canceled';

          if (newStatus) {
            this.logger.log(
              `Updated verification status for verificationId: ${verificationId} to ${newStatus}`,
            );
            await this.verificationsRepo.updateStatus(
              verificationId,
              newStatus,
            );
            await this.verificationHub.finalizeVerification(
              verificationId,
              newStatus,
            );
          }
        }
      }
    }

    // Handle Status Updates (Delivered / Read)
    const statusObj = value.statuses?.[0];
    if (statusObj) {
      const wamid = statusObj.id;
      const status = statusObj.status;

      if (!wamid || !status) {
        return;
      }

      const typedStatus = status as VerificationStatus;

      if (typedStatus === 'sent') return;

      this.logger.log(
        `Updating verification status for wamid: ${wamid} to ${typedStatus}`,
      );

      await this.verificationsRepo.updateStatusByWamid(wamid, typedStatus);
    }
  }
}
