import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { getClientIp } from '../../shared/http/client-ip';
import {
  CompleteRegistrationDto,
  type CompleteRegistrationResponseDto,
} from './dto/complete-registration.dto';
import { MarketingEventsService } from './marketing-events.service';

/**
 * Ad conversions reported by the public site. Public on purpose: a new
 * account usually has no session until its email is confirmed. The answer is
 * the same whatever happens next, so it reveals nothing about accounts.
 */
@Controller('api/marketing-events')
export class MarketingEventsController {
  constructor(private readonly marketingEvents: MarketingEventsService) {}

  @Post('complete-registration')
  // Tighter than the app-wide limit, but not so tight that signups behind one
  // proxy address crowd each other out.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  completeRegistration(
    @Body() body: CompleteRegistrationDto,
    @Req() req: Request,
  ): CompleteRegistrationResponseDto {
    this.marketingEvents.acceptCompleteRegistration(body, {
      clientIp: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    return { accepted: true };
  }
}
