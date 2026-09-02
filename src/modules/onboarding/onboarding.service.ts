import { ForbiddenException, Injectable } from '@nestjs/common';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { getBillingManagement } from '../../shared/billing/entitlement';
import { integrations } from '../../infrastructure/database/schema';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type {
  OnboardingBillingPlanId,
  OnboardingBillingResponseDto,
  OnboardingBillingPlansResponseDto,
  OnboardingStateDto,
  SettingsResponseDto,
  UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService, type BillingCallbackParams } from './billing.service';
import {
  COD_TEMPLATE_DEFAULTS,
  getAvailableCodTemplateDefinitions,
  getArabicCodTemplateDefinition,
  getEnglishCodTemplateDefinition,
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
} from '../../shared/messaging/cod-template-catalog';

type IntegrationRecord = typeof integrations.$inferSelect;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
    private readonly billingEntitlements: BillingEntitlementService,
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

  async getSettings(user: AuthenticatedUser): Promise<SettingsResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.onboardingState.prefillStoreNameIfMissing(integration);

    const [billingPlans, usage] = await Promise.all([
      this.billingService.getBillingPlans(hydratedIntegration),
      this.getCurrentUsage(hydratedIntegration),
    ]);

    return {
      state: this.onboardingState.toState(hydratedIntegration),
      billing: {
        plans: billingPlans.plans,
        isFreePlanClaimed: billingPlans.isFreePlanClaimed,
        usage,
      },
      template: this.getTemplateSettings(hydratedIntegration),
    };
  }

  async updateSettingsResponse(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<SettingsResponseDto> {
    await this.onboardingState.updateSettings(user, payload);
    return this.getSettings(user);
  }

  async getBillingPlans(
    user: AuthenticatedUser,
  ): Promise<OnboardingBillingPlansResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    return this.billingService.getBillingPlans(integration);
  }

  async initiateBilling(
    user: AuthenticatedUser,
    planId: OnboardingBillingPlanId,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    if (!getBillingManagement(integration).canManageBilling) {
      throw new ForbiddenException(
        'Subscription billing is unavailable for this source',
      );
    }
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

  private async getCurrentUsage(
    integration: IntegrationRecord,
  ): Promise<SettingsResponseDto['billing']['usage']> {
    const entitlement =
      await this.billingEntitlements.readEntitlement(integration);
    return {
      used: entitlement.consumedCount,
      limit: entitlement.includedLimit,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    };
  }

  private getTemplateSettings(
    integration: IntegrationRecord,
  ): SettingsResponseDto['template'] {
    const selected = {
      ar: isArabicCodTemplateVariant(integration.codTemplateArVariant)
        ? integration.codTemplateArVariant
        : COD_TEMPLATE_DEFAULTS.ar,
      en: isEnglishCodTemplateVariant(integration.codTemplateEnVariant)
        ? integration.codTemplateEnVariant
        : COD_TEMPLATE_DEFAULTS.en,
    };
    const variants = getAvailableCodTemplateDefinitions();

    return {
      languages: ['ar', 'en'],
      defaultPreviewLanguage: 'en',
      defaults: COD_TEMPLATE_DEFAULTS,
      selected,
      variants,
      previews: {
        ar: getArabicCodTemplateDefinition(selected.ar).preview,
        en: getEnglishCodTemplateDefinition(selected.en).preview,
      },
    };
  }
}
