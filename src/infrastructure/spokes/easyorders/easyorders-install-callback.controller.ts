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
import { EasyOrdersAuthService } from './easyorders-auth.service';

/**
 * The install callback (contract record section 1). It is called by the
 * seller's browser from the EasyOrders dashboard, not by EasyOrders' servers,
 * so it is public and its CORS preflight is answered for that one origin
 * (`ROUTE_SCOPED_CORS`). The path token is the only tenant binding.
 *
 * The answer is an empty 204: the API key in the request is never echoed.
 */
@Controller('api/easyorders/install/callback')
export class EasyOrdersInstallCallbackController {
  constructor(private readonly easyOrders: EasyOrdersAuthService) {}

  @Post(':token')
  // Tighter than the app-wide limit: each accepted request costs one call to
  // EasyOrders, and a context dies after a few failed attempts anyway.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  handle(
    @Param('token') token: string,
    // A plain object, so the app-wide ValidationPipe leaves it alone; the
    // service reads the two documented fields and ignores the rest.
    @Body() body: object,
  ): Promise<void> {
    return this.easyOrders.handleCallback(token, body);
  }
}
