import { Injectable } from '@nestjs/common';
import type { integrations } from '../../infrastructure/database/schema';
import { PlanRequiredNoticesRepository } from '../../infrastructure/database/repositories/plan-required-notices.repository';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { BillingConfigService } from './billing-config.service';
import {
  effectiveBillingStatus,
  isBillingStatusActive,
} from '../../shared/utils/billing.util';
import { isBillingPlanId } from '../../shared/billing/billing-plan';
import type { SendingAvailability } from '../../shared/billing/sending-availability';

@Injectable()
export class SendingAvailabilityService {
  constructor(
    private readonly entitlements: BillingEntitlementService,
    private readonly notices: PlanRequiredNoticesRepository,
    private readonly billingConfig: BillingConfigService,
  ) {}

  async read(
    source: typeof integrations.$inferSelect,
  ): Promise<SendingAvailability> {
    const now = new Date();
    const slot = await this.entitlements.hasAvailableSlot(source);
    const status = effectiveBillingStatus(
      source.billingStatus,
      source.paidThroughAt,
      now,
    );
    const lastPlanId =
      source.billingPlanId && isBillingPlanId(source.billingPlanId)
        ? source.billingPlanId
        : null;
    const active = isBillingStatusActive(
      source.billingStatus,
      source.paidThroughAt,
      now,
    );
    const normalized = status?.trim().toLowerCase();
    const planState: SendingAvailability['planState'] = !lastPlanId
      ? 'none'
      : active
        ? normalized === 'paid_through'
          ? 'paid_through'
          : 'active'
        : normalized === 'cancelled' || normalized === 'canceled'
          ? 'cancelled'
          : normalized === 'frozen'
            ? 'frozen'
            : 'inactive';
    // Billing refusal must remain visible even when automatic confirmation is also off.
    const reason =
      slot.reason ??
      (source.onboardingStatus !== 'completed'
        ? 'onboarding_incomplete'
        : !source.isAutoVerifyEnabled
          ? 'auto_verify_disabled'
          : null);
    return {
      available: slot.available && reason === null,
      reason,
      billingStatus: status,
      planState,
      currentPlanId: active ? lastPlanId : null,
      lastPlanId,
      lastPlanName: lastPlanId
        ? this.billingConfig.resolvePlan(lastPlanId).name
        : null,
      cancelledAt:
        source.billingCanceledAt ??
        (normalized === 'cancelled' && source.billingStatus === 'paid_through'
          ? source.paidThroughAt
          : null),
      paidThroughAt:
        source.billingStatus?.trim().toLowerCase() === 'paid_through'
          ? source.paidThroughAt
          : null,
      missedOrders:
        slot.reason === 'billing_not_active'
          ? await this.notices.countMissedOrders(source, now)
          : null,
    };
  }
}
