import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../guards/dual-auth.guard';
import { CurrentUser } from '../guards/current-user.decorator';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import {
  OnboardingBillingPlansResponseDto,
  OnboardingBillingRequestDto,
  OnboardingBillingResponseDto,
  OnboardingStateDto,
  UpdateOnboardingSettingsDto,
} from '../dto/onboarding.dto';
import { OnboardingService } from '../services/onboarding.service';

@Controller('api/onboarding')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('state')
  async getState(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ state: OnboardingStateDto }> {
    const state = await this.onboardingService.getState(user);
    return { state };
  }

  @Patch('settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: UpdateOnboardingSettingsDto,
  ): Promise<{ state: OnboardingStateDto }> {
    const state = await this.onboardingService.updateSettings(user, payload);
    return { state };
  }

  @Post('billing')
  async initiateBilling(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: OnboardingBillingRequestDto,
  ): Promise<OnboardingBillingResponseDto> {
    const billingResponse: OnboardingBillingResponseDto =
      await this.onboardingService.initiateBilling(
        user,
        payload.planId,
        payload.host,
      );
    return billingResponse;
  }

  @Get('billing/plans')
  async getBillingPlans(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OnboardingBillingPlansResponseDto> {
    const plansResponse: OnboardingBillingPlansResponseDto =
      await this.onboardingService.getBillingPlans(user);
    return plansResponse;
  }
}
