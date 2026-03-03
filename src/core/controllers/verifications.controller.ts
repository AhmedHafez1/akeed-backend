import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  RequestWithUser,
} from '../guards/dual-auth.guard';
import { CurrentUser } from '../guards/current-user.decorator';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import { VerificationsService } from '../services/verifications.service';
import {
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  VerificationListItemDto,
  VerificationStatsDto,
} from '../dto/dashboard.dto';

@Controller('api/verifications')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class VerificationsController {
  constructor(private readonly verificationsService: VerificationsService) {}

  @Get('stats')
  async getVerificationStats(
    @Request() req: RequestWithUser,
    @Query() query: GetVerificationStatsQueryDto,
  ): Promise<{ stats: VerificationStatsDto }> {
    const stats = await this.verificationsService.getStatsByOrg(
      req.user.orgId,
      query,
    );

    return { stats };
  }

  @Get()
  async listVerifications(
    @Request() req: RequestWithUser,
    @Query() query: GetVerificationsQueryDto,
  ): Promise<{ verifications: VerificationListItemDto[] }> {
    const verifications = await this.verificationsService.listByOrg(
      req.user.orgId,
      query,
    );

    return { verifications };
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

    const result = await this.verificationsService.sendTestVerification(
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
