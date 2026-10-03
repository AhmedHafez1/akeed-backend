import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../../../modules/auth/guards/dual-auth.guard';
import { CurrentUser } from '../../../modules/auth/guards/current-user.decorator';
import {
  SaveEasyOrdersWebhookSecretsDto,
  StartEasyOrdersInstallDto,
  type EasyOrdersConnectionStatusDto,
  type EasyOrdersInstallStartedDto,
} from './dto/easyorders-connection.dto';
import { EasyOrdersAuthService } from './easyorders-auth.service';
import { easyOrdersError } from './easyorders.errors';

/** Route pipes answering with a code and never repeating the rejected value. */
export const startEasyOrdersInstallPipe = new ValidationPipe({
  expectedType: StartEasyOrdersInstallDto,
  whitelist: true,
  transform: true,
  exceptionFactory: () =>
    easyOrdersError('EASYORDERS_INSTALL_VALIDATION_FAILED'),
});

export const saveEasyOrdersWebhookSecretsPipe = new ValidationPipe({
  expectedType: SaveEasyOrdersWebhookSecretsDto,
  whitelist: true,
  transform: true,
  exceptionFactory: (errors) =>
    easyOrdersError('EASYORDERS_SECRETS_INVALID', {
      fields: errors.map((error) => error.property),
    }),
});

/** The EasyOrders connection for signed-in members (session auth). */
@Controller('api/easyorders')
@UseGuards(DualAuthGuard)
export class EasyOrdersConnectionController {
  constructor(private readonly easyOrders: EasyOrdersAuthService) {}

  @Get('connection')
  @Header('Cache-Control', 'no-store')
  getStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EasyOrdersConnectionStatusDto> {
    return this.easyOrders.getStatus(user);
  }

  /** 201 with the install link: the only response that ever contains it. */
  @Post('install')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.CREATED)
  startInstall(
    @CurrentUser() user: AuthenticatedUser,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with the EasyOrders code.
    @Body(startEasyOrdersInstallPipe) body: object,
  ): Promise<EasyOrdersInstallStartedDto> {
    return this.easyOrders.startInstall(
      user,
      body as StartEasyOrdersInstallDto,
    );
  }

  @Put('connection/webhook-secrets')
  @Header('Cache-Control', 'no-store')
  saveWebhookSecrets(
    @CurrentUser() user: AuthenticatedUser,
    @Body(saveEasyOrdersWebhookSecretsPipe) body: object,
  ): Promise<EasyOrdersConnectionStatusDto> {
    return this.easyOrders.saveWebhookSecrets(
      user,
      body as SaveEasyOrdersWebhookSecretsDto,
    );
  }
}
