import { isPaidBillingPlan } from './billing-plan';
import { getBillingPeriodEndAt } from './billing-period';

/**
 * Shopify's `app_subscriptions/update` CANCELLED webhook for an uninstall can
 * land before `app/uninstalled` (80 ms earlier in the case that prompted this).
 * A cancel this close to the uninstall is the uninstall's own cancel, so the
 * plan still counts as active until the uninstall. A cancel or freeze earlier
 * than this was the merchant's (or Shopify's) and earns no paid-through date.
 */
export const PAID_THROUGH_CANCEL_GRACE_MS = 5 * 60_000;

const MS_PER_DAY = 86_400_000;

export interface PaidThroughUninstallState {
  billingPlanId: string | null;
  billingStatus: string | null;
  billingActivatedAt: string | null;
  billingCanceledAt: string | null;
  shopifySubscriptionId: string | null;
  paidThroughAt: string | null;
  uninstalledAt: string | null;
}

/**
 * The paid-through date to store when a store uninstalls, or `null` to leave
 * the column as it is. Only the first uninstall of an install decides (a
 * redelivered webhook sees the store already uninstalled). A date still in the
 * future is kept as it is, so uninstall/reinstall loops never move it.
 */
export function resolvePaidThroughAtUninstall(
  state: PaidThroughUninstallState,
  uninstalledAt: string,
): string | null {
  const at = new Date(uninstalledAt);
  if (state.uninstalledAt) return null;
  if (
    state.paidThroughAt &&
    new Date(state.paidThroughAt).getTime() > at.getTime()
  )
    return null;
  if (
    !isPaidBillingPlan(state.billingPlanId) ||
    !state.billingActivatedAt ||
    !state.shopifySubscriptionId ||
    !wasActiveUntil(state, at)
  )
    return null;

  const activation = new Date(state.billingActivatedAt);
  if (isNaN(activation.getTime())) return null;
  // A subscription still in its Shopify trial (activation = first charge, in
  // the future) has been paid for only up to that first charge.
  const end =
    activation.getTime() > at.getTime()
      ? activation.toISOString()
      : getBillingPeriodEndAt(activation, at);
  return end && new Date(end).getTime() > at.getTime() ? end : null;
}

function wasActiveUntil(state: PaidThroughUninstallState, at: Date): boolean {
  const status = state.billingStatus?.trim().toLowerCase() ?? '';
  if (status === 'active') return true;
  if (status !== 'cancelled' && status !== 'canceled') return false;
  if (!state.billingCanceledAt) return false;
  const canceledAt = new Date(state.billingCanceledAt).getTime();
  return (
    Number.isFinite(canceledAt) &&
    canceledAt >= at.getTime() - PAID_THROUGH_CANCEL_GRACE_MS
  );
}

/**
 * Shopify trial days that make a new subscription's first charge fall when the
 * paid-through period ends: whole days, rounded up, from `now`.
 */
export function paidThroughTrialDays(
  paidThroughAt: string | Date | null | undefined,
  now = new Date(),
): number {
  if (!paidThroughAt) return 0;
  const remainingMs = new Date(paidThroughAt).getTime() - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / MS_PER_DAY);
}
