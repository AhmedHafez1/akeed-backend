import {
  BadRequestException,
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { BillingFreePlanClaimsRepository } from '../../infrastructure/database/repositories/billing-free-plan-claims.repository';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { integrations } from '../../infrastructure/database/schema';
import {
  ONBOARDING_LANGUAGES,
  type OnboardingBillingPlanId,
  type OnboardingBillingPlanDto,
  type OnboardingBillingResponseDto,
  type OnboardingBillingPlansResponseDto,
} from './dto/onboarding.dto';
import {
  STORE_PLATFORM_PORT,
  type StorePlatformPort,
  type CreateSubscriptionInput,
} from '../../shared/ports/store-platform.port';
import {
  type BillingPlanConfig,
  buildBillingReturnUrl,
  buildPostBillingRedirectUrl,
} from './onboarding.service.helpers';
import { BillingConfigService } from './billing-config.service';

type IntegrationRecord = typeof integrations.$inferSelect;

export interface BillingCallbackParams {
  shop: string;
  chargeId: string;
  host?: string;
}

interface BillingChargeResolution {
  status: string;
  subscriptionId: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly freePlanClaimsRepo: BillingFreePlanClaimsRepository,
    private readonly monthlyUsageRepo: IntegrationMonthlyUsageRepository,
    @Inject(STORE_PLATFORM_PORT)
    private readonly storePlatform: StorePlatformPort,
    private readonly billingConfig: BillingConfigService,
  ) {}

  async getBillingPlans(
    integration: IntegrationRecord,
  ): Promise<OnboardingBillingPlansResponseDto> {
    const plans = this.billingConfig.resolveAllPlans();

    const isFreePlanClaimed = await this.freePlanClaimsRepo.hasClaim({
      platformType: integration.platformType,
      shopDomain: integration.platformStoreUrl,
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
      isFreePlanClaimed,
    };
  }

  async initiateBilling(
    integration: IntegrationRecord,
    planId: OnboardingBillingPlanId,
    host?: string,
  ): Promise<OnboardingBillingResponseDto> {
    const billingPlan = this.billingConfig.resolvePlan(planId);

    if (billingPlan.amount === 0) {
      return await this.initiateFreePlan(integration, billingPlan, host);
    }

    if (!this.billingConfig.isBillingRequired()) {
      // Important: Only use this bypass in development
      return await this.initiateWithoutPaying(integration, billingPlan, host);
    }

    return await this.initiatePaidPlan(integration, billingPlan, host);
  }

  private async initiatePaidPlan(
    integration: {
      id: string;
      orgId: string;
      platformType: string;
      platformStoreUrl: string;
      accessToken: string | null;
      expiresAt: string | null;
      webhookSecret: string | null;
      isActive: boolean | null;
      lastSyncedAt: string | null;
      metadata: unknown;
      storeName: string | null;
      defaultLanguage: 'en' | 'ar' | 'auto';
      shippingCurrency: string;
      avgShippingCost: string;
      isAutoVerifyEnabled: boolean;
      onboardingStatus: 'pending' | 'completed';
      billingPlanId: 'scale' | 'starter' | 'growth' | 'pro' | null;
      shopifySubscriptionId: string | null;
      billingStatus: string | null;
      billingInitiatedAt: string | null;
      billingActivatedAt: string | null;
      billingCanceledAt: string | null;
      billingStatusUpdatedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    },
    billingPlan: BillingPlanConfig,
    host: string | undefined,
  ) {
    // Create the new subscription on Shopify BEFORE modifying local state.
    // The old subscription stays active until the merchant confirms the new one.
    const confirmationUrl = await this.createPaidPlanConfirmationUrl(
      integration,
      billingPlan,
      host,
    );

    await this.persistBillingState({
      integrationId: integration.id,
      planId: billingPlan.id,
      status: 'pending',
      markInitiatedAt: true,
      clearCanceledAt: true,
      // Keep old shopifySubscriptionId so the callback can cancel it
    });

    return { confirmationUrl };
  }

  private async initiateWithoutPaying(
    integration: {
      id: string;
      orgId: string;
      platformType: string;
      platformStoreUrl: string;
      accessToken: string | null;
      expiresAt: string | null;
      webhookSecret: string | null;
      isActive: boolean | null;
      lastSyncedAt: string | null;
      metadata: unknown;
      storeName: string | null;
      defaultLanguage: 'en' | 'ar' | 'auto';
      shippingCurrency: string;
      avgShippingCost: string;
      isAutoVerifyEnabled: boolean;
      onboardingStatus: 'pending' | 'completed';
      billingPlanId: 'scale' | 'starter' | 'growth' | 'pro' | null;
      shopifySubscriptionId: string | null;
      billingStatus: string | null;
      billingInitiatedAt: string | null;
      billingActivatedAt: string | null;
      billingCanceledAt: string | null;
      billingStatusUpdatedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    },
    billingPlan: BillingPlanConfig,
    host: string | undefined,
  ) {
    await this.cancelExistingSubscriptionIfAny(integration);
    await this.persistBillingState({
      integrationId: integration.id,
      planId: billingPlan.id,
      status: 'not_required',
      markInitiatedAt: true,
      markActivatedAt: true,
      clearCanceledAt: true,
      shopifySubscriptionId: null,
    });

    await this.resetUsageForPlanChange(
      integration.id,
      billingPlan.includedVerifications,
    );

    this.logger.log(
      `Shopify billing skipped by configuration for ${integration.platformStoreUrl} (plan=${billingPlan.id})`,
    );

    return {
      confirmationUrl: await this.completeOnboardingAndBuildRedirect({
        integrationId: integration.id,
        shop: integration.platformStoreUrl,
        host,
      }),
    };
  }

  private async initiateFreePlan(
    integration: {
      id: string;
      orgId: string;
      platformType: string;
      platformStoreUrl: string;
      accessToken: string | null;
      expiresAt: string | null;
      webhookSecret: string | null;
      isActive: boolean | null;
      lastSyncedAt: string | null;
      metadata: unknown;
      storeName: string | null;
      defaultLanguage: 'en' | 'ar' | 'auto';
      shippingCurrency: string;
      avgShippingCost: string;
      isAutoVerifyEnabled: boolean;
      onboardingStatus: 'pending' | 'completed';
      billingPlanId: 'scale' | 'starter' | 'growth' | 'pro' | null;
      shopifySubscriptionId: string | null;
      billingStatus: string | null;
      billingInitiatedAt: string | null;
      billingActivatedAt: string | null;
      billingCanceledAt: string | null;
      billingStatusUpdatedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    },
    billingPlan: BillingPlanConfig,
    host: string | undefined,
  ) {
    const claimCreated = await this.freePlanClaimsRepo.createIfNew({
      orgId: integration.orgId,
      platformType: integration.platformType,
      shopDomain: integration.platformStoreUrl,
    });

    if (!claimCreated) {
      throw new BadRequestException(
        'Starter plan can only be activated once per store. Please choose a paid plan.',
      );
    }

    try {
      await this.cancelExistingSubscriptionIfAny(integration);

      await this.persistBillingState({
        integrationId: integration.id,
        planId: billingPlan.id,
        status: 'active',
        markInitiatedAt: true,
        markActivatedAt: true,
        clearCanceledAt: true,
        shopifySubscriptionId: null,
      });

      await this.resetUsageForPlanChange(
        integration.id,
        billingPlan.includedVerifications,
      );
    } catch (error) {
      await this.safeRollbackFreePlanClaim({
        platformType: integration.platformType,
        shopDomain: integration.platformStoreUrl,
      });
      throw error;
    }

    this.logger.log(
      `Free onboarding plan activated for ${integration.platformStoreUrl} (plan=${billingPlan.id})`,
    );

    return {
      confirmationUrl: await this.completeOnboardingAndBuildRedirect({
        integrationId: integration.id,
        shop: integration.platformStoreUrl,
        host,
      }),
    };
  }

  async handleBillingCallback(
    callbackParams: BillingCallbackParams,
  ): Promise<string> {
    const integration = await this.resolveIntegrationByShop(
      callbackParams.shop,
    );
    const billingResolution = await this.resolveBillingStatusFromCharge({
      integration,
      shop: callbackParams.shop,
      chargeId: callbackParams.chargeId,
    });

    if (billingResolution.status === 'active') {
      return this.activateNewSubscription(
        integration,
        billingResolution,
        callbackParams,
      );
    }

    // Merchant declined or subscription was not approved.
    // Keep the old subscription intact so they stay on their current plan.
    const isCanceledStatus = this.isCanceledBillingStatus(
      billingResolution.status,
    );
    await this.persistBillingState({
      integrationId: integration.id,
      status: billingResolution.status,
      markCanceledAt: isCanceledStatus,
      clearCanceledAt: !isCanceledStatus,
    });

    return this.createPostBillingRedirectUrl({
      shop: callbackParams.shop,
      host: callbackParams.host,
    });
  }

  private async activateNewSubscription(
    integration: IntegrationRecord,
    billingResolution: BillingChargeResolution,
    callbackParams: BillingCallbackParams,
  ): Promise<string> {
    // Cancel the previous subscription only after the new one is confirmed.
    await this.cancelExistingSubscriptionIfAny(integration);

    await this.persistBillingState({
      integrationId: integration.id,
      status: billingResolution.status,
      shopifySubscriptionId: billingResolution.subscriptionId,
      markActivatedAt: true,
      clearCanceledAt: true,
    });

    // Reset usage counters so the new plan starts with a clean slate.
    const activatedPlan = integration.billingPlanId
      ? this.billingConfig.resolvePlan(integration.billingPlanId)
      : null;
    await this.resetUsageForPlanChange(
      integration.id,
      activatedPlan?.includedVerifications,
    );

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

  async completeOnboardingAndBuildRedirect(params: {
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

  private async resolveBillingStatusFromCharge(params: {
    integration: IntegrationRecord;
    shop: string;
    chargeId: string;
  }): Promise<BillingChargeResolution> {
    try {
      const subscription = await this.storePlatform.getAppSubscriptionStatus(
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

  private createPostBillingRedirectUrl(params: {
    shop: string;
    host?: string;
  }): string {
    return buildPostBillingRedirectUrl(this.billingConfig.getAppUrl(), params);
  }

  private buildRecurringChargePayload(params: {
    integration: IntegrationRecord;
    plan: BillingPlanConfig;
    host?: string;
  }): CreateSubscriptionInput {
    return {
      name: params.plan.name,
      amount: params.plan.amount,
      currencyCode: params.plan.currencyCode,
      cappedAmount: params.plan.usage?.cappedAmount,
      usageTerms: params.plan.usage?.terms,
      returnUrl: buildBillingReturnUrl(
        this.billingConfig.getAppUrl(),
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
      return await this.storePlatform.createRecurringApplicationCharge(
        integration,
        payload,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.billingConfig.shouldSkipCustomAppBillingError() &&
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

  private isCustomAppBillingNotSupportedError(message: string): boolean {
    return message
      .toLowerCase()
      .includes('custom apps cannot use the billing api');
  }

  private async cancelExistingSubscriptionIfAny(
    integration: IntegrationRecord,
  ): Promise<void> {
    const existingSubscriptionId = integration.shopifySubscriptionId;
    if (
      !existingSubscriptionId ||
      this.isCanceledBillingStatus(integration.billingStatus ?? '')
    ) {
      return;
    }

    try {
      await this.storePlatform.cancelAppSubscription(
        integration,
        existingSubscriptionId,
      );
      this.logger.log(
        `Cancelled previous subscription ${existingSubscriptionId} for ${integration.platformStoreUrl} during plan change`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to cancel previous subscription ${existingSubscriptionId} for ${integration.platformStoreUrl}: ${message}`,
      );
    }
  }

  private isCanceledBillingStatus(status: string): boolean {
    return ['cancelled', 'canceled', 'declined', 'expired', 'frozen'].includes(
      status,
    );
  }

  /**
   * Resets monthly usage counters for the integration's new billing period.
   * Called when a plan change is activated so the merchant starts fresh.
   */
  private async resetUsageForPlanChange(
    integrationId: string,
    includedLimit?: number,
  ): Promise<void> {
    const newPeriodStart = new Date().toISOString().slice(0, 10);
    try {
      await this.monthlyUsageRepo.resetCountersForPeriod({
        integrationId,
        periodStart: newPeriodStart,
        includedLimit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to reset usage counters for integration ${integrationId}: ${message}`,
      );
    }
  }

  private async safeRollbackFreePlanClaim(params: {
    platformType: string;
    shopDomain: string;
  }): Promise<void> {
    try {
      await this.freePlanClaimsRepo.deleteByPlatformAndShop(params);
    } catch (error) {
      this.logger.warn(
        `Failed to rollback free plan claim for ${params.platformType}:${params.shopDomain}: 
        ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getMissingBillingPrerequisites(integration: IntegrationRecord): string[] {
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

  async persistBillingState(params: {
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
