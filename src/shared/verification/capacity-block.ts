/**
 * Orders held back because sending capacity ran out.
 *
 * A capacity block is not a failure: the order was accepted and nothing was
 * sent or charged. The verification waits at `blocked` until capacity returns
 * (a recharge, an upgrade or the next period) and is then sent through the
 * ordinary send path. Other refusals (inactive source, unpaid subscription,
 * suspended account) keep their own handling.
 */

/**
 * Refusals that capacity alone resolves. Debt is cleared by a recharge, so it
 * behaves like insufficient credits.
 */
export const CAPACITY_BLOCK_REASONS = [
  'plan_limit_reached',
  'INSUFFICIENT_CREDITS',
  'CREDIT_DEBT_OUTSTANDING',
] as const;

export type CapacityBlockReason = (typeof CAPACITY_BLOCK_REASONS)[number];

/**
 * `metadata.reason` of a blocked order that recovery did not send because it
 * waited longer than the age limit. The order is `failed` and in the
 * merchant's needs-action list; a merchant retry sends it.
 */
export const CAPACITY_BLOCK_STALE_REASON = 'capacity_block_stale';

export const DEFAULT_BLOCKED_ORDER_MAX_AGE_HOURS = 24;

export function isCapacityBlockReason(
  reason: string | null | undefined,
): reason is CapacityBlockReason {
  return (
    reason != null &&
    (CAPACITY_BLOCK_REASONS as readonly string[]).includes(reason)
  );
}

/**
 * No expiry rule exists for an order that was never messaged, and a store-side
 * cancellation or fulfilment is not observed for every platform. So recovery
 * only sends an order that is still recent: a confirmation that arrives days
 * after checkout is likely to reach an order already shipped or abandoned.
 */
export function isBlockedOrderStale(
  orderCreatedAt: string | Date | null | undefined,
  maxAgeHours: number,
  now = new Date(),
): boolean {
  if (!orderCreatedAt) return true;
  const created = new Date(orderCreatedAt).getTime();
  if (!Number.isFinite(created)) return true;
  return now.getTime() - created > maxAgeHours * 3_600_000;
}
