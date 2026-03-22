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
    const periodStart = this.getBillingPeriodStart(
      integration.billingActivatedAt,
    );

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

  /**
   * Computes the start of the current 30-day billing period based on the
   * subscription activation date.  Shopify bills on a rolling 30-day cycle
   * from the activation date — not on calendar-month boundaries — so usage
   * accounting must follow the same cadence.
   *
   * Falls back to the 1st of the current UTC month when no activation date
   * is available (e.g. free/starter plans that bypass Shopify billing).
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

    // Count elapsed full days since activation
    const msPerDay = 86_400_000;
    const elapsedMs = now.getTime() - activation.getTime();
    if (elapsedMs < 0) {
      // Activation is in the future; treat activation date as period start
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
