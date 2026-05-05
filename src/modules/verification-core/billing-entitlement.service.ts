import { Injectable, Logger } from '@nestjs/common';
import { integrations } from '../../infrastructure/database/schema';
import {
  IntegrationMonthlyUsageRepository,
  MonthlyVerificationSlotReservation,
} from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
} from '../onboarding/onboarding.service.helpers';
import type { OnboardingBillingPlanId } from '../onboarding/dto/onboarding.dto';

interface ReserveVerificationSlotResult extends MonthlyVerificationSlotReservation {
  periodStart: string;
  planId: OnboardingBillingPlanId;
}

@Injectable()
export class BillingEntitlementService {
  private readonly logger = new Logger(BillingEntitlementService.name);

  constructor(
    private readonly monthlyUsageRepository: IntegrationMonthlyUsageRepository,
  ) {}

  async reserveVerificationSlot(
    integration: typeof integrations.$inferSelect,
  ): Promise<ReserveVerificationSlotResult> {
    const planId = this.resolvePlanId(integration.billingPlanId);
    const includedLimit = resolveIncludedVerificationsLimit(planId);
    const periodStart = this.getBillingPeriodStart(
      integration.billingActivatedAt,
    );

    const reservation =
      await this.monthlyUsageRepository.reserveMonthlyVerificationSlot({
        orgId: integration.orgId,
        integrationId: integration.id,
        periodStart,
        includedLimit,
        overageAllowed: false,
      });

    return {
      ...reservation,
      periodStart,
      planId,
    };
  }

  async releaseVerificationSlot(params: {
    integrationId: string;
    periodStart: string;
  }): Promise<void> {
    await this.monthlyUsageRepository.releaseMonthlyVerificationSlot(params);
  }

  private resolvePlanId(
    rawPlanId: typeof integrations.$inferSelect.billingPlanId,
  ): OnboardingBillingPlanId {
    if (rawPlanId && isOnboardingBillingPlanId(rawPlanId)) {
      return rawPlanId;
    }

    this.logger.warn(
      `Integration billingPlanId is missing or invalid; using ${DEFAULT_BILLING_PLAN_ID} for entitlement enforcement.`,
    );
    return DEFAULT_BILLING_PLAN_ID;
  }

  /**
   * Computes the start of the current 30-day billing period based on the
   * subscription activation date. Shopify bills on a rolling 30-day cycle
   * from the activation date, not on calendar-month boundaries, so usage
   * accounting must follow the same cadence.
   *
   * Falls back to the 1st of the current UTC month when no activation date
   * is available, such as free Starter plans that bypass Shopify billing.
   */
  getBillingPeriodStart(
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
}
