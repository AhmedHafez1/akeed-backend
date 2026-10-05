import { Controller, Get, Header, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import type { RequestWithAdmin } from './admin.types';
import { AdminTemplatesService } from './admin-templates.service';
import { readRequestId } from './standalone-billing-operator.guard';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

/**
 * Staff template routes (E08). Every route sits behind `AdminAccessGuard`;
 * a route that writes, the sync among them, also needs a named template
 * operator. Responses carry neutral values only: never a token, the app
 * secret or the provider's own error text.
 */
@Controller('api/admin/templates')
@UseGuards(AdminAccessGuard)
export class AdminTemplatesController {
  constructor(private readonly templates: AdminTemplatesService) {}

  @Post('sync')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  runSync(@Req() request: RequestWithAdmin) {
    return this.templates.runSync(request.admin.userId, readRequestId(request));
  }

  @Get('sync/runs')
  @Header('Cache-Control', 'private, no-store')
  syncRuns() {
    return this.templates.recentRuns();
  }
}
