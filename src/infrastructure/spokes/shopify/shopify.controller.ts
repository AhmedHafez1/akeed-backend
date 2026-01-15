import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';
import { VerificationHubService } from '../../../core/services/verification-hub.service';
import { NormalizedOrder } from '../../../core/interfaces/order.interface';

@Controller('webhooks')
@UseGuards(ShopifyHmacGuard)
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly verificationHub: VerificationHubService) {}

  @Post('orders-create')
  @HttpCode(200)
  async handleOrderCreate(@Body() payload: any) {
    this.logger.log(`Received Shopify Order Webhook: ${payload.id}`);

    const normalizedOrder = this.mapToHubOrder(payload);

    await this.verificationHub.handleNewOrder(normalizedOrder);

    return { received: true };
  }

  private mapToHubOrder(payload: any): NormalizedOrder {
    // Attempt to find a phone number from various fields
    const phone =
      payload.phone ||
      payload.customer?.phone ||
      payload.customer?.default_address?.phone ||
      payload.billing_address?.phone ||
      payload.shipping_address?.phone;

    return {
      orgId: 'SHOPIFY_ORG',
      externalOrderId: String(payload.id),
      orderNumber: String(payload.order_number),
      customerPhone: phone || '', // Ideally this should be validated/formatted but basic extraction for now
      customerName: payload.customer
        ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
        : 'Guest',
      totalPrice: payload.total_price,
      currency: payload.currency,
      rawPayload: payload,
    };
  }
}
