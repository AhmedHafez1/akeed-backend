import type { BillingPlanId } from './billing-plan';
import type { EntitlementAvailability } from './entitlement';

/** Read-only readiness for automatic confirmations, not a reservation or delivery guarantee. */
export interface SendingAvailability {
  available: boolean;
  reason:
    | EntitlementAvailability['reason']
    | 'onboarding_incomplete'
    | 'auto_verify_disabled';
  billingStatus: string | null;
  planState:
    | 'none'
    | 'active'
    | 'cancelled'
    | 'frozen'
    | 'paid_through'
    | 'inactive';
  currentPlanId: BillingPlanId | null;
  lastPlanId: BillingPlanId | null;
  lastPlanName: string | null;
  cancelledAt: string | null;
  paidThroughAt: string | null;
  /** Null if there is no current installation to bound the query. */
  missedOrders: { count: number; since: string; until: string } | null;
}
