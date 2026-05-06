import { Injectable } from '@nestjs/common';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { integrations } from '../../infrastructure/database/schema';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type {
  OnboardingBillingPlanId,
  OnboardingBillingResponseDto,
  OnboardingBillingPlansResponseDto,
  OnboardingStateDto,
  SettingsResponseDto,
  UpdateOnboardingSettingsDto,
} from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService, type BillingCallbackParams } from './billing.service';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
} from './onboarding.service.helpers';

type IntegrationRecord = typeof integrations.$inferSelect;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly billingService: BillingService,
    private readonly monthlyUsageRepo: IntegrationMonthlyUsageRepository,
  ) {}

  async getState(user: AuthenticatedUser): Promise<OnboardingStateDto> {
    return this.onboardingState.getState(user);
  }

  async updateSettings(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<OnboardingStateDto> {
    return this.onboardingState.updateSettings(user, payload);
  }

  async getSettings(user: AuthenticatedUser): Promise<SettingsResponseDto> {
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
    const hydratedIntegration =
      await this.onboardingState.prefillStoreNameIfMissing(integration);

    const [billingPlans, usage] = await Promise.all([
      this.billingService.getBillingPlans(hydratedIntegration),
      this.getCurrentUsage(user.orgId, hydratedIntegration),
    ]);

    return {
      state: this.onboardingState.toState(hydratedIntegration),
      billing: {
        plans: billingPlans.plans,
        isFreePlanClaimed: billingPlans.isFreePlanClaimed,
        usage,
      },
      template: this.getTemplatePreview(),
    };
  }

  async updateSettingsResponse(
    user: AuthenticatedUser,
    payload: UpdateOnboardingSettingsDto,
  ): Promise<SettingsResponseDto> {
    await this.onboardingState.updateSettings(user, payload);
    return this.getSettings(user);
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
    const integration =
      await this.onboardingState.resolveCurrentIntegration(user);
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
    orgId: string,
    integration: IntegrationRecord,
  ): Promise<SettingsResponseDto['billing']['usage']> {
    const periodStart = this.getBillingPeriodStart(
      integration.billingActivatedAt,
    );
    const periodEnd = this.getBillingPeriodEnd(periodStart);
    const usage = await this.monthlyUsageRepo.getOrgUsageTotalsForPeriod({
      orgId,
      periodStart,
    });

    const planId =
      integration.billingPlanId &&
      isOnboardingBillingPlanId(integration.billingPlanId)
        ? integration.billingPlanId
        : DEFAULT_BILLING_PLAN_ID;

    return {
      used: usage.consumedCount,
      limit:
        usage.includedLimit > 0
          ? usage.includedLimit
          : resolveIncludedVerificationsLimit(planId),
      periodStart,
      periodEnd,
    };
  }

  private getBillingPeriodStart(
    billingActivatedAt?: string | Date | null,
    now = new Date(),
  ): string {
    if (!billingActivatedAt) {
      const fallback = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      return fallback.toISOString().slice(0, 10);
    }

    const activation = new Date(billingActivatedAt);
    if (isNaN(activation.getTime())) {
      const fallback = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      return fallback.toISOString().slice(0, 10);
    }

    const msPerDay = 86_400_000;
    const elapsedMs = now.getTime() - activation.getTime();
    if (elapsedMs < 0) {
      return activation.toISOString().slice(0, 10);
    }

    const elapsedDays = Math.floor(elapsedMs / msPerDay);
    const completedCycles = Math.floor(elapsedDays / 30);
    const periodStart = new Date(
      activation.getTime() + completedCycles * 30 * msPerDay,
    );
    return periodStart.toISOString().slice(0, 10);
  }

  private getBillingPeriodEnd(periodStart: string): string {
    const start = new Date(`${periodStart}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() + 30);
    return start.toISOString().slice(0, 10);
  }

  private getTemplatePreview(): SettingsResponseDto['template'] {
    return {
      languages: ['ar', 'en'],
      defaultPreviewLanguage: 'en',
      previews: {
        ar: {
          greeting: 'السلام عليكم',
          body: 'تم استلام طلبك رقم #{order_number} والدفع عند الاستلام',
          totalLabel: 'إجمالي السعر: {total}',
          ending: 'من فضلك أكد الطلب.',
          confirmButton: 'تأكيد',
          cancelButton: 'إلغاء',
        },
        en: {
          greeting: 'Hello',
          body: 'We have received your order #{order_number} with Cash on Delivery.',
          totalLabel: 'Total Price: {total}',
          ending: 'Please confirm your order.',
          confirmButton: 'Confirm',
          cancelButton: 'Cancel',
        },
      },
    };
  }
}
