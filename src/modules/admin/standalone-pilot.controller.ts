import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAccessGuard } from './admin-access.guard';
import type { RequestWithAdmin } from './admin.types';
import {
  StandalonePilotApplyDto,
  StandalonePilotListDto,
  StandalonePilotPreviewDto,
} from './dto/standalone-pilot.dto';
import { StandalonePilotService } from './standalone-pilot.service';

@Controller('api/admin/standalone-pilots')
@UseGuards(AdminAccessGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class StandalonePilotController {
  constructor(private readonly pilots: StandalonePilotService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: StandalonePilotListDto) {
    return this.pilots.list(query.limit, query.cursor);
  }
  @Post('preview')
  @Header('Cache-Control', 'private, no-store')
  preview(
    @Req() request: RequestWithAdmin,
    @Body() body: StandalonePilotPreviewDto,
  ) {
    return this.pilots.preview(request.admin.userId, body.organizationIds);
  }
  @Post('apply')
  @Header('Cache-Control', 'private, no-store')
  apply(
    @Req() request: RequestWithAdmin,
    @Body() body: StandalonePilotApplyDto,
  ) {
    return this.pilots.apply(request.admin.userId, body.previewId, body.reason);
  }
}
