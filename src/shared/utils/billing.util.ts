import { sql, type SQL } from 'drizzle-orm';

const BILLING_STATUSES_ALLOWING_VERIFICATION: ReadonlySet<string> = new Set([
  'active',
  'not_required',
]);

/**
 * A paid plan given back on reinstall, without a Shopify subscription, for the
 * days the merchant already paid for before uninstalling. It is active only
 * while `paid_through_at` is in the future; after that (or with no date) it
 * reads exactly like `cancelled`. The stored status is never rewritten when the
 * date passes: every reader derives the effective status at read time.
 */
export const PAID_THROUGH_BILLING_STATUS = 'paid_through';

function normalizeStatus(billingStatus: string | null | undefined) {
  return billingStatus?.trim().toLowerCase() ?? '';
}

export function isPaidThroughLive(
  paidThroughAt: string | Date | null | undefined,
  now = new Date(),
): boolean {
  if (!paidThroughAt) return false;
  const end = new Date(paidThroughAt).getTime();
  return Number.isFinite(end) && end > now.getTime();
}

/**
 * `paidThroughAt` is required for a `paid_through` status to count: a caller
 * that does not pass it fails closed.
 */
export function isBillingStatusActive(
  billingStatus: string | null | undefined,
  paidThroughAt?: string | Date | null,
  now = new Date(),
): boolean {
  const normalized = normalizeStatus(billingStatus);
  if (normalized === PAID_THROUGH_BILLING_STATUS)
    return isPaidThroughLive(paidThroughAt, now);
  return !!normalized && BILLING_STATUSES_ALLOWING_VERIFICATION.has(normalized);
}

/** Whether the store is in a live paid-through period (no subscription). */
export function isPaidThroughActive(
  billingStatus: string | null | undefined,
  paidThroughAt: string | Date | null | undefined,
  now = new Date(),
): boolean {
  return (
    normalizeStatus(billingStatus) === PAID_THROUGH_BILLING_STATUS &&
    isPaidThroughLive(paidThroughAt, now)
  );
}

/**
 * The status as readers should see it: a lapsed (or undated) paid-through
 * period is `cancelled`, the same as a store whose subscription was cancelled.
 */
export function effectiveBillingStatus(
  billingStatus: string | null | undefined,
  paidThroughAt: string | Date | null | undefined,
  now = new Date(),
): string | null {
  if (billingStatus == null) return null;
  if (
    normalizeStatus(billingStatus) === PAID_THROUGH_BILLING_STATUS &&
    !isPaidThroughLive(paidThroughAt, now)
  )
    return 'cancelled';
  return billingStatus;
}

/** {@link effectiveBillingStatus} for SQL readers, evaluated against NOW(). */
export function effectiveBillingStatusSql(
  billingStatus: SQL,
  paidThroughAt: SQL,
): SQL {
  return sql`(CASE WHEN lower(btrim(COALESCE(${billingStatus}, ''))) = ${PAID_THROUGH_BILLING_STATUS} AND (${paidThroughAt} IS NULL OR ${paidThroughAt} <= NOW()) THEN 'cancelled' ELSE ${billingStatus} END)`;
}
