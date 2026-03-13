import {
  Body,
  Controller,
  Patch,
  Post,
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
import type { AuthenticatedUser } from '../guards/dual-auth.guard';
import { CurrentUser } from '../guards/current-user.decorator';

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
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: CreateOrganizationDto,
  ): Promise<{ organization: OrganizationResponseDto }> {
    const organization = await this.organizationsService.createOrganization(
      user.userId,
      payload,
    );

    return { organization };
  }

  @Patch('current')
  async updateCurrentOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: UpdateOrganizationDto,
  ): Promise<{ organization: OrganizationResponseDto }> {
    const organization =
      await this.organizationsService.updateCurrentOrganization(
        user.orgId,
        payload,
      );

    return { organization };
  }
}
