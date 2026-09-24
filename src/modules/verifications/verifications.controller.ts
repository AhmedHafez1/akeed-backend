import type { CancelOrderResponse } from '../../shared/commerce/commerce-outcome';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import {
  VerificationsService,
  type ManualConfirmationResponse,
} from './verifications.service';
import { TestVerificationService } from './test-verification.service';
import { SendTestVerificationDto } from './dto/send-test-verification.dto';
import {
  GetVerificationOverviewQueryDto,
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  PaginatedResponse,
  VerificationListItemDto,
  VerificationOverviewDto,
  VerificationStatsDto,
} from '../orders/dto/dashboard.dto';
import { canWriteOrganization } from '../auth/organization-role';

@Controller('api/verifications')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class VerificationsController {
  constructor(
    private readonly verificationsService: VerificationsService,
    private readonly testVerificationService: TestVerificationService,
  ) {}

  @Get('stats')
  async getVerificationStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetVerificationStatsQueryDto,
  ): Promise<{ stats: VerificationStatsDto }> {
    const stats = await this.verificationsService.getStatsByOrg(
      user.orgId,
      query,
    );

    return { stats };
  }

  @Get('overview')
  async getVerificationOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetVerificationOverviewQueryDto,
  ): Promise<{ overview: VerificationOverviewDto }> {
    const overview = await this.verificationsService.getOverview(
      user.orgId,
      query,
    );
    return {
      overview: {
        ...overview,
        permissions: { can_confirm_orders: canWriteOrganization(user.role) },
      },
    };
  }

  @Get()
  async listVerifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetVerificationsQueryDto,
  ): Promise<PaginatedResponse<VerificationListItemDto>> {
    const result = await this.verificationsService.listByOrg(user.orgId, query);
    const canWrite = canWriteOrganization(user.role);
    return {
      ...result,
      page_context: result.page_context
        ? {
            ...result.page_context,
            permissions: {
              can_send_test_verification: canWrite,
              can_cancel_orders: canWrite,
              can_create_manual_order: canWrite,
              can_retry_verifications: canWrite,
            },
          }
        : undefined,
    };
  }

  @Post('test')
  async sendTestVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendTestVerificationDto,
  ): Promise<{
    success: boolean;
    skipped?: boolean;
    reason?: string;
    orderId?: string;
    verificationId?: string;
  }> {
    const result = await this.testVerificationService.sendTestVerification(
      user,
      body.customerPhone,
    );

    if (result.skipped) {
      return {
        success: true,
        skipped: true,
        reason: result.reason,
      };
    }

    return {
      success: true,
      orderId: result.orderId,
      verificationId: result.verificationId,
    };
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirmManually(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
  ): Promise<ManualConfirmationResponse> {
    return this.verificationsService.confirmManually(user, verificationId);
  }

  @Post(':id/cancel')
  async cancelNoReplyOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') verificationId: string,
  ): Promise<CancelOrderResponse & { shopifyJobId?: string }> {
    const result = await this.verificationsService.cancelNoReplyOrder(
      user,
      verificationId,
    );
    return {
      ...result,
      ...(result.providerOperationId
        ? { shopifyJobId: result.providerOperationId }
        : {}),
    };
  }
}
