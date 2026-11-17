import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ClaimWhatsappConnectTicketDto,
  CompleteWhatsappSignupDto,
  RelaunchWhatsappSignupDto,
  type WhatsappConnectTicketClaimedDto,
  type WhatsappSignupCompletedDto,
} from './dto/whatsapp-connect.dto';
import { whatsappConnectError } from './whatsapp-connect.errors';
import { WhatsappConnectService } from './whatsapp-connect.service';

function codedPipe(expectedType: new () => object): ValidationPipe {
  return new ValidationPipe({
    expectedType,
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: () =>
      whatsappConnectError('WHATSAPP_CONNECT_INVALID_REQUEST'),
  });
}

export const claimWhatsappConnectTicketPipe = codedPipe(
  ClaimWhatsappConnectTicketDto,
);
export const completeWhatsappSignupPipe = codedPipe(CompleteWhatsappSignupDto);
export const relaunchWhatsappSignupPipe = codedPipe(RelaunchWhatsappSignupDto);

/**
 * The connect page, which runs outside any Akeed or Shopify session. Each
 * request is authenticated by a single-use ticket in its body, never in the
 * URL, and the service derives the organization and member from that ticket.
 */
@Controller('api/whatsapp-connect')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class WhatsappConnectController {
  constructor(private readonly connect: WhatsappConnectService) {}

  @Post('claim')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  claim(
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with the connect code.
    @Body(claimWhatsappConnectTicketPipe) body: object,
  ): Promise<WhatsappConnectTicketClaimedDto> {
    const { ticket, locale } = body as ClaimWhatsappConnectTicketDto;
    return this.connect.claimTicket(ticket, locale);
  }

  @Post('relaunch')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  relaunch(
    @Body(relaunchWhatsappSignupPipe) body: object,
  ): Promise<WhatsappConnectTicketClaimedDto> {
    const { signupTicket, locale } = body as RelaunchWhatsappSignupDto;
    return this.connect.relaunchSignup(signupTicket, locale);
  }

  @Post('complete')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  complete(
    @Body(completeWhatsappSignupPipe) body: object,
  ): Promise<WhatsappSignupCompletedDto> {
    return this.connect.completeSignup(body as CompleteWhatsappSignupDto);
  }
}
