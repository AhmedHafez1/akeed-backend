import { Inject, Injectable, Logger } from '@nestjs/common';
import { integrations } from '../../infrastructure/database/schema';
import {
  IntegrationMonthlyUsageRepository,
  MonthlyVerificationSlotReservation,
} from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
  resolveOverageConfig,
} from '../onboarding/onboarding.service.helpers';
import type { OnboardingBillingPlanId } from '../onboarding/dto/onboarding.dto';
import {
  STORE_PLATFORM_PORT,
  type StorePlatformPort,
} from '../../shared/ports/store-platform.port';

interface ReserveVerificationSlotResult extends MonthlyVerificationSlotReservation {
  periodStart: string;
  planId: OnboardingBillingPlanId;
}

@Injectable()
export class BillingEntitlementService {
  private readonly logger = new Logger(BillingEntitlementService.name);

  constructor(
    private readonly monthlyUsageRepository: IntegrationMonthlyUsageRepository,
    @Inject(STORE_PLATFORM_PORT)
    private readonly storePlatform: StorePlatformPort,
  ) {}

  async reserveVerificationSlot(
    integration: typeof integrations.$inferSelect,
  ): Promise<ReserveVerificationSlotResult> {
    const planId = this.resolvePlanId(integration.billingPlanId);
    const includedLimit = resolveIncludedVerificationsLimit(planId);
    const overageConfig = resolveOverageConfig(planId);
    const periodStart = this.getCurrentMonthStartDate();

    const reservation =
      await this.monthlyUsageRepository.reserveMonthlyVerificationSlot({
        orgId: integration.orgId,
        integrationId: integration.id,
        periodStart,
        includedLimit,
        overageAllowed: overageConfig !== null,
      });

    // If the reservation is an overage, report the charge to Shopify.
    // If Shopify rejects (cap exceeded or API error), roll back the slot.
    if (reservation.allowed && reservation.isOverage && overageConfig) {
      const subscriptionId = integration.shopifySubscriptionId;
      if (!subscriptionId) {
        this.logger.warn(
          `Overage reservation for integration ${integration.id} but no shopifySubscriptionId — releasing slot`,
        );
        await this.monthlyUsageRepository.releaseMonthlyVerificationSlot({
          integrationId: integration.id,
          periodStart,
        });
        return {
          allowed: false,
          isOverage: false,
          consumedCount: reservation.consumedCount,
          includedLimit: reservation.includedLimit,
          periodStart,
          planId,
        };
      }

      try {
        await this.storePlatform.reportUsageCharge(
          integration,
          subscriptionId,
          overageConfig.overageRate,
          'USD',
          `Overage verification (${reservation.consumedCount}/${includedLimit})`,
        );
        this.logger.log(
          `Overage usage record created for integration ${integration.id}: ${overageConfig.overageRate} USD (${reservation.consumedCount}/${includedLimit})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Shopify usage record rejected for integration ${integration.id}: ${message} — releasing overage slot`,
        );
        await this.monthlyUsageRepository.releaseMonthlyVerificationSlot({
          integrationId: integration.id,
          periodStart,
        });
        return {
          allowed: false,
          isOverage: false,
          consumedCount: reservation.consumedCount - 1,
          includedLimit: reservation.includedLimit,
          periodStart,
          planId,
        };
      }
    }

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
