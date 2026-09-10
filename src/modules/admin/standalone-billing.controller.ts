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
  UseInterceptors,
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
import { StandaloneBillingLoggingInterceptor } from './standalone-billing-logging.interceptor';
import { StandaloneBillingOperationsService } from './standalone-billing-operations.service';
import { StandaloneBillingService } from './standalone-billing.service';

/**
 * Staff billing console. Every route sits behind `AdminAccessGuard` (feature
 * flag, staff role, AAL2, per-request audit); routes that change billing state
 * additionally require a named operator.
 */
@Controller('api/admin/standalone-billing')
@UseGuards(AdminAccessGuard)
@UseInterceptors(StandaloneBillingLoggingInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class StandaloneBillingController {
  constructor(
    private readonly billing: StandaloneBillingService,
    private readonly operations: StandaloneBillingOperationsService,
  ) {}

  @Get('accounts')
  @Header('Cache-Control', 'private, no-store')
  accounts(
    @Req() request: RequestWithAdmin,
    @Query() query: StandaloneBillingAccountsDto,
  ) {
    return this.billing.list(request.admin.userId, query);
  }

  @Get('accounts/:orgId')
  @Header('Cache-Control', 'private, no-store')
  account(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
  ) {
    return this.operations.accountDetail(request.admin.userId, orgId);
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
