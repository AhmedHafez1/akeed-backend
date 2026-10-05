import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import type { RequestWithAdmin } from './admin.types';
import { AdminTemplateInspectionService } from './admin-template-inspection.service';
import { AdminTemplateTestSendService } from './admin-template-test-send.service';
import { AdminTemplatesService } from './admin-templates.service';
import { AdminTemplateMetricsQueryDto } from './dto/admin-query.dto';
import { AdminTemplateTestSendDto } from './dto/admin-templates.dto';
import { readRequestId } from './standalone-billing-operator.guard';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

/**
 * Staff template routes (E08). Every route sits behind `AdminAccessGuard`;
 * a route that writes or sends, the sync and the test send among them, also
 * needs a named template operator. Responses carry neutral values only: never
 * a token, the app secret or the provider's own error text.
 *
 * `GET api/admin/templates/metrics` belongs to `AdminController`, which is
 * registered first; `metrics` is not a valid key, so it never reaches `:key`.
 */
@Controller('api/admin/templates')
@UseGuards(AdminAccessGuard)
export class AdminTemplatesController {
  constructor(
    private readonly templates: AdminTemplatesService,
    private readonly inspection: AdminTemplateInspectionService,
    private readonly testSend: AdminTemplateTestSendService,
  ) {}

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

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(
    @Req() request: RequestWithAdmin,
    @Query() query: AdminTemplateMetricsQueryDto,
  ) {
    return this.inspection.list(request.admin.userId, query);
  }

  @Get(':key')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  detail(
    @Req() request: RequestWithAdmin,
    @Param('key') key: string,
    @Query() query: AdminTemplateMetricsQueryDto,
  ) {
    return this.inspection.detail(request.admin.userId, key, query);
  }

  @Post(':key/test-send')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendTest(
    @Req() request: RequestWithAdmin,
    @Param('key') key: string,
    @Body() body: AdminTemplateTestSendDto,
  ) {
    return this.testSend.send({
      userId: request.admin.userId,
      key,
      phone: body.phone,
      requestId: readRequestId(request),
    });
  }
}
