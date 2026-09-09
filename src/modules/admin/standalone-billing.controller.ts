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
  StandaloneApprovalApplyDto,
  StandaloneApprovalPreviewDto,
  StandaloneBillingAccountsDto,
} from './dto/standalone-billing.dto';
import { StandaloneBillingService } from './standalone-billing.service';

@Controller('api/admin/standalone-billing')
@UseGuards(AdminAccessGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class StandaloneBillingController {
  constructor(private readonly billing: StandaloneBillingService) {}
  @Get('accounts')
  @Header('Cache-Control', 'private, no-store')
  accounts(@Query() query: StandaloneBillingAccountsDto) {
    return this.billing.list(query.limit, query.cursor, query.approval);
  }
  @Post('approvals/preview')
  @Header('Cache-Control', 'private, no-store')
  preview(
    @Req() request: RequestWithAdmin,
    @Body() body: StandaloneApprovalPreviewDto,
  ) {
    return this.billing.preview(request.admin.userId, body.organizationIds);
  }
  @Post('approvals/apply')
  @Header('Cache-Control', 'private, no-store')
  apply(
    @Req() request: RequestWithAdmin,
    @Body() body: StandaloneApprovalApplyDto,
  ) {
    return this.billing.apply(
      request.admin.userId,
      body.previewId,
      body.reason,
    );
  }
}
