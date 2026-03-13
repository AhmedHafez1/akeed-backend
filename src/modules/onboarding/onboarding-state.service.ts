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
  type OnboardingShippingCurrency,
  type OnboardingStateDto,
  type UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import {
  STORE_PLATFORM_PORT,
  type StorePlatformPort,
} from '../../shared/ports/store-platform.port';
import { validateShop } from '../../infrastructure/spokes/shopify/shopify.utils';
import { BillingConfigService } from './billing-config.service';

type IntegrationRecord = typeof integrations.$inferSelect;
const DEFAULT_SHIPPING_CURRENCY: OnboardingShippingCurrency = 'USD';
const DEFAULT_AVG_SHIPPING_COST = 3;

@Injectable()
export class OnboardingStateService {
  private readonly logger = new Logger(OnboardingStateService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    @Inject(STORE_PLATFORM_PORT)
    private readonly storePlatform: StorePlatformPort,
    private readonly billingConfig: BillingConfigService,
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to prefill store name for ${integration.platformStoreUrl}: ${message}`,
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

  private toState(integration: IntegrationRecord): OnboardingStateDto {
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
      billingManagementUrl: this.resolveBillingManagementUrl(integration),
    };
  }

  private resolveBillingManagementUrl(
    integration: IntegrationRecord,
  ): string | null {
    const apiKey = this.billingConfig.getApiKey();
    if (!apiKey) {
      return null;
    }

    const shopDomain = integration.platformStoreUrl?.trim();
    if (!shopDomain) {
      return null;
    }

    try {
      validateShop(shopDomain);
    } catch {
      return null;
    }

    return new URL(`https://${shopDomain}/admin/apps/${apiKey}`).toString();
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
}
