// import { WhatsAppSpoke } from '../infrastructure/spokes/meta/whatsapp.spoke';

import { Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from 'src/core/interfaces/order.interface';
import { OrdersRepository } from 'src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from 'src/infrastructure/database/repositories/verifications.repository';

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    // private waSpoke: WhatsAppSpoke, // We will build this in Step 3
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

    // 3. Trigger WhatsApp Message (Placeholder for now)
    this.logger.log(`Triggering WhatsApp for Order ${order.id}...`);

    // In next steps, we call:
    // await this.waSpoke.sendVerification(order, verification.id);

    return { orderId: order.id, verificationId: verification.id };
  }
}
