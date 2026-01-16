// import { WhatsAppSpoke } from '../infrastructure/spokes/meta/whatsapp.spoke';

import { Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from 'src/core/interfaces/order.interface';
import { OrdersRepository } from 'src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from 'src/infrastructure/database/repositories/verifications.repository';
import { WhatsAppService } from 'src/infrastructure/spokes/meta/whatsapp.service';

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    private waSpoke: WhatsAppService,
  ) {}

  async handleNewOrder(orderData: NormalizedOrder) {
    this.logger.log(`Processing Hub Order: ${orderData.externalOrderId}`);

    // 1. Check if order exists (Idempotency)
    let order = await this.ordersRepo.findByExternalId(
      orderData.externalOrderId,
      orderData.orgId,
    );

    if (!order) {
      order = await this.ordersRepo.create(orderData);
    }

    // 2. Create Verification Record
    const verification = await this.verificationsRepo.create({
      orgId: order.orgId,
      orderId: order.id,
      status: 'pending',
    });

    // 3. Trigger WhatsApp Message
    this.logger.log(`Triggering WhatsApp for Order ${order.id}...`);

    await this.waSpoke.sendVerificationTemplate(
      order.customerPhone,
      order.externalOrderId,
      verification.id,
    );

    return { orderId: order.id, verificationId: verification.id };
  }

  async finalizeVerification(verificationId: string, status: string) {
    this.logger.log(
      `Finalizing verification ${verificationId} with status: ${status}`,
    );
    // TODO: Implement business logic for next steps
  }
}
