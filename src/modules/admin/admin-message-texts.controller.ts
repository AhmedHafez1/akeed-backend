import {
  Body,
  Controller,
  Get,
  Header,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminMessageTextsService } from './admin-message-texts.service';
import type { RequestWithAdmin } from './admin.types';
import { AdminMessageTextDto } from './dto/admin-message-texts.dto';
import { readRequestId } from './standalone-billing-operator.guard';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

/**
 * The free-form texts of US-08-07: acknowledgment, nudge and name fallbacks.
 * Staff read; a named template operator writes, with the same switch and
 * allowlist as template writes. Every change is audited.
 */
@Controller('api/admin/message-texts')
@UseGuards(AdminAccessGuard)
export class AdminMessageTextsController {
  constructor(private readonly texts: AdminMessageTextsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(@Req() request: RequestWithAdmin) {
    return this.texts.list(request.admin.userId);
  }

  @Put()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  save(@Req() request: RequestWithAdmin, @Body() body: AdminMessageTextDto) {
    return this.texts.save(request.admin.userId, body, readRequestId(request));
  }
}
