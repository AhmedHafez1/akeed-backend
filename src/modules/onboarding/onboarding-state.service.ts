import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { integrations } from '../../infrastructure/database/schema';
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

    const fallback = await this.integrationsRepo.findActiveByOrgAndPlatform(
      user.orgId,
      'shopify',
    );

    if (!fallback) {
      throw new NotFoundException('Shopify integration not found');
    }

    return fallback;
  }

  async prefillStoreNameIfMissing(
    integration: IntegrationRecord,
  ): Promise<IntegrationRecord> {
    if (integration.storeName) {
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
      onboardingStatus,
      isOnboardingComplete: onboardingStatus === 'completed',
      storeName: integration.storeName ?? null,
      defaultLanguage: integration.defaultLanguage ?? 'auto',
      isAutoVerifyEnabled: integration.isAutoVerifyEnabled ?? true,
      shippingCurrency: this.resolveShippingCurrency(integration),
      avgShippingCost: this.resolveAverageShippingCost(integration),
      billingPlanId: integration.billingPlanId ?? null,
      billingStatus: integration.billingStatus ?? null,
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
    };
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
