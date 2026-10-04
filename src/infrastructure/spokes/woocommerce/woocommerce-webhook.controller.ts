import {
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
 * Public: the path token decides the tenant. The body is not read here; it
 * reaches the route as raw bytes (`applyWooCommerceWebhookEdge`).
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
  ): Promise<void> {
    return this.webhooks.handleDelivery(token, topic);
  }
}
