import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { RequestWithUser } from '../guards/dual-auth.guard';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import {
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
    @Request() req: RequestWithUser,
  ): Promise<{ state: OnboardingStateDto }> {
    const state = await this.onboardingService.getState(req.user);
    return { state };
  }

  @Patch('settings')
  async updateSettings(
    @Request() req: RequestWithUser,
    @Body() payload: UpdateOnboardingSettingsDto,
  ): Promise<{ state: OnboardingStateDto }> {
    const state = await this.onboardingService.updateSettings(
      req.user,
      payload,
    );
    return { state };
  }

  @Post('billing')
  async initiateBilling(
    @Request() req: RequestWithUser,
    @Body() payload: OnboardingBillingRequestDto,
  ): Promise<OnboardingBillingResponseDto> {
    return await this.onboardingService.initiateBilling(req.user, payload.host);
  }
}
