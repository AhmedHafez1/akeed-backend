import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminTipsCampaignsService } from './admin-tips-campaigns.service';
import type { RequestWithAdmin } from './admin.types';
import {
  AdminTipsCampaignCreateDto,
  AdminTipsCampaignUpdateDto,
  AdminTipsListQueryDto,
  AdminTipsOrganizationsQueryDto,
  AdminTipsPublishDto,
} from './dto/admin-tips-campaigns.dto';
import { readRequestId } from './standalone-billing-operator.guard';

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/** Tips and updates: dashboard cards admins publish to chosen merchants. */
@Controller('api/admin/tips-campaigns')
@UseGuards(AdminAccessGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class AdminTipsCampaignsController {
  constructor(private readonly campaigns: AdminTipsCampaignsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: AdminTipsListQueryDto) {
    return this.campaigns.list(query);
  }

  @Get('audience-options')
  @Header('Cache-Control', 'private, no-store')
  options() {
    return this.campaigns.getOptions();
  }

  @Get('audience/organizations')
  @Header('Cache-Control', 'private, no-store')
  organizations(@Query() query: AdminTipsOrganizationsQueryDto) {
    return this.campaigns.searchOrganizations(query);
  }

  @Post()
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  create(
    @Req() request: RequestWithAdmin,
    @Body() body: AdminTipsCampaignCreateDto,
  ) {
    return this.campaigns.create(this.audit(request), body);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AdminTipsCampaignUpdateDto,
  ) {
    return this.campaigns.update(this.audit(request), id, body);
  }

  @Get(':id/recipients')
  @Header('Cache-Control', 'private, no-store')
  recipients(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: AdminTipsOrganizationsQueryDto,
  ) {
    return this.campaigns.recipients(id, query);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  review(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.campaigns.review(this.audit(request), id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  publish(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AdminTipsPublishDto,
  ) {
    return this.campaigns.publish(this.audit(request), id, body.review_token);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  pause(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.campaigns.changeLifecycle(this.audit(request), id, 'pause');
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  resume(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.campaigns.changeLifecycle(this.audit(request), id, 'resume');
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Throttle(WRITE_THROTTLE)
  @Header('Cache-Control', 'private, no-store')
  archive(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.campaigns.changeLifecycle(this.audit(request), id, 'archive');
  }

  private audit(request: RequestWithAdmin) {
    return { userId: request.admin.userId, requestId: readRequestId(request) };
  }
}
