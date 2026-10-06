import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
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
  TemplateStyleDto,
  UpdateOnboardingSettingsDto,
  StandaloneSetupBlockedReason,
} from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService, type BillingCallbackParams } from './billing.service';
import {
  findDefaultTemplate,
  resolveTemplate,
  selectableTemplates,
  storedTemplateKey,
} from '../../shared/messaging/template-selector';
import {
  COD_REMINDER_PURPOSE,
  type RegistryTemplate,
  type TemplateLanguage,
} from '../../shared/messaging/template-registry.types';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import { MESSAGE_IMPROVEMENT_SWITCHES_OFF } from '../../shared/config/whatsapp-template.config';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import { ONBOARDING_LANGUAGES } from './dto/onboarding.dto';
import { isAllowedAutomationTimezone } from './automation-timezone';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../auth/organization-role';
import { SourceSetupService } from './source-setup.service';
import type {
  SourceHealthDto,
  SourceSetupDto,
} from '../../shared/commerce/source-setup';

type IntegrationRecord = typeof integrations.$inferSelect;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One selectable style as the settings response has always carried it. The
 * field order is part of the response contract.
 */
function toTemplateStyleDto(template: RegistryTemplate): TemplateStyleDto {
  return {
    language: template.language,
    variant: template.style,
    metaTemplateName: template.templateName,
    metaLanguageCode: template.languageCode,
    bodyVariableMode: template.parameterFormat,
    bodyParameterOrder: template.variables.map(({ key }) => key),
    preview: template.preview,
  };
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly creditEligibility: CreditEligibilityService,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly templateRegistry: TemplateRegistryPort,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
    @Optional()
    private readonly messageDispatches?: VerificationMessageDispatchesRepository,
    @Optional()
    private readonly ordersRepo?: OrdersRepository,
    @Optional()
    private readonly sourceSetup?: SourceSetupService,
    @Optional()
    private readonly improvementSwitches?: MessageImprovementSwitches,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    const integration = await this.onboardingState.resolveCurrentIntegration(
      user,
      { allowDisconnected: true },
    );
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

  /**
   * The source's health as separate signals (US-06-05). Any member may read
   * it, and it stays readable after a disconnect: it holds no credential.
   */
  async getSourceHealth(user: AuthenticatedUser): Promise<SourceHealthDto> {
    if (!this.sourceSetup) throw new NotFoundException();
    const integration = await this.onboardingState.resolveCurrentIntegration(
      user,
      { allowDisconnected: true },
    );
    return this.sourceSetup.health(integration);
  }

  async getSettings(user: AuthenticatedUser): Promise<SettingsResponseDto> {
    const integration = await this.onboardingState.resolveCurrentIntegration(
      user,
      { allowDisconnected: true },
    );
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
      template: await this.getTemplateSettings(hydratedIntegration),
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

    const blockedReasons: string[] = currentState.standaloneSetup
      ?.blockedReasons ??
      currentState.sourceSetup?.blockedReasons ?? ['source_invalid'];
    if (blockedReasons.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Onboarding prerequisites are incomplete',
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

  /**
   * The styles a merchant may choose, from the registry. A stored choice that
   * is no longer selectable reads as the language default, which is also what
   * a send would use.
   */
  private async getTemplateSettings(
    integration: IntegrationRecord,
  ): Promise<SettingsResponseDto['template']> {
    const templates = await this.templateRegistry.listTemplates();
    const selectedTemplate = (language: TemplateLanguage) => {
      const resolution = resolveTemplate(templates, {
        language,
        storedKey: storedTemplateKey({
          language,
          key:
            language === 'ar'
              ? integration.codTemplateArKey
              : integration.codTemplateEnKey,
          legacyVariant:
            language === 'ar'
              ? integration.codTemplateArVariant
              : integration.codTemplateEnVariant,
        }),
      });
      return this.requireTemplate(resolution.template, language);
    };
    const defaultTemplate = (language: TemplateLanguage) =>
      this.requireTemplate(findDefaultTemplate(templates, language), language);
    const selected = { ar: selectedTemplate('ar'), en: selectedTemplate('en') };

    return {
      languages: ['ar', 'en'],
      defaultPreviewLanguage: 'en',
      defaults: {
        ar: defaultTemplate('ar').style,
        en: defaultTemplate('en').style,
      },
      selected: { ar: selected.ar.style, en: selected.en.style },
      variants: {
        ar: selectableTemplates(templates, 'ar').map(toTemplateStyleDto),
        en: selectableTemplates(templates, 'en').map(toTemplateStyleDto),
      },
      previews: { ar: selected.ar.preview, en: selected.en.preview },
      ...this.messageImprovementSettings(templates, integration),
    };
  }

  /**
   * The US-08-07 choices, each present only while its switch is on, so the
   * response is unchanged with both off.
   */
  private messageImprovementSettings(
    templates: readonly RegistryTemplate[],
    integration: IntegrationRecord,
  ): Pick<SettingsResponseDto['template'], 'reminder' | 'arabicAuto'> {
    const switches =
      this.improvementSwitches?.current() ?? MESSAGE_IMPROVEMENT_SWITCHES_OFF;
    const reminders = (language: TemplateLanguage) =>
      selectableTemplates(templates, language, COD_REMINDER_PURPOSE);
    // A stored reminder that is no longer selectable reads as "same as the
    // first message"; the send then uses the reminder default or the first
    // message, and records why.
    const selectedReminder = (language: TemplateLanguage) => {
      const key =
        language === 'ar'
          ? integration.codReminderArKey
          : integration.codReminderEnKey;
      return reminders(language).find((row) => row.key === key)?.style ?? null;
    };
    return {
      ...(switches.reminderTemplate
        ? {
            reminder: {
              selected: {
                ar: selectedReminder('ar'),
                en: selectedReminder('en'),
              },
              variants: {
                ar: reminders('ar').map(toTemplateStyleDto),
                en: reminders('en').map(toTemplateStyleDto),
              },
            },
          }
        : {}),
      ...(switches.arabicStyleAuto
        ? { arabicAuto: { selected: integration.codTemplateArAuto === true } }
        : {}),
    };
  }

  private requireTemplate(
    template: RegistryTemplate | null | undefined,
    language: TemplateLanguage,
  ): RegistryTemplate {
    if (!template) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: `No default message template is available for ${language}`,
        code: 'SETTINGS_TEMPLATE_DEFAULT_UNAVAILABLE',
      });
    }
    return template;
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

    const [activation, usage, sourceSetup] = await Promise.all([
      this.readActivation(integration, state.isOnboardingComplete),
      this.readUsage(integration),
      this.readSourceSetup(integration, accountStatus),
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
      // Present only for a source whose spoke describes its connection, so
      // every other source's response is exactly what it was.
      ...(sourceSetup ? { sourceSetup } : {}),
    };
  }

  private async readSourceSetup(
    integration: IntegrationRecord,
    accountStatus: CreditAccountStatus | null,
  ): Promise<SourceSetupDto | null> {
    const contribution = await this.sourceSetup?.describe(integration);
    if (!this.sourceSetup || !contribution) return null;
    // A disconnected source has one thing to fix; the common checks would
    // only add noise that reconnecting clears by itself.
    const blockedReasons =
      contribution.connectionState === 'disconnected'
        ? contribution.blockedReasons
        : [
            ...this.getCommonBlockedReasons(integration, accountStatus),
            ...contribution.blockedReasons,
          ];
    return {
      connectionState: contribution.connectionState,
      disconnectedAt: contribution.disconnectedAt,
      store: contribution.store,
      orderDefaults: contribution.orderDefaults,
      sender: this.sourceSetup.senderStatus(),
      canComplete: blockedReasons.length === 0,
      blockedReasons,
    };
  }

  private async readActivation(
    integration: IntegrationRecord,
    isOnboardingComplete: boolean,
  ): Promise<OnboardingActivationDto> {
    const [lifecycle, hasRealOrders] = await Promise.all([
      this.adminLifecycles?.findCurrent(integration.id),
      // Without the repository (unit wiring) assume orders exist, so no
      // merchant is ever held in the first-run dashboard by mistake.
      this.ordersRepo?.hasRealOrders(integration.orgId) ?? true,
    ]);
    const hasActivePlan =
      this.billingEntitlements.evaluateAccess(integration).allowed;
    const managesBilling = getBillingManagement(integration).canManageBilling;
    return {
      setupCompletedAt: lifecycle?.setupCompletedAt ?? null,
      testSentAt: lifecycle?.testSentAt ?? null,
      testConfirmedAt: lifecycle?.testConfirmedAt ?? null,
      testSkippedAt: lifecycle?.testSkippedAt ?? null,
      firstRealConfirmedAt: lifecycle?.firstRealConfirmedAt ?? null,
      hasRealOrders,
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
    reasons.push(...this.getCommonBlockedReasons(integration, accountStatus));
    return reasons;
  }

  /** The setup checks every source shares, whatever platform it is. */
  private getCommonBlockedReasons(
    integration: IntegrationRecord,
    accountStatus: CreditAccountStatus | null,
  ): StandaloneSetupBlockedReason[] {
    const reasons: StandaloneSetupBlockedReason[] = [];

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
