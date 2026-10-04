import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WooCommerceAuthService } from './woocommerce-auth.service';

/**
 * The install callback (contract record section 1). Who sends it is not
 * documented (finding 1.12), so it is public, throttled and trusts nothing
 * about the sender: no origin check, no address allow-list and, unlike the
 * EasyOrders callback, no route-scoped CORS entry. The path token is the only
 * binding to a tenant and a store.
 *
 * The answer is an empty JSON object: the keys in the request are never
 * echoed (worst-case rule for finding 1.13).
 */
@Controller('api/woocommerce/install/callback')
export class WooCommerceInstallCallbackController {
  constructor(private readonly wooCommerce: WooCommerceAuthService) {}

  @Post(':token')
  // Tighter than the app-wide limit: each accepted request costs several
  // calls to a store, and a context dies after a few failed attempts anyway.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('token') token: string,
    // A plain object, so the app-wide ValidationPipe leaves it alone; the
    // service reads the documented fields and ignores the rest.
    @Body() body: object,
  ): Promise<Record<string, never>> {
    await this.wooCommerce.handleCallback(token, body);
    return {};
  }
}
