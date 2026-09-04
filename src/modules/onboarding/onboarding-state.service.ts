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
import {
  ONBOARDING_LANGUAGES,
  ONBOARDING_SHIPPING_CURRENCIES,
  ONBOARDING_STATUSES,
  AUTOMATION_TIMEZONES,
  type AutomationTimezone,
  type OnboardingShippingCurrency,
  type OnboardingStateDto,
  type UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import {
  STORE_PLATFORM_PORT,
  type StorePlatformPort,
} from '../../shared/ports/store-platform.port';
import {
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
} from '../../shared/messaging/cod-template-catalog';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

type IntegrationRecord = typeof integrations.$inferSelect;
const DEFAULT_SHIPPING_CURRENCY: OnboardingShippingCurrency = 'USD';
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
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    const integration = await this.resolveCurrentIntegration(user);
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
      updates.timezone = payload.timezone;
    }
    if (payload.sendDelayMinutes !== undefined) {
      updates.sendDelayMinutes = payload.sendDelayMinutes;
    }
    if (payload.codTemplateArVariant !== undefined) {
      if (!isArabicCodTemplateVariant(payload.codTemplateArVariant)) {
        throw new BadRequestException(
          'Unsupported Arabic COD template variant',
        );
      }
      updates.codTemplateArVariant = payload.codTemplateArVariant;
    }
    if (payload.codTemplateEnVariant !== undefined) {
      if (!isEnglishCodTemplateVariant(payload.codTemplateEnVariant)) {
        throw new BadRequestException(
          'Unsupported English COD template variant',
        );
      }
      updates.codTemplateEnVariant = payload.codTemplateEnVariant;
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

  async resolveCurrentIntegration(
    user: AuthenticatedUser,
  ): Promise<IntegrationRecord> {
    if (user.shop) {
      const byShop = await this.integrationsRepo.findByOrgAndPlatformDomain(
        user.orgId,
        user.shop,
        'shopify',
      );

      if (!byShop) {
        throw new NotFoundException(
          `Shopify integration not found for shop: ${user.shop}`,
        );
      }

      return byShop;
    }

    const sources = await this.integrationsRepo.findActiveByOrg(user.orgId);
    if (sources.length > 1)
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Multiple active commerce sources require staff review',
        code: 'ONBOARDING_SOURCE_AMBIGUOUS',
      });
    const fallback = sources[0];
    if (!fallback) {
      const existingSources = await this.integrationsRepo.findByOrg(user.orgId);
      const hasInactiveSource = existingSources.some(
        (source) => source.isActive === false,
      );
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: hasInactiveSource
          ? 'Commerce source is inactive'
          : 'Commerce source was not found',
        code: hasInactiveSource
          ? 'ONBOARDING_SOURCE_INACTIVE'
          : 'ONBOARDING_SOURCE_MISSING',
      });
    }

    return fallback;
  }

  async prefillStoreNameIfMissing(
    integration: IntegrationRecord,
  ): Promise<IntegrationRecord> {
    if (integration.storeName || integration.platformType !== 'shopify') {
      return integration;
    }

    try {
      const storeName = await this.storePlatform.getShopName(integration);
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
      shippingCurrency: this.resolveShippingCurrency(integration),
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
      sendDelayMinutes:
        integration.sendDelayMinutes ?? DEFAULT_SEND_DELAY_MINUTES,
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

  private resolveShippingCurrency(
    integration: IntegrationRecord,
  ): OnboardingShippingCurrency {
    const currency = integration.shippingCurrency?.trim().toUpperCase();
    if (!currency) {
      return DEFAULT_SHIPPING_CURRENCY;
    }

    if (
      ONBOARDING_SHIPPING_CURRENCIES.includes(
        currency as OnboardingShippingCurrency,
      )
    ) {
      return currency as OnboardingShippingCurrency;
    }

    return DEFAULT_SHIPPING_CURRENCY;
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

  private resolveTimezone(integration: IntegrationRecord): AutomationTimezone {
    const tz = integration.timezone?.trim();
    if (tz && AUTOMATION_TIMEZONES.includes(tz as AutomationTimezone)) {
      return tz as AutomationTimezone;
    }
    return DEFAULT_TIMEZONE;
  }
}
