import {
  Controller,
  Get,
  Header,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConnectionStatusService } from '../whatsapp-sender/connection-status.service';
import type { WhatsappConnectionStaffViewDto } from '../whatsapp-sender/dto/whatsapp-connection-status.dto';
import { AdminAccessGuard } from './admin-access.guard';

/** A merchant's own-number setup and each template's outcome, for staff. */
@Controller('api/admin/whatsapp-connections')
@UseGuards(AdminAccessGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminWhatsappConnectionsController {
  constructor(private readonly status: ConnectionStatusService) {}

  @Get(':orgId')
  @Header('Cache-Control', 'private, no-store')
  async getConnection(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
  ): Promise<WhatsappConnectionStaffViewDto> {
    const view = await this.status.forStaff(orgId);
    if (!view)
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message: 'This organization has no WhatsApp connection.',
        code: 'WHATSAPP_CONNECTION_NOT_FOUND',
      });
    return view;
  }
}
