import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import type { WhatsappSenderAvailabilityDto } from './dto/whatsapp-sender.dto';
import { WhatsappSenderService } from './whatsapp-sender.service';

/** The merchant's own WhatsApp number, for signed-in members. */
@Controller('api/whatsapp-sender')
@UseGuards(DualAuthGuard)
export class WhatsappSenderController {
  constructor(private readonly sender: WhatsappSenderService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getAvailability(
    @CurrentUser() user: AuthenticatedUser,
  ): WhatsappSenderAvailabilityDto {
    return this.sender.getAvailability(user);
  }
}
