import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
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

/** Answers with a code and never repeats the rejected value. */
export const issueWhatsappConnectTicketPipe = new ValidationPipe({
  expectedType: IssueWhatsappConnectTicketDto,
  whitelist: true,
  transform: true,
  exceptionFactory: () =>
    whatsappConnectError('WHATSAPP_CONNECT_INVALID_REQUEST'),
});

/** The merchant's own WhatsApp number, for signed-in members. */
@Controller('api/whatsapp-sender')
@UseGuards(DualAuthGuard)
export class WhatsappSenderController {
  constructor(
    private readonly sender: WhatsappSenderService,
    private readonly connect: WhatsappConnectService,
    private readonly status: ConnectionStatusService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getAvailability(
    @CurrentUser() user: AuthenticatedUser,
  ): WhatsappSenderAvailabilityDto {
    return this.sender.getAvailability(user);
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
