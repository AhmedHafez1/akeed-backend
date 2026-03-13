import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { VerificationsService } from './verifications.service';
import { TestVerificationService } from './test-verification.service';
import {
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  PaginatedResponse,
  VerificationListItemDto,
  VerificationStatsDto,
} from '../orders/dto/dashboard.dto';

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

  @Get()
  async listVerifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetVerificationsQueryDto,
  ): Promise<PaginatedResponse<VerificationListItemDto>> {
    return this.verificationsService.listByOrg(user.orgId, query);
  }

  @Post('test')
  async sendTestVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { customerPhone?: string },
  ): Promise<{
    success: boolean;
    skipped?: boolean;
    reason?: string;
    orderId?: string;
    verificationId?: string;
  }> {
    if (!body.customerPhone) {
      throw new BadRequestException('customerPhone is required.');
    }

    const result = await this.testVerificationService.sendTestVerification(
      user.orgId,
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
}
