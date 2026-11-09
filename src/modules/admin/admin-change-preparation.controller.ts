import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';
import { AdminChangePreparationService } from './admin-change-preparation.service';
import { readRequestId } from './standalone-billing-operator.guard';
import type { RequestWithAdmin } from './admin.types';

@Controller('api/admin/templates/change-requests')
@UseGuards(AdminAccessGuard)
export class AdminChangePreparationController {
  constructor(private readonly preparation: AdminChangePreparationService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  overview() {
    return this.preparation.overview();
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  prepare(@Req() request: RequestWithAdmin) {
    return this.preparation.prepare(
      request.admin.userId,
      readRequestId(request),
    );
  }
}
