// import { WhatsAppSpoke } from '../infrastructure/spokes/meta/whatsapp.spoke';

import { Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from 'src/core/interfaces/order.interface';
import { OrdersRepository } from 'src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from 'src/infrastructure/database/repositories/verifications.repository';
import { WhatsAppService } from 'src/infrastructure/spokes/meta/whatsapp.service';
import { ShopifyApiService } from 'src/infrastructure/spokes/shopify/services/shopify-api.service';
import { integrations } from '../../infrastructure/database/schema';

@Injectable()
export class VerificationHubService {
  private readonly logger = new Logger(VerificationHubService.name);

  constructor(
    private ordersRepo: OrdersRepository,
    private verificationsRepo: VerificationsRepository,
    private waSpoke: WhatsAppService,
    private shopifyApiService: ShopifyApiService,
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
      `Finalizing Verification ${verificationId} with status: ${status}`,
    );

    // 1. Fetch the full record to get the externalOrderId and orgId
    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) return;

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) return;

    // 2. Only take action on terminal states (Confirmed/Canceled)
    if (status === 'confirmed' || status === 'canceled') {
      const tag =
        status === 'confirmed' ? 'Akeed: Verified' : 'Akeed: Canceled';

      // 3. Trigger the Shopify Spoke (Adapter)
      // We'll pass the shop domain (stored in integrations) and the order ID
      const integration = order.integration as typeof integrations.$inferSelect;
      if (integration?.platformStoreUrl) {
        await this.shopifyApiService.addOrderTag(
          integration.platformStoreUrl,
          order.externalOrderId,
          tag,
        );

        this.logger.log(
          `Shopify Order ${order.externalOrderId} updated with tag: ${tag}`,
        );
      } else {
        this.logger.warn(
          `Skipping Shopify tag update for Order ${order.externalOrderId}: No linked integration found (Organization: ${order.orgId})`,
        );
      }
    }
  }
}
