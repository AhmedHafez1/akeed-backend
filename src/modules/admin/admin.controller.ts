import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminStoresService } from './admin-stores.service';
import type { RequestWithAdmin } from './admin.types';
import {
  AdminFunnelQueryDto,
  AdminStoresQueryDto,
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
  ) {}

  @Get('session')
  @Header('Cache-Control', 'private, no-store')
  getSession(@Req() request: RequestWithAdmin) {
    return {
      authenticated: true,
      role: 'admin',
      user_id: request.admin.userId,
      feature_enabled: true,
    };
  }

  @Get('stores')
  @Header('Cache-Control', 'private, no-store')
  getStores(@Query() query: AdminStoresQueryDto) {
    return this.storesService.getStores(query);
  }

  @Get('funnel')
  @Header('Cache-Control', 'private, no-store')
  getFunnel(@Query() query: AdminFunnelQueryDto) {
    return this.funnelService.getFunnel(query);
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
