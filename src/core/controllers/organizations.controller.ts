import {
  Body,
  Controller,
  Patch,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  CreateOrganizationDto,
  OrganizationResponseDto,
  UpdateOrganizationDto,
} from '../dto/organizations.dto';
import { OrganizationsService } from '../services/organizations.service';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import { AllowOrgless } from '../guards/orgless.decorator';
import type { RequestWithUser } from '../guards/dual-auth.guard';

@Controller('api/organizations')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @AllowOrgless()
  async createOrganization(
    @Request() req: RequestWithUser,
    @Body() payload: CreateOrganizationDto,
  ): Promise<{ organization: OrganizationResponseDto }> {
    const organization = await this.organizationsService.createOrganization(
      req.user.userId,
      payload,
    );

    return { organization };
  }

  @Patch('current')
  async updateCurrentOrganization(
    @Request() req: RequestWithUser,
    @Body() payload: UpdateOrganizationDto,
  ): Promise<{ organization: OrganizationResponseDto }> {
    const organization =
      await this.organizationsService.updateCurrentOrganization(
        req.user.orgId,
        payload,
      );

    return { organization };
  }
}
