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
    return this.connect.claimTicket(
      (body as ClaimWhatsappConnectTicketDto).ticket,
    );
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
