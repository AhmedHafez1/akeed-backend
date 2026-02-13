import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../guards/dual-auth.guard';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { integrations } from '../../infrastructure/database/schema';
import {
  ONBOARDING_STATUSES,
  OnboardingBillingResponseDto,
  OnboardingStateDto,
  UpdateOnboardingSettingsDto,
} from '../dto/onboarding.dto';
import { ShopifyApiService } from '../../infrastructure/spokes/shopify/services/shopify-api.service';
import {
  validateShop,
  verifyShopifyHmac,
} from '../../infrastructure/spokes/shopify/shopify.utils';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly shopifyApiService: ShopifyApiService,
    private readonly configService: ConfigService,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    const integration = await this.resolveCurrentIntegration(user);
    let currentIntegration = integration;

    if (!integration.storeName) {
      try {
        const storeName = await this.shopifyApiService.getShopName(integration);
        const updated = await this.integrationsRepo.updateById(integration.id, {
          storeName,
        });

        if (updated) {
          currentIntegration = updated;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to prefill store name for ${integration.platformStoreUrl}: ${message}`,
        );
      }
    }

    return this.toState(currentIntegration);
  }

  async updateSettings(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<OnboardingStateDto> {
    const integration = await this.resolveCurrentIntegration(user);
    const updated = await this.integrationsRepo.updateById(integration.id, {
      storeName: payload.storeName.trim(),
      defaultLanguage: payload.defaultLanguage,
      isAutoVerifyEnabled: payload.isAutoVerifyEnabled,
    });

    if (!updated) {
      throw new NotFoundException('Integration not found');
    }

    return this.toState(updated);
  }

  async initiateBilling(
    user: AuthenticatedUser,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const integration = await this.resolveCurrentIntegration(user);

    if (!this.isBillingRequired()) {
      await this.integrationsRepo.updateById(integration.id, {
        onboardingStatus: 'completed',
      });

      this.logger.log(
        `Shopify billing skipped by configuration for ${integration.platformStoreUrl}`,
      );

      return {
        confirmationUrl: this.buildPostBillingRedirectUrl({
          shop: integration.platformStoreUrl,
          host,
          billingStatus: 'not_required',
          onboardingCompleted: true,
        }),
      };
    }

    const billingPlan = this.getBillingPlan();
    const returnUrl = this.buildBillingReturnUrl(
      integration.platformStoreUrl,
      host,
    );

    let confirmationUrl: string;
    try {
      confirmationUrl =
        await this.shopifyApiService.createRecurringApplicationCharge(
          integration,
          {
            name: billingPlan.name,
            amount: billingPlan.amount,
            currencyCode: billingPlan.currencyCode,
            returnUrl,
            test: billingPlan.testMode,
          },
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        this.shouldSkipCustomAppBillingError() &&
        this.isCustomAppBillingNotSupportedError(message)
      ) {
        await this.integrationsRepo.updateById(integration.id, {
          onboardingStatus: 'completed',
        });

        this.logger.warn(
          `Skipping Shopify billing for custom app ${integration.platformStoreUrl}: ${message}`,
        );

        return {
          confirmationUrl: this.buildPostBillingRedirectUrl({
            shop: integration.platformStoreUrl,
            host,
            billingStatus: 'not_required',
            onboardingCompleted: true,
          }),
        };
      }

      this.logger.error(
        `Failed to initiate billing for ${integration.platformStoreUrl}: ${message}`,
      );
      throw new BadGatewayException('Failed to initiate Shopify billing');
    }

    return { confirmationUrl };
  }

  async handleBillingCallback(
    rawQuery: Record<string, string | undefined>,
  ): Promise<string> {
    const shop = rawQuery.shop;
    const chargeId = rawQuery.charge_id;

    if (!shop || !chargeId || !rawQuery.hmac) {
      throw new BadRequestException(
        'Missing required Shopify billing callback parameters',
      );
    }

    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    const secret = this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');
    if (!verifyShopifyHmac(rawQuery, secret)) {
      throw new UnauthorizedException(
        'Invalid Shopify billing callback signature',
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shop,
      'shopify',
    );

    if (!integration) {
      throw new NotFoundException('Shopify integration not found');
    }

    let billingStatus = 'unknown';
    try {
      const subscription =
        await this.shopifyApiService.getAppSubscriptionStatus(
          integration,
          chargeId,
        );
      billingStatus = subscription.status.toLowerCase();

      if (subscription.status === 'ACTIVE') {
        await this.integrationsRepo.updateById(integration.id, {
          onboardingStatus: 'completed',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed Shopify billing callback processing for ${shop}: ${message}`,
      );
      throw new BadGatewayException('Failed to verify Shopify billing status');
    }

    return this.buildPostBillingRedirectUrl({
      shop,
      host: rawQuery.host,
      billingStatus,
      onboardingCompleted: billingStatus === 'active',
    });
  }

  private async resolveCurrentIntegration(
    user: AuthenticatedUser,
  ): Promise<typeof integrations.$inferSelect> {
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

  private toState(
    integration: typeof integrations.$inferSelect,
  ): OnboardingStateDto {
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
    };
  }

  private getBillingPlan(): {
    name: string;
    amount: number;
    currencyCode: string;
    testMode: boolean;
  } {
    const name =
      this.configService.get<string>('SHOPIFY_BILLING_PLAN_NAME') ??
      'Akeed Pro';
    const rawAmount =
      this.configService.get<string>('SHOPIFY_BILLING_PRICE') ?? '19';
    const amount = Number(rawAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InternalServerErrorException(
        'Invalid SHOPIFY_BILLING_PRICE configuration',
      );
    }

    const currencyCode =
      this.configService.get<string>('SHOPIFY_BILLING_CURRENCY') ?? 'USD';
    const testMode = this.getBillingTestMode();

    return {
      name,
      amount,
      currencyCode,
      testMode,
    };
  }

  private getBillingTestMode(): boolean {
    const raw = this.configService.get<string>('SHOPIFY_BILLING_TEST_MODE');
    if (raw === undefined) {
      return this.configService.get<string>('NODE_ENV') !== 'production';
    }

    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  private buildBillingReturnUrl(shopDomain: string, host?: string): string {
    const apiUrl = this.configService.getOrThrow<string>('API_URL');
    const url = new URL('/api/onboarding/billing/callback', apiUrl);
    url.searchParams.set('shop', shopDomain);
    if (host) {
      url.searchParams.set('host', host);
    }
    return url.toString();
  }

  private buildPostBillingRedirectUrl(params: {
    shop: string;
    host?: string;
    billingStatus: string;
    onboardingCompleted: boolean;
  }): string {
    const appUrl = this.configService.getOrThrow<string>('APP_URL');
    const url = new URL(appUrl);
    url.searchParams.set('shop', params.shop);

    if (params.host) {
      url.searchParams.set('host', params.host);
    }

    url.searchParams.set('billing_status', params.billingStatus);
    url.searchParams.set(
      'onboarding',
      params.onboardingCompleted ? 'completed' : 'pending',
    );

    return url.toString();
  }

  private isCustomAppBillingNotSupportedError(message: string): boolean {
    return message
      .toLowerCase()
      .includes('custom apps cannot use the billing api');
  }

  private isBillingRequired(): boolean {
    return this.getBooleanConfig('SHOPIFY_BILLING_REQUIRED', true);
  }

  private shouldSkipCustomAppBillingError(): boolean {
    return this.getBooleanConfig('SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR', true);
  }

  private getBooleanConfig(key: string, defaultValue: boolean): boolean {
    const raw = this.configService.get<string>(key);
    if (raw === undefined) {
      return defaultValue;
    }

    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
}
