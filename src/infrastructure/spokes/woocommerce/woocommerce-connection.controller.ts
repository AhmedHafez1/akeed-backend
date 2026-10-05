import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../../../modules/auth/guards/dual-auth.guard';
import { CurrentUser } from '../../../modules/auth/guards/current-user.decorator';
import {
  StartWooCommerceInstallDto,
  type WooCommerceConnectionCheckDto,
  type WooCommerceConnectionStatusDto,
  type WooCommerceDisconnectedDto,
  type WooCommerceInstallStartedDto,
} from './dto/woocommerce-connection.dto';
import { WooCommerceAuthService } from './woocommerce-auth.service';
import { wooCommerceError } from './woocommerce.errors';

/** Answers with a code and never repeats the rejected value. */
export const startWooCommerceInstallPipe = new ValidationPipe({
  expectedType: StartWooCommerceInstallDto,
  whitelist: true,
  transform: true,
  exceptionFactory: () =>
    wooCommerceError('WOOCOMMERCE_INSTALL_VALIDATION_FAILED'),
});

/** The WooCommerce connection for signed-in members (session auth). */
@Controller('api/woocommerce')
@UseGuards(DualAuthGuard)
export class WooCommerceConnectionController {
  constructor(private readonly wooCommerce: WooCommerceAuthService) {}

  @Get('connection')
  @Header('Cache-Control', 'no-store')
  getStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WooCommerceConnectionStatusDto> {
    return this.wooCommerce.getStatus(user);
  }

  /** 201 with the authorize link: the only response that ever contains it. */
  @Post('install')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.CREATED)
  startInstall(
    @CurrentUser() user: AuthenticatedUser,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with the WooCommerce code.
    @Body(startWooCommerceInstallPipe) body: object,
  ): Promise<WooCommerceInstallStartedDto> {
    return this.wooCommerce.startInstall(
      user,
      body as StartWooCommerceInstallDto,
    );
  }

  /** Works with the connect switch off: a disconnect is never gated. */
  @Delete('connection')
  @Header('Cache-Control', 'no-store')
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WooCommerceDisconnectedDto> {
    return this.wooCommerce.disconnect(user);
  }

  /** 200 with what was found: a diagnosis is an answer, not a failure. */
  @Post('connection/check')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  checkConnection(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WooCommerceConnectionCheckDto> {
    return this.wooCommerce.checkConnection(user);
  }

  @Post('connection/webhooks/enable')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  enableWebhooks(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WooCommerceConnectionStatusDto> {
    return this.wooCommerce.enableWebhooks(user);
  }
}
