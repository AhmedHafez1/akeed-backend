import {
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { RequestWithUser } from '../guards/dual-auth.guard';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import { VerificationsService } from '../services/verifications.service';
import {
  GetVerificationsQueryDto,
  VerificationListItemDto,
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
}
