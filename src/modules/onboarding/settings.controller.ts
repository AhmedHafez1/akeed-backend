import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import type { SettingsResponseDto } from './dto/onboarding.dto';
import { UpdateOnboardingSettingsDto } from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@Controller('api/settings')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class SettingsController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get()
  async getSettings(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SettingsResponseDto> {
    return this.onboardingService.getSettings(user);
  }

  @Patch()
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: UpdateOnboardingSettingsDto,
  ): Promise<SettingsResponseDto> {
    return this.onboardingService.updateSettingsResponse(user, payload);
  }
}
