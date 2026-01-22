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

    // 1. Handle Button Replies (Interactive)
    if (value.messages?.[0]?.type === 'button') {
      const message = value.messages[0];
      const buttonReplyId = message.interactive?.button_reply?.id;

      // Assuming buttonReplyId IS the verificationId or contains it.
      // The prompt says: "extract the button_reply.id" and "Use VerificationsRepository.updateStatus()".
      // Usually, button payloads are encoded like "verify_123" or just "123".
      // I will assume the button ID itself is the verification ID or mapped to it.
      // However, the prompt says "update the verification status to 'delivered' or 'read' based on the wamid" for STATUSES.
      // For BUTTON REPLIES, it says "Use VerificationsRepository.updateStatus() to save the new state ('confirmed' or 'canceled')".

      // Let's assume the button ID is "confirm_VERIFICATIONID" or "cancel_VERIFICATIONID".
      // Or simply that the button ID IS the action, and we need to find the verification.
      // BUT, the prompt implies we have the ID available.

      // Let's split: "CONFIRM:UUID"

      if (buttonReplyId) {
        const parts = buttonReplyId.split(':');
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

    // 2. Handle Status Updates (Delivered / Read)
    if (value.statuses?.[0]) {
      const statusObj = value.statuses[0];
      const wamid = statusObj.id;
      const status: VerificationStatus = statusObj.status; // 'delivered', 'read', 'sent'

      if (status === 'delivered' || status === 'read') {
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
}
