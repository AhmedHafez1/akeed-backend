import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Patch,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import {
  IssueWhatsappConnectTicketDto,
  type WhatsappConnectTicketIssuedDto,
} from './dto/whatsapp-connect.dto';
import type { WhatsappConnectionStatusDto } from './dto/whatsapp-connection-status.dto';
import type { WhatsappSenderAvailabilityDto } from './dto/whatsapp-sender.dto';
import { ConnectionStatusService } from './connection-status.service';
import { whatsappConnectError } from './whatsapp-connect.errors';
import { WhatsappConnectService } from './whatsapp-connect.service';
import { WhatsappSenderService } from './whatsapp-sender.service';
import {
  WhatsappConnectionSettingsService,
  whatsappConnectionSettingsError,
} from './whatsapp-connection-settings.service';
import {
  UpdateWhatsappConnectionSettingsDto,
  type WhatsappConnectionSettingsDto,
} from './dto/whatsapp-connection-settings.dto';
import {
  WhatsappDisconnectService,
  type WhatsappDisconnectResponseDto,
} from './whatsapp-disconnect.service';

/** Answers with a code and never repeats the rejected value. */
export const issueWhatsappConnectTicketPipe = new ValidationPipe({
  expectedType: IssueWhatsappConnectTicketDto,
  whitelist: true,
  transform: true,
  exceptionFactory: () =>
    whatsappConnectError('WHATSAPP_CONNECT_INVALID_REQUEST'),
});

export const whatsappConnectionSettingsPipe = new ValidationPipe({
  expectedType: UpdateWhatsappConnectionSettingsDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: () =>
    whatsappConnectionSettingsError('WHATSAPP_CONNECTION_SETTINGS_INVALID'),
});

/** The merchant's own WhatsApp number, for signed-in members. */
@Controller('api/whatsapp-sender')
@UseGuards(DualAuthGuard)
export class WhatsappSenderController {
  constructor(
    private readonly sender: WhatsappSenderService,
    private readonly connect: WhatsappConnectService,
    private readonly status: ConnectionStatusService,
    private readonly disconnectService: WhatsappDisconnectService,
    private readonly settings: WhatsappConnectionSettingsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getAvailability(
    @CurrentUser() user: AuthenticatedUser,
  ): WhatsappSenderAvailabilityDto {
    return this.sender.getAvailability(user);
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WhatsappDisconnectResponseDto> {
    return this.disconnectService.disconnect(user);
  }

  @Patch('connection')
  @Header('Cache-Control', 'no-store')
  updateConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Body(whatsappConnectionSettingsPipe) body: object,
  ): Promise<WhatsappConnectionSettingsDto> {
    return this.settings.update(
      user,
      body as UpdateWhatsappConnectionSettingsDto,
    );
  }

  /** Setup progress and template counts; `null` before any signup. */
  @Get('connection')
  @Header('Cache-Control', 'no-store')
  async getConnection(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ connection: WhatsappConnectionStatusDto | null }> {
    return { connection: await this.status.forOrganization(user.orgId) };
  }

  /** 201 with the connect page link: the only response that ever holds it. */
  @Post('connect-ticket')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.CREATED)
  issueConnectTicket(
    @CurrentUser() user: AuthenticatedUser,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with the connect code.
    @Body(issueWhatsappConnectTicketPipe) body: object,
  ): Promise<WhatsappConnectTicketIssuedDto> {
    return this.connect.issueTicket(
      user,
      (body as IssueWhatsappConnectTicketDto).locale,
    );
  }
}
