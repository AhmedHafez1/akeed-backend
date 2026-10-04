import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WooCommerceWebhookService } from './woocommerce-webhook.service';

/**
 * The delivery URL Akeed registers in a store (contract record section 6).
 * Public: the path token decides the tenant, and the service checks the
 * signature and the source before anything else. The body reaches the route
 * as raw bytes (`applyWooCommerceWebhookEdge`), which the signature is over.
 */
@Controller('api/woocommerce/webhooks')
// A shared host can deliver many stores' webhooks from one address, and a
// throttled delivery counts as a failure at the store. This is a flood cap.
@Throttle({ default: { limit: 1_200, ttl: 60_000 } })
export class WooCommerceWebhookController {
  constructor(private readonly webhooks: WooCommerceWebhookService) {}

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  handle(
    @Param('token') token: string,
    @Headers('x-wc-webhook-topic') topic: string | undefined,
    @Headers('x-wc-webhook-signature') signature: string | undefined,
    @Headers('x-wc-webhook-source') source: string | undefined,
    @Headers('x-wc-webhook-id') webhookId: string | undefined,
    @Headers('x-wc-webhook-delivery-id') deliveryId: string | undefined,
    // Untyped, so the app-wide ValidationPipe leaves the bytes alone.
    @Body() body: unknown,
  ): Promise<void> {
    return this.webhooks.handleDelivery(
      token,
      { topic, signature, source, webhookId, deliveryId },
      body,
    );
  }
}
