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
import { isBillingStatusActive } from '../../shared/utils/billing.util';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

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

    // Same-plan guard: skip if already active on the requested plan.
    if (
      planId === integration.billingPlanId &&
      isBillingStatusActive(integration.billingStatus)
    ) {
      return {
        confirmationUrl: this.createPostBillingRedirectUrl({
          shop: integration.platformStoreUrl,
          host,
        }),
      };
    }

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
    integration: IntegrationRecord,
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

    // Only store the pending plan — keep the current billingPlanId and
    // billingStatus unchanged so verification processing continues.
    await this.persistBillingState({
      integrationId: integration.id,
      pendingBillingPlanId: billingPlan.id,
      markInitiatedAt: true,
    });

    return { confirmationUrl };
  }

  private async initiateWithoutPaying(
    integration: IntegrationRecord,
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
      buildBackendLog(BillingService.name, {
        action: 'billing-initiate-without-paying',
        outcome: 'success',
        orgId: integration.orgId,
        shopDomain: integration.platformStoreUrl,
        integrationId: integration.id,
        billingPlanId: billingPlan.id,
        billingStatus: 'not_required',
      }),
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
    integration: IntegrationRecord,
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
      buildBackendLog(BillingService.name, {
        action: 'billing-initiate-free-plan',
        outcome: 'success',
        orgId: integration.orgId,
        shopDomain: integration.platformStoreUrl,
        integrationId: integration.id,
        billingPlanId: billingPlan.id,
        billingStatus: 'active',
      }),
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
    // Clear the pending plan. If the merchant already has an active plan,
    // keep it intact so verification processing continues.
    const hasActivePlan = isBillingStatusActive(integration.billingStatus);
    const isCanceledStatus = this.isCanceledBillingStatus(
      billingResolution.status,
    );
    await this.persistBillingState({
      integrationId: integration.id,
      pendingBillingPlanId: null,
      // Only write the declined/canceled status if there is no active plan
      // (e.g. first onboarding). Otherwise preserve the current active status.
      ...(hasActivePlan
        ? {}
        : {
            status: billingResolution.status,
            markCanceledAt: isCanceledStatus,
            clearCanceledAt: !isCanceledStatus,
          }),
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

    // Promote the pending plan to the active plan.
    const activatedPlanId =
      integration.pendingBillingPlanId ?? integration.billingPlanId;
    const activatedPlan = activatedPlanId
      ? this.billingConfig.resolvePlan(activatedPlanId)
      : null;

    await this.persistBillingState({
      integrationId: integration.id,
      planId: activatedPlanId ?? undefined,
      pendingBillingPlanId: null,
      status: billingResolution.status,
      shopifySubscriptionId: billingResolution.subscriptionId,
      markActivatedAt: true,
      clearCanceledAt: true,
    });

    // Reset usage counters so the new plan starts with a clean slate.
    await this.resetUsageForPlanChange(
      integration.id,
      activatedPlan?.includedVerifications,
    );

    const missingPrerequisites =
      this.getMissingBillingPrerequisites(integration);
    if (missingPrerequisites.length > 0) {
      this.logger.warn(
        buildBackendLog(BillingService.name, {
          action: 'billing-callback-onboarding-complete',
          outcome: 'skipped',
          orgId: integration.orgId,
          shopDomain: callbackParams.shop,
          integrationId: integration.id,
          missingPrerequisites,
        }),
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
      this.logger.error(
        buildBackendLog(BillingService.name, {
          action: 'billing-callback-resolve-status',
          outcome: 'failure',
          orgId: params.integration.orgId,
          shopDomain: params.shop,
          integrationId: params.integration.id,
          chargeId: params.chargeId,
          ...normalizeError(error),
        }),
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
          buildBackendLog(BillingService.name, {
            action: 'billing-initiate-paid-plan',
            outcome: 'skipped',
            orgId: integration.orgId,
            shopDomain: integration.platformStoreUrl,
            integrationId: integration.id,
            billingPlanId: plan.id,
            reason: 'custom_app_billing_not_supported',
            errorMessage: message,
          }),
        );

        return await this.completeOnboardingAndBuildRedirect({
          integrationId: integration.id,
          shop: integration.platformStoreUrl,
          host,
        });
      }

      this.logger.error(
        buildBackendLog(BillingService.name, {
          action: 'billing-initiate-paid-plan',
          outcome: 'failure',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          billingPlanId: plan.id,
          errorMessage: message,
          ...normalizeError(error),
        }),
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
        buildBackendLog(BillingService.name, {
          action: 'billing-cancel-existing-subscription',
          outcome: 'success',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          subscriptionId: existingSubscriptionId,
        }),
      );
    } catch (error) {
      this.logger.warn(
        buildBackendLog(BillingService.name, {
          action: 'billing-cancel-existing-subscription',
          outcome: 'retry',
          orgId: integration.orgId,
          shopDomain: integration.platformStoreUrl,
          integrationId: integration.id,
          subscriptionId: existingSubscriptionId,
          ...normalizeError(error),
        }),
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
      this.logger.warn(
        buildBackendLog(BillingService.name, {
          action: 'billing-usage-reset-for-plan-change',
          outcome: 'retry',
          integrationId,
          periodStart: newPeriodStart,
          includedLimit,
          ...normalizeError(error),
        }),
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
        buildBackendLog(BillingService.name, {
          action: 'billing-free-plan-claim-rollback',
          outcome: 'retry',
          platformType: params.platformType,
          shopDomain: params.shopDomain,
          ...normalizeError(error),
        }),
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
    pendingBillingPlanId?: OnboardingBillingPlanId | null;
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

    if (params.pendingBillingPlanId !== undefined) {
      updates.pendingBillingPlanId = params.pendingBillingPlanId;
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
