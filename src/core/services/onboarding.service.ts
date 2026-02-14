import {
  BadGatewayException,
  BadRequestException,
  Injectable,
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
  type OnboardingBillingPlanId,
  OnboardingBillingResponseDto,
  OnboardingStateDto,
  UpdateOnboardingSettingsDto,
} from '../dto/onboarding.dto';
import {
  type CreateRecurringApplicationChargeInput,
  ShopifyApiService,
} from '../../infrastructure/spokes/shopify/services/shopify-api.service';
import {
  type BillingPlanConfig,
  buildBillingReturnUrl,
  buildPostBillingRedirectUrl,
  resolveBillingPlan,
  resolveBooleanConfig,
} from './onboarding.service.helpers';
import {
  validateShop,
  verifyShopifyHmac,
} from '../../infrastructure/spokes/shopify/shopify.utils';

type IntegrationRecord = typeof integrations.$inferSelect;

interface BillingCallbackParams {
  shop: string;
  chargeId: string;
  host?: string;
}

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
    const hydratedIntegration =
      await this.prefillStoreNameIfMissing(integration);
    return this.toState(hydratedIntegration);
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
    planId: OnboardingBillingPlanId,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const integration = await this.resolveCurrentIntegration(user);
    const billingPlan = resolveBillingPlan({
      planId,
      currencyCode: this.getBillingCurrencyCode(),
      testMode: this.getBillingTestMode(),
    });

    if (!this.isBillingRequired()) {
      this.logger.log(
        `Shopify billing skipped by configuration for ${integration.platformStoreUrl} (plan=${billingPlan.id})`,
      );

      return {
        confirmationUrl: await this.completeOnboardingAndBuildRedirect({
          integrationId: integration.id,
          shop: integration.platformStoreUrl,
          host,
          billingStatus: 'not_required',
        }),
      };
    }

    if (billingPlan.amount === 0) {
      this.logger.log(
        `Free onboarding plan activated for ${integration.platformStoreUrl} (plan=${billingPlan.id})`,
      );

      return {
        confirmationUrl: await this.completeOnboardingAndBuildRedirect({
          integrationId: integration.id,
          shop: integration.platformStoreUrl,
          host,
          billingStatus: 'active',
        }),
      };
    }

    return {
      confirmationUrl: await this.createPaidPlanConfirmationUrl(
        integration,
        billingPlan,
        host,
      ),
    };
  }

  async handleBillingCallback(
    rawQuery: Record<string, string | undefined>,
  ): Promise<string> {
    const callbackParams =
      this.validateAndExtractBillingCallbackParams(rawQuery);
    const integration = await this.resolveIntegrationByShop(
      callbackParams.shop,
    );
    const billingStatus = await this.resolveBillingStatusFromCharge({
      integration,
      shop: callbackParams.shop,
      chargeId: callbackParams.chargeId,
    });

    if (billingStatus === 'active') {
      return await this.completeOnboardingAndBuildRedirect({
        integrationId: integration.id,
        shop: callbackParams.shop,
        host: callbackParams.host,
        billingStatus,
      });
    }

    return this.createPostBillingRedirectUrl({
      shop: callbackParams.shop,
      host: callbackParams.host,
      billingStatus,
      onboardingCompleted: false,
    });
  }

  private async prefillStoreNameIfMissing(
    integration: IntegrationRecord,
  ): Promise<IntegrationRecord> {
    if (integration.storeName) {
      return integration;
    }

    try {
      const storeName = await this.shopifyApiService.getShopName(integration);
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

  private async resolveCurrentIntegration(
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

  private async resolveIntegrationByShop(
    shop: string,
  ): Promise<IntegrationRecord> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shop,
      'shopify',
    );

    if (!integration) {
      throw new NotFoundException('Shopify integration not found');
    }

    return integration;
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
    };
  }

  private getBillingTestMode(): boolean {
    return this.getBooleanConfig(
      'SHOPIFY_BILLING_TEST_MODE',
      this.configService.get<string>('NODE_ENV') !== 'production',
    );
  }

  private getBillingCurrencyCode(): string {
    return this.configService.get<string>('SHOPIFY_BILLING_CURRENCY') ?? 'USD';
  }

  private createPostBillingRedirectUrl(params: {
    shop: string;
    host?: string;
    billingStatus: string;
    onboardingCompleted: boolean;
  }): string {
    return buildPostBillingRedirectUrl(
      this.configService.getOrThrow<string>('APP_URL'),
      params,
    );
  }

  private buildRecurringChargePayload(params: {
    integration: IntegrationRecord;
    plan: BillingPlanConfig;
    host?: string;
  }): CreateRecurringApplicationChargeInput {
    return {
      name: params.plan.name,
      amount: params.plan.amount,
      currencyCode: params.plan.currencyCode,
      cappedAmount: params.plan.usage?.cappedAmount,
      usageTerms: params.plan.usage?.terms,
      returnUrl: buildBillingReturnUrl(
        this.configService.getOrThrow<string>('API_URL'),
        params.integration.platformStoreUrl,
        params.host,
      ),
      test: params.plan.testMode,
    };
  }

  private async createPaidPlanConfirmationUrl(
    integration: IntegrationRecord,
    plan: BillingPlanConfig,
    host?: string,
  ): Promise<string> {
    const payload = this.buildRecurringChargePayload({
      integration,
      plan,
      host,
    });

    try {
      return await this.shopifyApiService.createRecurringApplicationCharge(
        integration,
        payload,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.shouldSkipCustomAppBillingError() &&
        this.isCustomAppBillingNotSupportedError(message)
      ) {
        this.logger.warn(
          `Skipping Shopify billing for custom app ${integration.platformStoreUrl}: ${message}`,
        );

        return await this.completeOnboardingAndBuildRedirect({
          integrationId: integration.id,
          shop: integration.platformStoreUrl,
          host,
          billingStatus: 'not_required',
        });
      }

      this.logger.error(
        `Failed to initiate billing for ${integration.platformStoreUrl}: ${message}`,
      );
      throw new BadGatewayException('Failed to initiate Shopify billing');
    }
  }

  private async completeOnboardingAndBuildRedirect(params: {
    integrationId: string;
    shop: string;
    host?: string;
    billingStatus: string;
  }): Promise<string> {
    await this.markOnboardingCompleted(params.integrationId);
    return this.createPostBillingRedirectUrl({
      shop: params.shop,
      host: params.host,
      billingStatus: params.billingStatus,
      onboardingCompleted: true,
    });
  }

  private async markOnboardingCompleted(integrationId: string): Promise<void> {
    await this.integrationsRepo.updateById(integrationId, {
      onboardingStatus: 'completed',
    });
  }

  private validateAndExtractBillingCallbackParams(
    rawQuery: Record<string, string | undefined>,
  ): BillingCallbackParams {
    const shop = rawQuery.shop;
    const chargeId = rawQuery.charge_id;
    const hmac = rawQuery.hmac;

    if (!shop || !chargeId || !hmac) {
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

    return {
      shop,
      chargeId,
      host: rawQuery.host,
    };
  }

  private async resolveBillingStatusFromCharge(params: {
    integration: IntegrationRecord;
    shop: string;
    chargeId: string;
  }): Promise<string> {
    try {
      const subscription =
        await this.shopifyApiService.getAppSubscriptionStatus(
          params.integration,
          params.chargeId,
        );
      return subscription.status.toLowerCase();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed Shopify billing callback processing for ${params.shop}: ${message}`,
      );
      throw new BadGatewayException('Failed to verify Shopify billing status');
    }
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
    return resolveBooleanConfig(
      this.configService.get<string>(key),
      defaultValue,
    );
  }
}
