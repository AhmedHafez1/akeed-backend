import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
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
  StandaloneSetupBlockedReason,
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
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import {
  AUTOMATION_TIMEZONES,
  ONBOARDING_LANGUAGES,
} from './dto/onboarding.dto';

type IntegrationRecord = typeof integrations.$inferSelect;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
    private readonly billingEntitlements: BillingEntitlementService,
    @Optional()
    private readonly memberships?: MembershipsRepository,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.onboardingState.prefillStoreNameIfMissing(integration);
    return this.buildState(user, hydratedIntegration);
  }

  async updateSettings(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<OnboardingStateDto> {
    await this.assertCanUpdateConfiguration(user);
    await this.onboardingState.updateSettings(user, payload);
    return this.getState(user);
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
      state: await this.buildState(user, hydratedIntegration),
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
    await this.updateSettings(user, payload);
    return this.getSettings(user);
  }

  async completeStandaloneOnboarding(
    user: AuthenticatedUser,
  ): Promise<{ state: OnboardingStateDto }> {
    if (user.source !== 'supabase') {
      throw new ForbiddenException(
        'Standalone onboarding completion requires Supabase authentication',
      );
    }

    await this.assertCanUpdateConfiguration(user);
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const currentState = await this.buildState(user, integration);

    if (currentState.isOnboardingComplete) {
      return { state: currentState };
    }

    const blockedReasons = currentState.standaloneSetup?.blockedReasons ?? [
      'source_invalid',
    ];
    if (blockedReasons.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Standalone onboarding prerequisites are incomplete',
        code: 'ONBOARDING_BLOCKED',
        blockedReasons,
      });
    }

    await this.onboardingState.markOnboardingCompleted(integration.id);
    return { state: await this.getState(user) };
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

  private async buildState(
    user: AuthenticatedUser,
    integration: IntegrationRecord,
  ): Promise<OnboardingStateDto> {
    const state = this.onboardingState.toState(integration);
    const canUpdateConfiguration = await this.canUpdateConfiguration(user);
    const blockedReasons =
      integration.platformType === 'standalone'
        ? this.getStandaloneBlockedReasons(integration)
        : [];

    return {
      ...state,
      permissions: {
        canUpdateConfiguration,
        canCompleteOnboarding:
          user.source === 'supabase' && canUpdateConfiguration,
      },
      standaloneSetup:
        integration.platformType === 'standalone'
          ? {
              canComplete: blockedReasons.length === 0,
              blockedReasons,
            }
          : null,
    };
  }

  private getStandaloneBlockedReasons(
    integration: IntegrationRecord,
  ): StandaloneSetupBlockedReason[] {
    const reasons: StandaloneSetupBlockedReason[] = [];
    if (integration.platformType !== 'standalone' || !integration.isActive) {
      reasons.push('source_invalid');
    }

    if (!this.billingEntitlements.evaluateAccess(integration).allowed) {
      reasons.push('pilot_entitlement_missing');
    }

    if (!integration.storeName?.trim()) {
      reasons.push('merchant_name_missing');
    }
    if (!ONBOARDING_LANGUAGES.includes(integration.defaultLanguage)) {
      reasons.push('language_invalid');
    }
    if (typeof integration.assumeCodWhenPaymentMissing !== 'boolean') {
      reasons.push('cod_default_invalid');
    }
    if (!AUTOMATION_TIMEZONES.includes(integration.timezone as never)) {
      reasons.push('timezone_invalid');
    }

    const automationValid =
      typeof integration.isAutoVerifyEnabled === 'boolean' &&
      Number.isInteger(integration.sendDelayMinutes) &&
      integration.sendDelayMinutes >= 0 &&
      integration.sendDelayMinutes <= 1440 &&
      Number.isInteger(integration.followUpDelayMinutes) &&
      integration.followUpDelayMinutes >= 0 &&
      integration.followUpDelayMinutes <= 10080 &&
      Number.isInteger(integration.escalationDelayMinutes) &&
      integration.escalationDelayMinutes >= 0 &&
      integration.escalationDelayMinutes <= 10080 &&
      (!integration.followUpEnabled ||
        !integration.escalationEnabled ||
        integration.followUpDelayMinutes <
          integration.escalationDelayMinutes) &&
      (!integration.quietHoursEnabled ||
        (Boolean(integration.quietHoursStart) &&
          Boolean(integration.quietHoursEnd)));
    if (!automationValid) reasons.push('automation_invalid');

    return reasons;
  }

  private async canUpdateConfiguration(
    user: AuthenticatedUser,
  ): Promise<boolean> {
    if (user.source === 'shopify') return true;
    const membership = await this.memberships?.findByOrgAndUser(
      user.orgId,
      user.userId,
    );
    return membership?.role === 'owner' || membership?.role === 'admin';
  }

  private async assertCanUpdateConfiguration(
    user: AuthenticatedUser,
  ): Promise<void> {
    if (await this.canUpdateConfiguration(user)) return;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Owner or admin role is required to update configuration',
      code: 'ONBOARDING_CONFIGURATION_READ_ONLY',
    });
  }
}
