import { Injectable, Logger } from '@nestjs/common';
import { integrations } from 'src/infrastructure/database/schema';
import {
  IntegrationMonthlyUsageRepository,
  MonthlyVerificationSlotReservation,
} from 'src/infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
} from './onboarding.service.helpers';
import type { OnboardingBillingPlanId } from '../dto/onboarding.dto';

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
    const periodStart = this.getCurrentMonthStartDate();

    const reservation =
      await this.monthlyUsageRepository.reserveMonthlyVerificationSlot({
        orgId: integration.orgId,
        integrationId: integration.id,
        periodStart,
        includedLimit,
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

  private getCurrentMonthStartDate(now = new Date()): string {
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return periodStart.toISOString().slice(0, 10);
  }
}
