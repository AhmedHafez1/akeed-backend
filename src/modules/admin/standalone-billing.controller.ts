import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
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
import { PurchaseRefParamDto } from '../billing/dto/billing.dto';
import {
  AdjustmentApplyDto,
  AdjustmentPreviewDto,
  DispatchResolveDto,
  ProviderActionDto,
  PurchaseReconcileDto,
  RepairApplyDto,
} from './dto/standalone-billing-operations.dto';
import { StandaloneBillingLoggingInterceptor } from './standalone-billing-logging.interceptor';
import {
  readRequestId,
  StandaloneBillingOperatorGuard,
} from './standalone-billing-operator.guard';
import { StandaloneBillingOperationsService } from './standalone-billing-operations.service';
import { StandaloneBillingService } from './standalone-billing.service';
import {
  BillingFindingsQueryDto,
  BillingHealthQueryDto,
  BillingReconciliationRunDto,
  BillingSettlementDto,
  BillingSettlementsQueryDto,
} from './dto/billing-observability.dto';
import { BillingObservabilityService } from './billing-observability.service';

/** Writes that change billing state get a tighter budget than reads. */
const WRITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

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
    private readonly observability: BillingObservabilityService,
  ) {}

  @Get('health')
  @Header('Cache-Control', 'private, no-store')
  health(@Query() query: BillingHealthQueryDto) {
    return this.observability.health(query.from, query.to);
  }

  @Get('reconciliation/findings')
  @Header('Cache-Control', 'private, no-store')
  findings(@Query() query: BillingFindingsQueryDto) {
    return this.observability.listFindings(query);
  }

  @Post('reconciliation/runs')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  requestRun(
    @Req() request: RequestWithAdmin,
    @Body() body: BillingReconciliationRunDto,
  ) {
    return this.observability.requestRun(
      request.admin.userId,
      body.reason,
      readRequestId(request),
    );
  }

  @Get('settlements')
  @Header('Cache-Control', 'private, no-store')
  settlements(@Query() query: BillingSettlementsQueryDto) {
    return this.observability.listSettlements(query.limit, query.cursor);
  }

  @Post('settlements')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  recordSettlement(
    @Req() request: RequestWithAdmin,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: BillingSettlementDto,
  ) {
    return this.observability.recordSettlement({
      userId: request.admin.userId,
      idempotencyKey,
      settlement: body,
      requestId: readRequestId(request),
    });
  }

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
  async account(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
  ) {
    const [detail, findings] = await Promise.all([
      this.operations.accountDetail(request.admin.userId, orgId),
      this.observability.openFindingsForOrganization(orgId),
    ]);
    return { ...detail, findings };
  }

  @Post('accounts/:orgId/adjustments/preview')
  @Header('Cache-Control', 'private, no-store')
  previewAdjustment(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() body: AdjustmentPreviewDto,
  ) {
    return this.operations.previewAdjustment(
      request.admin.userId,
      orgId,
      body.quantity,
      readRequestId(request),
    );
  }

  @Post('accounts/:orgId/adjustments/apply')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  applyAdjustment(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: AdjustmentApplyDto,
  ) {
    return this.operations.applyAdjustment({
      userId: request.admin.userId,
      orgId,
      previewId: body.previewId,
      fingerprint: body.fingerprint,
      reason: body.reason,
      idempotencyKey,
      requestId: readRequestId(request),
    });
  }

  @Post('accounts/:orgId/projection-repair/preview')
  @Header('Cache-Control', 'private, no-store')
  previewRepair(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
  ) {
    return this.operations.previewRepair(
      request.admin.userId,
      orgId,
      readRequestId(request),
    );
  }

  @Post('accounts/:orgId/projection-repair/apply')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  applyRepair(
    @Req() request: RequestWithAdmin,
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() body: RepairApplyDto,
  ) {
    return this.operations.applyRepair({
      userId: request.admin.userId,
      orgId,
      previewId: body.previewId,
      fingerprint: body.fingerprint,
      reason: body.reason,
      requestId: readRequestId(request),
    });
  }

  @Post('dispatches/:dispatchId/resolve')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  resolveDispatch(
    @Req() request: RequestWithAdmin,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() body: DispatchResolveDto,
  ) {
    return this.operations.resolveDispatch({
      userId: request.admin.userId,
      orgId: body.orgId,
      dispatchId,
      resolution: body.resolution,
      providerMessageId:
        body.resolution === 'accepted' ? body.providerMessageId : undefined,
      evidence: body.evidence,
      reason: body.reason,
      requestId: readRequestId(request),
    });
  }

  @Post('purchases/:purchaseRef/reconcile')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  reconcilePurchase(
    @Req() request: RequestWithAdmin,
    @Param() params: PurchaseRefParamDto,
    @Body() body: PurchaseReconcileDto,
  ) {
    return this.operations.reconcilePurchase({
      userId: request.admin.userId,
      orgId: body.orgId,
      reference: params.purchaseRef,
      reason: body.reason,
      requestId: readRequestId(request),
    });
  }

  @Post('purchases/:purchaseRef/provider-action')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StandaloneBillingOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  providerAction(
    @Req() request: RequestWithAdmin,
    @Param() params: PurchaseRefParamDto,
    @Body() body: ProviderActionDto,
  ) {
    return this.operations.recordProviderAction({
      userId: request.admin.userId,
      orgId: body.orgId,
      reference: params.purchaseRef,
      action: body.action,
      providerReference: body.providerReference,
      amountMinor: body.amountMinor,
      currency: body.currency,
      evidence: body.evidence,
      reason: body.reason,
      requestId: readRequestId(request),
    });
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
