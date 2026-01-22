import { Injectable, Logger } from '@nestjs/common';
import { VerificationsRepository } from '../../database/repositories/verifications.repository';
import { VerificationHubService } from 'src/core/services/verification-hub.service';
import { WhatsAppWebhookPayload } from './models/whatsapp-webhook.payload';
import { VerificationStatus } from 'src/core/interfaces/verification.interface';

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private verificationsRepo: VerificationsRepository,
    private verificationHub: VerificationHubService,
  ) {}

  async handleIncoming(payload: WhatsAppWebhookPayload) {
    this.logger.log('Received WhatsApp webhook payload:', payload);

    if (!payload?.entry?.[0]?.changes?.[0]?.value) {
      return;
    }

    const value = payload.entry[0].changes[0].value;

    // Handle Button Replies
    if (value.messages?.[0]?.type === 'button') {
      const message = value.messages[0];
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
    if (value.statuses?.[0]) {
      const statusObj = value.statuses[0];
      const wamid = statusObj.id;
      const status: VerificationStatus = statusObj.status;

      if (status === 'sent') return;

      this.logger.log(
        `Updating verification status for wamid: ${wamid} to ${status}`,
      );

      const result = await this.verificationsRepo.updateStatusByWamid(
        wamid,
        status,
      );

      if (result?.length > 0) {
        const verification = result[0];
        await this.verificationHub.finalizeVerification(
          verification.id,
          status,
        );
      }
    }
  }
}
