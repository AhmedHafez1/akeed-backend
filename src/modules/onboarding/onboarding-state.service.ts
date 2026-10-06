import { getBillingManagement } from '../../shared/billing/entitlement';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { integrations } from '../../infrastructure/database/schema';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import {
  ONBOARDING_LANGUAGES,
  ONBOARDING_STATUSES,
  STORE_NAME_MAX_LENGTH,
  type AutomationTimezone,
  type OnboardingStateDto,
  type UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import {
  isAllowedAutomationTimezone,
  isValidIanaTimezone,
} from './automation-timezone';
import { resolveTemplateLanguageForPhone } from '../../shared/messaging/template-language';
import { isLegacyVariant } from '../../shared/messaging/template-legacy-variants';
import { resolveShippingCurrency } from './shipping-currency';
import {
  STORE_PLATFORM_PORT,
  type StorePlatformPort,
} from '../../shared/ports/store-platform.port';
import { findSelectableByStyle } from '../../shared/messaging/template-selector';
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
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import {
  resolveFallbackActiveIntegration,
  resolveShopifyLinkedIntegration,
} from '../../shared/commerce/current-integration-resolver';
import { SourceSetupService } from './source-setup.service';

type IntegrationRecord = typeof integrations.$inferSelect;
const DEFAULT_AVG_SHIPPING_COST = 3;
const DEFAULT_FOLLOW_UP_ENABLED = true;
const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 120;
const DEFAULT_ESCALATION_ENABLED = true;
const DEFAULT_ESCALATION_DELAY_MINUTES = 360;
const DEFAULT_QUIET_HOURS_ENABLED = false;
const DEFAULT_TIMEZONE: AutomationTimezone = 'Asia/Riyadh';
const DEFAULT_SEND_DELAY_MINUTES = 0;

@Injectable()
export class OnboardingStateService {
  private readonly logger = new Logger(OnboardingStateService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    @Inject(STORE_PLATFORM_PORT)
    private readonly storePlatform: StorePlatformPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly templateRegistry: TemplateRegistryPort,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
    @Optional()
    private readonly phoneService: PhoneService = new PhoneService(),
    @Optional()
    private readonly organizationsRepo?: OrganizationsRepository,
    @Optional()
    private readonly sourceSetup?: SourceSetupService,
    @Optional()
    private readonly improvementSwitches?: MessageImprovementSwitches,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    const integration = await this.resolveCurrentIntegration(user, {
      allowDisconnected: true,
    });
    const hydratedIntegration =
      await this.prefillStoreNameIfMissing(integration);
    return this.toState(hydratedIntegration);
  }

  async updateSettings(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<OnboardingStateDto> {
    const integration = await this.resolveCurrentIntegration(user);
    const updates: Partial<typeof integrations.$inferInsert> = {
      storeName: payload.storeName.trim(),
      defaultLanguage: payload.defaultLanguage,
      isAutoVerifyEnabled: payload.isAutoVerifyEnabled,
    };

    if (payload.merchantWhatsappPhone !== undefined) {
      updates.merchantWhatsappPhone = this.normalizeMerchantPhone(
        payload.merchantWhatsappPhone,
      );
    }

    if (payload.assumeCodWhenPaymentMissing !== undefined) {
      updates.assumeCodWhenPaymentMissing = payload.assumeCodWhenPaymentMissing;
    }

    if (payload.shippingCurrency !== undefined) {
      updates.shippingCurrency = payload.shippingCurrency;
    }

    if (payload.avgShippingCost !== undefined) {
      updates.avgShippingCost = payload.avgShippingCost.toFixed(2);
    }

    // Automation settings
    if (payload.followUpEnabled !== undefined) {
      updates.followUpEnabled = payload.followUpEnabled;
    }
    if (payload.followUpDelayMinutes !== undefined) {
      updates.followUpDelayMinutes = payload.followUpDelayMinutes;
    }
    if (payload.escalationEnabled !== undefined) {
      updates.escalationEnabled = payload.escalationEnabled;
    }
    if (payload.escalationDelayMinutes !== undefined) {
      updates.escalationDelayMinutes = payload.escalationDelayMinutes;
    }
    if (payload.quietHoursEnabled !== undefined) {
      updates.quietHoursEnabled = payload.quietHoursEnabled;
    }
    if (payload.quietHoursStart !== undefined) {
      updates.quietHoursStart = payload.quietHoursStart;
    }
    if (payload.quietHoursEnd !== undefined) {
      updates.quietHoursEnd = payload.quietHoursEnd;
    }
    if (payload.timezone !== undefined) {
      if (
        !isAllowedAutomationTimezone(payload.timezone, integration.shopTimezone)
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message:
            'timezone must be a supported zone or the store timezone reported by the platform',
          code: 'SETTINGS_TIMEZONE_UNSUPPORTED',
        });
      }
      updates.timezone = payload.timezone.trim();
    }
    if (payload.sendDelayMinutes !== undefined) {
      updates.sendDelayMinutes = payload.sendDelayMinutes;
    }
    if (
      payload.codTemplateArVariant !== undefined ||
      payload.codTemplateEnVariant !== undefined ||
      payload.codReminderArVariant !== undefined ||
      payload.codReminderEnVariant !== undefined
    ) {
      const templates = await this.templateRegistry.listTemplates();
      if (payload.codTemplateArVariant !== undefined) {
        const template = this.requireSelectableStyle(
          templates,
          'ar',
          payload.codTemplateArVariant,
        );
        updates.codTemplateArKey = template.key;
        if (isLegacyVariant('ar', template.style)) {
          updates.codTemplateArVariant = template.style;
        }
      }
      if (payload.codTemplateEnVariant !== undefined) {
        const template = this.requireSelectableStyle(
          templates,
          'en',
          payload.codTemplateEnVariant,
        );
        updates.codTemplateEnKey = template.key;
        if (isLegacyVariant('en', template.style)) {
          updates.codTemplateEnVariant = template.style;
        }
      }
      if (payload.codReminderArVariant !== undefined) {
        updates.codReminderArKey = this.reminderKeyFor(
          templates,
          'ar',
          payload.codReminderArVariant,
        );
      }
      if (payload.codReminderEnVariant !== undefined) {
        updates.codReminderEnKey = this.reminderKeyFor(
          templates,
          'en',
          payload.codReminderEnVariant,
        );
      }
    }
    if (payload.codTemplateArAuto !== undefined) {
      if (payload.codTemplateArAuto && !this.switches().arabicStyleAuto) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: 'The automatic Arabic style is not available',
          code: 'SETTINGS_ARABIC_AUTO_UNAVAILABLE',
        });
      }
      updates.codTemplateArAuto = payload.codTemplateArAuto;
    }

    // Cross-field validation: followUpDelayMinutes < escalationDelayMinutes
    const resolvedFollowUpDelay =
      updates.followUpDelayMinutes ?? integration.followUpDelayMinutes;
    const resolvedEscalationDelay =
      updates.escalationDelayMinutes ?? integration.escalationDelayMinutes;
    const resolvedFollowUpEnabled =
      updates.followUpEnabled ?? integration.followUpEnabled;
    const resolvedEscalationEnabled =
      updates.escalationEnabled ?? integration.escalationEnabled;

    if (
      resolvedFollowUpEnabled &&
      resolvedEscalationEnabled &&
      resolvedFollowUpDelay >= resolvedEscalationDelay
    ) {
      throw new BadRequestException(
        'followUpDelayMinutes must be less than escalationDelayMinutes when both follow-up and escalation are enabled',
      );
    }

    // Cross-field validation: quiet hours require both start and end
    const resolvedQuietHoursEnabled =
      updates.quietHoursEnabled ?? integration.quietHoursEnabled;
    const resolvedQuietHoursStart =
      updates.quietHoursStart !== undefined
        ? updates.quietHoursStart
        : integration.quietHoursStart;
    const resolvedQuietHoursEnd =
      updates.quietHoursEnd !== undefined
        ? updates.quietHoursEnd
        : integration.quietHoursEnd;

    if (
      resolvedQuietHoursEnabled &&
      (!resolvedQuietHoursStart || !resolvedQuietHoursEnd)
    ) {
      throw new BadRequestException(
        'quietHoursStart and quietHoursEnd are required when quiet hours are enabled',
      );
    }

    // An empty window would be stored as "on" but never defer anything.
    if (
      resolvedQuietHoursEnabled &&
      resolvedQuietHoursStart === resolvedQuietHoursEnd
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'quietHoursStart and quietHoursEnd must be different',
        code: 'SETTINGS_QUIET_HOURS_EMPTY_WINDOW',
      });
    }

    const updated = await this.integrationsRepo.updateById(integration.id, {
      ...updates,
    });

    if (!updated) {
      throw new NotFoundException('Integration not found');
    }

    await this.adminLifecycles?.markMilestone(
      integration.id,
      'onboardingStartedAt',
      undefined,
      { onboarding_started: 'captured_exact' },
    );

    return this.toState(updated);
  }

  private switches() {
    return (
      this.improvementSwitches?.current() ?? MESSAGE_IMPROVEMENT_SWITCHES_OFF
    );
  }

  /**
   * A reminder style, or null for "same as the first message". Only an
   * active reminder of that language, and only while the switch is on;
   * clearing is always allowed.
   */
  private reminderKeyFor(
    templates: readonly RegistryTemplate[],
    language: TemplateLanguage,
    style: string | null,
  ): string | null {
    if (style === null) return null;
    const template = this.switches().reminderTemplate
      ? findSelectableByStyle(templates, language, style, COD_REMINDER_PURPOSE)
      : undefined;
    if (!template) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message:
          language === 'ar'
            ? 'Unsupported Arabic reminder style'
            : 'Unsupported English reminder style',
        code: 'SETTINGS_REMINDER_STYLE_UNAVAILABLE',
      });
    }
    return template.key;
  }

  /**
   * A merchant may only choose an active template of that language. A style
   * that is unknown, retired or written for the other language is refused.
   */
  private requireSelectableStyle(
    templates: readonly RegistryTemplate[],
    language: TemplateLanguage,
    style: string,
  ): RegistryTemplate {
    const template = findSelectableByStyle(templates, language, style);
    if (!template) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message:
          language === 'ar'
            ? 'Unsupported Arabic COD template variant'
            : 'Unsupported English COD template variant',
        code: 'SETTINGS_TEMPLATE_STYLE_UNAVAILABLE',
      });
    }
    return template;
  }

  /**
   * The merchant's own WhatsApp number receives the onboarding test. It is
   * stored in E.164 so the send path and the resend guard compare like with
   * like; an empty value clears it.
   */
  normalizeMerchantPhone(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return this.phoneService.standardize(trimmed);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message:
            'WhatsApp number must be a valid phone number (example: +201234567890).',
          code: 'ONBOARDING_INVALID_PHONE',
        });
      }
      throw error;
    }
  }

  /**
   * `allowDisconnected` is for reads only (state, settings, health): a source
   * its merchant disconnected stays readable when its spoke says so, so the
   * history and the way back are not lost behind a 404. Every write still
   * needs an active source.
   */
  async resolveCurrentIntegration(
    user: AuthenticatedUser,
    options: { allowDisconnected?: boolean } = {},
  ): Promise<IntegrationRecord> {
    if (user.shop) {
      const resolution = await resolveShopifyLinkedIntegration(
        this.integrationsRepo,
        { orgId: user.orgId, shopDomain: user.shop, requireActive: false },
      );
      if (resolution.outcome === 'not_found') {
        throw new NotFoundException(
          `Shopify integration not found for shop: ${user.shop}`,
        );
      }
      return resolution.integration;
    }

    const resolution = await resolveFallbackActiveIntegration(
      this.integrationsRepo,
      user.orgId,
    );
    if (resolution.outcome === 'ambiguous') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Multiple active commerce sources require staff review',
        code: 'ONBOARDING_SOURCE_AMBIGUOUS',
      });
    }
    if (resolution.outcome === 'found') return resolution.integration;

    if (options.allowDisconnected && resolution.hasInactiveSource) {
      const disconnected =
        await this.sourceSetup?.findReadableDisconnectedSource(user.orgId);
      if (disconnected) return disconnected;
    }

    throw new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: resolution.hasInactiveSource
        ? 'Commerce source is inactive'
        : 'Commerce source was not found',
      code: resolution.hasInactiveSource
        ? 'ONBOARDING_SOURCE_INACTIVE'
        : 'ONBOARDING_SOURCE_MISSING',
    });
  }

  async prefillStoreNameIfMissing(
    integration: IntegrationRecord,
  ): Promise<IntegrationRecord> {
    if (integration.storeName) return integration;

    try {
      const storeName =
        integration.platformType === 'shopify'
          ? await this.storePlatform.getShopName(integration)
          : await this.readOrganizationStoreName(integration.orgId);
      if (!storeName) return integration;
      const updated = await this.integrationsRepo.updateById(integration.id, {
        storeName,
      });
      return updated ?? integration;
    } catch (error) {
      this.logger.warn(
        buildBackendLog(OnboardingStateService.name, {
          action: 'onboarding-store-name-prefill',
          outcome: 'skipped',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          ...normalizeError(error),
        }),
      );
      return integration;
    }
  }

  /**
   * A store without a platform to ask starts with the company name given at
   * signup, which is the organization name. Trimmed to fit the WhatsApp template variable.
   */
  private async readOrganizationStoreName(
    orgId: string,
  ): Promise<string | null> {
    const organization = await this.organizationsRepo?.findById(orgId);
    const name = organization?.name?.trim().slice(0, STORE_NAME_MAX_LENGTH);
    return name?.trim() || null;
  }

  ensureBillingPrerequisitesMet(integration: IntegrationRecord): void {
    const missingFields = this.getMissingBillingPrerequisites(integration);

    if (missingFields.length > 0) {
      throw new BadRequestException(
        `Onboarding settings must be completed before billing activation (${missingFields.join(', ')})`,
      );
    }
  }

  private getMissingBillingPrerequisites(
    integration: IntegrationRecord,
  ): string[] {
    const missingFields: string[] = [];

    if (!integration.storeName?.trim()) {
      missingFields.push('storeName');
    }

    if (!ONBOARDING_LANGUAGES.includes(integration.defaultLanguage)) {
      missingFields.push('defaultLanguage');
    }

    if (typeof integration.isAutoVerifyEnabled !== 'boolean') {
      missingFields.push('isAutoVerifyEnabled');
    }

    return missingFields;
  }

  toState(integration: IntegrationRecord): OnboardingStateDto {
    const onboardingStatus = ONBOARDING_STATUSES.includes(
      integration.onboardingStatus,
    )
      ? integration.onboardingStatus
      : 'pending';

    return {
      integrationId: integration.id,
      source: {
        platformType: integration.platformType,
        identity: integration.platformStoreUrl,
      },
      onboardingStatus,
      isOnboardingComplete: onboardingStatus === 'completed',
      storeName: integration.storeName ?? null,
      defaultLanguage: integration.defaultLanguage ?? 'auto',
      isAutoVerifyEnabled: integration.isAutoVerifyEnabled ?? true,
      assumeCodWhenPaymentMissing:
        integration.assumeCodWhenPaymentMissing ?? false,
      shippingCurrency: resolveShippingCurrency(integration.shippingCurrency),
      avgShippingCost: this.resolveAverageShippingCost(integration),
      billingPlanId: integration.billingPlanId ?? null,
      billingStatus: integration.billingStatus ?? null,
      billingManagement: getBillingManagement(integration),
      followUpEnabled: integration.followUpEnabled ?? DEFAULT_FOLLOW_UP_ENABLED,
      followUpDelayMinutes:
        integration.followUpDelayMinutes ?? DEFAULT_FOLLOW_UP_DELAY_MINUTES,
      escalationEnabled:
        integration.escalationEnabled ?? DEFAULT_ESCALATION_ENABLED,
      escalationDelayMinutes:
        integration.escalationDelayMinutes ?? DEFAULT_ESCALATION_DELAY_MINUTES,
      quietHoursEnabled:
        integration.quietHoursEnabled ?? DEFAULT_QUIET_HOURS_ENABLED,
      quietHoursStart: integration.quietHoursStart ?? null,
      quietHoursEnd: integration.quietHoursEnd ?? null,
      timezone: this.resolveTimezone(integration),
      shopTimezone: this.resolveShopTimezone(integration),
      sendDelayMinutes:
        integration.sendDelayMinutes ?? DEFAULT_SEND_DELAY_MINUTES,
      // The saved number only: the test send reads nothing else, so a merged
      // value would promise a recipient the send then refuses.
      merchantWhatsappPhone: integration.merchantWhatsappPhone ?? null,
      shopPhone: integration.shopPhone ?? null,
      testSendLanguage: resolveTemplateLanguageForPhone(
        integration.defaultLanguage,
        integration.merchantWhatsappPhone ?? '',
      ),
      activation: {
        setupCompletedAt: null,
        testSentAt: null,
        testConfirmedAt: null,
        testSkippedAt: null,
        firstRealConfirmedAt: null,
        hasRealOrders: true,
        isLive: false,
        needsPlan: false,
      },
      usage: null,
      permissions: {
        canUpdateConfiguration: false,
        canCompleteOnboarding: false,
      },
      standaloneSetup: null,
    };
  }

  async markOnboardingCompleted(integrationId: string): Promise<void> {
    await this.integrationsRepo.updateById(integrationId, {
      onboardingStatus: 'completed',
    });
    await this.adminLifecycles?.markMilestone(
      integrationId,
      'onboardingCompletedAt',
      undefined,
      { onboarding_completed: 'captured_exact' },
    );
  }

  private resolveAverageShippingCost(integration: IntegrationRecord): number {
    const raw = integration.avgShippingCost;
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseFloat(raw)
          : Number.NaN;

    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_AVG_SHIPPING_COST;
    }

    return Number(parsed.toFixed(2));
  }

  private resolveTimezone(integration: IntegrationRecord): string {
    const tz = integration.timezone?.trim();
    if (isAllowedAutomationTimezone(tz, integration.shopTimezone)) {
      return tz;
    }
    return DEFAULT_TIMEZONE;
  }

  private resolveShopTimezone(integration: IntegrationRecord): string | null {
    const tz = integration.shopTimezone?.trim();
    return tz && isValidIanaTimezone(tz) ? tz : null;
  }
}
