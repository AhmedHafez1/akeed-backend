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
import {
  EasyOrdersWebhookService,
  type EasyOrdersWebhookAck,
} from './easyorders-webhook.service';

/**
 * The two webhook URLs an install registers at EasyOrders (contract record
 * section 6). Public: the path token and the `secret` header are the only
 * authentication, and both are checked by the service before anything else.
 */
@Controller('webhooks/easyorders')
// EasyOrders delivers every store's webhooks from its own servers, so the
// app-wide per-address limit would drop real orders. This is only a flood cap.
@Throttle({ default: { limit: 1_200, ttl: 60_000 } })
export class EasyOrdersWebhookController {
  constructor(private readonly webhooks: EasyOrdersWebhookService) {}

  @Post('orders/:token')
  @HttpCode(HttpStatus.OK)
  handleOrderCreated(
    @Param('token') token: string,
    @Headers('secret') secret: string | undefined,
    // A plain object, so the app-wide ValidationPipe leaves the payload alone.
    @Body() body: object,
  ): Promise<EasyOrdersWebhookAck> {
    return this.webhooks.handleOrderCreated(token, secret, body);
  }

  @Post('status/:token')
  @HttpCode(HttpStatus.OK)
  handleStatusUpdate(
    @Param('token') token: string,
    @Headers('secret') secret: string | undefined,
    @Body() body: object,
  ): Promise<EasyOrdersWebhookAck> {
    return this.webhooks.handleStatusUpdate(token, secret, body);
  }
}
