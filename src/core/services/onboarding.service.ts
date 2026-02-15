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
  ONBOARDING_LANGUAGES,
  ONBOARDING_STATUSES,
  type OnboardingBillingPlanId,
  type OnboardingBillingPlanDto,
  OnboardingBillingResponseDto,
  OnboardingBillingPlansResponseDto,
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
  resolveBillingPlans,
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

interface BillingChargeResolution {
  status: string;
  subscriptionId: string;
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

  async getBillingPlans(
    user: AuthenticatedUser,
  ): Promise<OnboardingBillingPlansResponseDto> {
    // Ensure the requester belongs to a valid Shopify integration context.
    await this.resolveCurrentIntegration(user);

    const plans = resolveBillingPlans({
      currencyCode: this.getBillingCurrencyCode(),
      testMode: this.getBillingTestMode(),
    });

    return {
      plans: plans.map<OnboardingBillingPlanDto>((plan) => ({
        id: plan.id,
        name: plan.name,
        amount: plan.amount,
        currencyCode: plan.currencyCode,
        includedVerifications: plan.includedVerifications,
        usage: plan.usage,
      })),
    };
  }

  async initiateBilling(
    user: AuthenticatedUser,
    planId: OnboardingBillingPlanId,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const integration = await this.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.prefillStoreNameIfMissing(integration);
    this.ensureBillingPrerequisitesMet(hydratedIntegration);

    const billingPlan = resolveBillingPlan({
      planId,
      currencyCode: this.getBillingCurrencyCode(),
      testMode: this.getBillingTestMode(),
    });

    if (!this.isBillingRequired()) {
      await this.persistBillingState({
        integrationId: hydratedIntegration.id,
        planId: billingPlan.id,
        status: 'not_required',
        markInitiatedAt: true,
        markActivatedAt: true,
        clearCanceledAt: true,
        shopifySubscriptionId: null,
      });

      this.logger.log(
        `Shopify billing skipped by configuration for ${hydratedIntegration.platformStoreUrl} (plan=${billingPlan.id})`,
      );

      return {
        confirmationUrl: await this.completeOnboardingAndBuildRedirect({
          integrationId: hydratedIntegration.id,
          shop: hydratedIntegration.platformStoreUrl,
          host,
        }),
      };
    }

    if (billingPlan.amount === 0) {
      await this.persistBillingState({
        integrationId: hydratedIntegration.id,
        planId: billingPlan.id,
        status: 'active',
        markInitiatedAt: true,
        markActivatedAt: true,
        clearCanceledAt: true,
        shopifySubscriptionId: null,
      });

      this.logger.log(
        `Free onboarding plan activated for ${hydratedIntegration.platformStoreUrl} (plan=${billingPlan.id})`,
      );

      return {
        confirmationUrl: await this.completeOnboardingAndBuildRedirect({
          integrationId: hydratedIntegration.id,
          shop: hydratedIntegration.platformStoreUrl,
          host,
        }),
      };
    }

    await this.persistBillingState({
      integrationId: hydratedIntegration.id,
      planId: billingPlan.id,
      status: 'pending',
      markInitiatedAt: true,
      clearCanceledAt: true,
      shopifySubscriptionId: null,
    });

    return {
      confirmationUrl: await this.createPaidPlanConfirmationUrl(
        hydratedIntegration,
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
    const billingResolution = await this.resolveBillingStatusFromCharge({
      integration,
      shop: callbackParams.shop,
      chargeId: callbackParams.chargeId,
    });

    const isCanceledStatus = this.isCanceledBillingStatus(
      billingResolution.status,
    );
    await this.persistBillingState({
      integrationId: integration.id,
      status: billingResolution.status,
      shopifySubscriptionId: billingResolution.subscriptionId,
      markActivatedAt: billingResolution.status === 'active',
      markCanceledAt: isCanceledStatus,
      clearCanceledAt: !isCanceledStatus,
    });

    if (billingResolution.status === 'active') {
      const missingPrerequisites =
        this.getMissingBillingPrerequisites(integration);
      if (missingPrerequisites.length > 0) {
        this.logger.warn(
          `Skipping onboarding completion for ${callbackParams.shop}; missing prerequisites: ${missingPrerequisites.join(', ')}`,
        );
        return this.createPostBillingRedirectUrl({
          shop: callbackParams.shop,
          host: callbackParams.host,
        });
      }

      return await this.completeOnboardingAndBuildRedirect({
        integrationId: integration.id,
        shop: callbackParams.shop,
        host: callbackParams.host,
      });
    }

    return this.createPostBillingRedirectUrl({
      shop: callbackParams.shop,
      host: callbackParams.host,
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
        await this.persistBillingState({
          integrationId: integration.id,
          planId: plan.id,
          status: 'not_required',
          markActivatedAt: true,
          clearCanceledAt: true,
          shopifySubscriptionId: null,
        });

        this.logger.warn(
          `Skipping Shopify billing for custom app ${integration.platformStoreUrl}: ${message}`,
        );

        return await this.completeOnboardingAndBuildRedirect({
          integrationId: integration.id,
          shop: integration.platformStoreUrl,
          host,
        });
      }

      this.logger.error(
        `Failed to initiate billing for ${integration.platformStoreUrl}: ${message}`,
      );

      await this.persistBillingState({
        integrationId: integration.id,
        planId: plan.id,
        status: 'error',
      });

      throw new BadGatewayException('Failed to initiate Shopify billing');
    }
  }

  private async completeOnboardingAndBuildRedirect(params: {
    integrationId: string;
    shop: string;
    host?: string;
  }): Promise<string> {
    await this.markOnboardingCompleted(params.integrationId);
    return this.createPostBillingRedirectUrl({
      shop: params.shop,
      host: params.host,
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
  }): Promise<BillingChargeResolution> {
    try {
      const subscription =
        await this.shopifyApiService.getAppSubscriptionStatus(
          params.integration,
          params.chargeId,
        );
      return {
        status: subscription.status.toLowerCase(),
        subscriptionId: subscription.id,
      };
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

  private ensureBillingPrerequisitesMet(integration: IntegrationRecord): void {
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

  private isCanceledBillingStatus(status: string): boolean {
    return ['cancelled', 'canceled', 'declined', 'expired', 'frozen'].includes(
      status,
    );
  }

  private async persistBillingState(params: {
    integrationId: string;
    planId?: OnboardingBillingPlanId;
    status?: string;
    shopifySubscriptionId?: string | null;
    markInitiatedAt?: boolean;
    markActivatedAt?: boolean;
    markCanceledAt?: boolean;
    clearCanceledAt?: boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    const updates: Partial<typeof integrations.$inferInsert> = {};

    if (params.planId !== undefined) {
      updates.billingPlanId = params.planId;
    }

    if (params.status !== undefined) {
      updates.billingStatus = params.status;
      updates.billingStatusUpdatedAt = now;
    }

    if (params.shopifySubscriptionId !== undefined) {
      updates.shopifySubscriptionId = params.shopifySubscriptionId;
    }

    if (params.markInitiatedAt) {
      updates.billingInitiatedAt = now;
    }

    if (params.markActivatedAt) {
      updates.billingActivatedAt = now;
    }

    if (params.markCanceledAt) {
      updates.billingCanceledAt = now;
    }

    if (params.clearCanceledAt) {
      updates.billingCanceledAt = null;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    await this.integrationsRepo.updateById(params.integrationId, updates);
  }
}
