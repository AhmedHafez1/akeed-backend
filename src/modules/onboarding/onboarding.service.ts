import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import { isBillingStatusActive } from '../../shared/utils/billing.util';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../verification-core/credit-eligibility.service';
import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';
import { getBillingManagement } from '../../shared/billing/entitlement';
import { integrations } from '../../infrastructure/database/schema';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type {
  CompleteOnboardingSetupDto,
  OnboardingClientEventDto,
  OnboardingActivationDto,
  OnboardingUsageDto,
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
import { ONBOARDING_LANGUAGES } from './dto/onboarding.dto';
import { isAllowedAutomationTimezone } from './automation-timezone';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../auth/organization-role';

type IntegrationRecord = typeof integrations.$inferSelect;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly creditEligibility: CreditEligibilityService,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
    @Optional()
    private readonly messageDispatches?: VerificationMessageDispatchesRepository,
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
    this.assertCanUpdateConfiguration(user);
    await this.onboardingState.updateSettings(user, payload);
    return this.getState(user);
  }

  /**
   * Quick setup is the whole of onboarding v2: saving it activates Starter
   * without a plan picker and takes the store live, so the first real COD
   * order is confirmed even if the merchant never finishes the test step.
   */
  async completeSetup(
    user: AuthenticatedUser,
    payload: CompleteOnboardingSetupDto,
  ): Promise<OnboardingStateDto> {
    this.assertCanUpdateConfiguration(user);
    await this.onboardingState.updateSettings(user, {
      storeName: payload.storeName,
      defaultLanguage: payload.defaultLanguage,
      isAutoVerifyEnabled: payload.isAutoVerifyEnabled,
      merchantWhatsappPhone: payload.merchantWhatsappPhone,
    });
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    if (!integration.merchantWhatsappPhone) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'A WhatsApp number is required to receive the test message.',
        code: 'ONBOARDING_INVALID_PHONE',
      });
    }

    const starter =
      await this.billingService.activateStarterSilently(integration);
    await this.onboardingState.markOnboardingCompleted(integration.id);
    await this.adminLifecycles?.reachMilestone(
      integration.id,
      'setupCompletedAt',
      'setup_completed',
      {
        provenance: { setup_completed: 'captured_exact' },
        props: { starter, autoConfirm: payload.isAutoVerifyEnabled },
      },
    );

    return this.getState(user);
  }

  async recordClientEvent(
    user: AuthenticatedUser,
    payload: OnboardingClientEventDto,
  ): Promise<void> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    await this.adminLifecycles?.recordEvent(
      integration.id,
      payload.name,
      payload.step ? { step: payload.step } : undefined,
    );
  }

  async getSettings(user: AuthenticatedUser): Promise<SettingsResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.onboardingState.prefillStoreNameIfMissing(integration);

    const [billingPlans, usage, messagesSentLast30Days] = await Promise.all([
      this.billingService.getBillingPlans(hydratedIntegration),
      this.getCurrentUsage(hydratedIntegration),
      this.countMessagesSentLast30Days(hydratedIntegration),
    ]);

    return {
      state: await this.buildState(user, hydratedIntegration),
      billing: {
        plans: billingPlans.plans,
        isFreePlanClaimed: billingPlans.isFreePlanClaimed,
        usage,
        messagesSentLast30Days,
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

    this.assertCanUpdateConfiguration(user);
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
    this.assertCanUpdateConfiguration(user);
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

  /** Sizes the plan recommendation on the Plan tab; 0 when unavailable. */
  private async countMessagesSentLast30Days(
    integration: IntegrationRecord,
  ): Promise<number> {
    if (!this.messageDispatches) return 0;
    return this.messageDispatches.countAcceptedSince({
      orgId: integration.orgId,
      integrationId: integration.id,
      since: new Date(Date.now() - THIRTY_DAYS_MS).toISOString(),
    });
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
    const canUpdateConfiguration = this.canUpdateConfiguration(user);
    const standalone = integration.platformType === 'standalone';
    const accountStatus = await this.creditEligibility.readStatus(integration);
    const blockedReasons = standalone
      ? this.getStandaloneBlockedReasons(integration, accountStatus)
      : [];

    const [activation, usage] = await Promise.all([
      this.readActivation(integration, state.isOnboardingComplete),
      this.readUsage(integration),
    ]);

    return {
      ...state,
      activation,
      usage,
      permissions: {
        canUpdateConfiguration,
        canCompleteOnboarding:
          user.source === 'supabase' && canUpdateConfiguration,
      },
      standaloneSetup: standalone
        ? {
            canComplete: blockedReasons.length === 0,
            blockedReasons,
            accountStatus,
          }
        : null,
    };
  }

  private async readActivation(
    integration: IntegrationRecord,
    isOnboardingComplete: boolean,
  ): Promise<OnboardingActivationDto> {
    const lifecycle = await this.adminLifecycles?.findCurrent(integration.id);
    const hasActivePlan =
      this.billingEntitlements.evaluateAccess(integration).allowed;
    const managesBilling = getBillingManagement(integration).canManageBilling;
    return {
      setupCompletedAt: lifecycle?.setupCompletedAt ?? null,
      testSentAt: lifecycle?.testSentAt ?? null,
      testConfirmedAt: lifecycle?.testConfirmedAt ?? null,
      testSkippedAt: lifecycle?.testSkippedAt ?? null,
      firstRealConfirmedAt: lifecycle?.firstRealConfirmedAt ?? null,
      isLive:
        isOnboardingComplete &&
        integration.isActive === true &&
        integration.isAutoVerifyEnabled &&
        hasActivePlan,
      needsPlan:
        isOnboardingComplete &&
        managesBilling &&
        !(
          integration.billingPlanId &&
          isBillingStatusActive(integration.billingStatus)
        ),
    };
  }

  private async readUsage(
    integration: IntegrationRecord,
  ): Promise<OnboardingUsageDto | null> {
    if (!integration.billingPlanId) return null;
    const entitlement =
      await this.billingEntitlements.readEntitlement(integration);
    return {
      used: entitlement.consumedCount,
      limit: entitlement.includedLimit,
      remaining: Math.max(
        0,
        entitlement.includedLimit - entitlement.consumedCount,
      ),
    };
  }

  private getStandaloneBlockedReasons(
    integration: IntegrationRecord,
    accountStatus: CreditAccountStatus | null,
  ): StandaloneSetupBlockedReason[] {
    const reasons: StandaloneSetupBlockedReason[] = [];
    if (integration.platformType !== 'standalone' || !integration.isActive) {
      reasons.push('source_invalid');
    }

    // A suspended account cannot send regardless of entitlement, so reporting
    // both reasons would just be noise.
    if (accountStatus === 'suspended') {
      reasons.push('account_suspended');
    } else if (!this.billingEntitlements.evaluateAccess(integration).allowed) {
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
    if (
      !isAllowedAutomationTimezone(
        integration.timezone,
        integration.shopTimezone,
      )
    ) {
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

  private canUpdateConfiguration(user: AuthenticatedUser): boolean {
    return canWriteOrganization(user.role);
  }

  private assertCanUpdateConfiguration(user: AuthenticatedUser): void {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to update configuration',
      code: 'ONBOARDING_CONFIGURATION_READ_ONLY',
    });
  }
}
