import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import {
  isWhatsappTemplateOperator,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminStoresService } from './admin-stores.service';
import { AdminTemplateMetricsService } from './admin-template-metrics.service';
import type { RequestWithAdmin } from './admin.types';
import {
  AdminFunnelQueryDto,
  AdminStoreVerificationsQueryDto,
  AdminStoresQueryDto,
  AdminTemplateMetricsQueryDto,
} from './dto/admin-query.dto';
import { MessageDispatchResolutionDto } from './dto/message-dispatch-resolution.dto';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';

@Controller('api/admin')
@UseGuards(AdminAccessGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminController {
  constructor(
    private readonly storesService: AdminStoresService,
    private readonly funnelService: AdminFunnelService,
    private readonly dispatchResolution: MessageDispatchResolutionService,
    private readonly templateMetrics: AdminTemplateMetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get('session')
  @Header('Cache-Control', 'private, no-store')
  getSession(@Req() request: RequestWithAdmin) {
    const templates = readWhatsappTemplateConfig(this.config);
    return {
      authenticated: true,
      role: 'admin',
      user_id: request.admin.userId,
      feature_enabled: true,
      // So the UI can hide template write controls; the backend refuses
      // them for anyone else whatever the UI shows (US-08-06 criterion 1).
      template_operations: {
        enabled: templates.operationsEnabled,
        operator: isWhatsappTemplateOperator(templates, request.admin.userId),
      },
    };
  }

  @Get('stores')
  @Header('Cache-Control', 'private, no-store')
  getStores(@Query() query: AdminStoresQueryDto) {
    return this.storesService.getStores(query);
  }

  @Get('stores/:integrationId')
  @Header('Cache-Control', 'private, no-store')
  getStore(@Param('integrationId', new ParseUUIDPipe()) integrationId: string) {
    return this.storesService.getStore(integrationId);
  }

  @Get('stores/:integrationId/verifications')
  @Header('Cache-Control', 'private, no-store')
  getStoreVerifications(
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
    @Query() query: AdminStoreVerificationsQueryDto,
  ) {
    return this.storesService.getStoreVerifications(integrationId, query);
  }

  @Get('funnel')
  @Header('Cache-Control', 'private, no-store')
  getFunnel(@Query() query: AdminFunnelQueryDto) {
    return this.funnelService.getFunnel(query);
  }

  @Get('templates/metrics')
  @Header('Cache-Control', 'private, no-store')
  getTemplateMetrics(@Query() query: AdminTemplateMetricsQueryDto) {
    return this.templateMetrics.getMetrics(query);
  }

  @Post('message-dispatches/:dispatchId/resolve')
  @Header('Cache-Control', 'private, no-store')
  resolveMessageDispatch(
    @Req() request: RequestWithAdmin,
    @Param('dispatchId') dispatchId: string,
    @Body() body: MessageDispatchResolutionDto,
  ) {
    return this.dispatchResolution.resolve(
      request.admin.userId,
      dispatchId,
      body,
    );
  }
}
