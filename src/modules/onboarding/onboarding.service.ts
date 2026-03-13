import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type {
  OnboardingBillingPlanId,
  OnboardingBillingResponseDto,
  OnboardingBillingPlansResponseDto,
  OnboardingStateDto,
  UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService, type BillingCallbackParams } from './billing.service';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    return this.onboardingState.getState(user);
  }

  async updateSettings(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<OnboardingStateDto> {
    return this.onboardingState.updateSettings(user, payload);
  }

  async getBillingPlans(
    user: AuthenticatedUser,
  ): Promise<OnboardingBillingPlansResponseDto> {
    // Ensure the requester belongs to a valid Shopify integration context.
    await this.onboardingState.resolveCurrentIntegration(user);
    return this.billingService.getBillingPlans();
  }

  async initiateBilling(
    user: AuthenticatedUser,
    planId: OnboardingBillingPlanId,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.onboardingState.prefillStoreNameIfMissing(integration);
    this.onboardingState.ensureBillingPrerequisitesMet(hydratedIntegration);
    return this.billingService.initiateBilling(
      hydratedIntegration,
      planId,
      host,
    );
  }

  async handleBillingCallback(params: BillingCallbackParams): Promise<string> {
    return this.billingService.handleBillingCallback(params);
  }
}
