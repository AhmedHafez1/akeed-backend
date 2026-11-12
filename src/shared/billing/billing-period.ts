export function getBillingPeriodStart(
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

export function getBillingPeriodEnd(periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

/**
 * The exact end of the 30-day period that contains `at`, as an ISO timestamp:
 * the activation time plus whole 30-day cycles, the same count
 * {@link getBillingPeriodStart} uses. Its date equals
 * `getBillingPeriodEnd(getBillingPeriodStart(billingActivatedAt, at))`; the
 * time of day is kept so the period does not end hours early. `null` without
 * a usable activation.
 */
export function getBillingPeriodEndAt(
  billingActivatedAt: string | Date | null | undefined,
  at = new Date(),
): string | null {
  if (!billingActivatedAt) return null;
  const activation = new Date(billingActivatedAt);
  if (isNaN(activation.getTime())) return null;
  const msPerDay = 86_400_000;
  const elapsedMs = at.getTime() - activation.getTime();
  const completedCycles =
    elapsedMs < 0 ? 0 : Math.floor(Math.floor(elapsedMs / msPerDay) / 30);
  return new Date(
    activation.getTime() + (completedCycles + 1) * 30 * msPerDay,
  ).toISOString();
}

/**
 * Fixed key for a one-time plan with no usable activation date. It must never
 * derive from `now`, or the allowance would renew with the calendar.
 */
export const ONE_TIME_PLAN_FALLBACK_PERIOD_START = '2000-01-01';

/**
 * The single, non-rolling period a one-time plan's usage is recorded under:
 * the activation date. That is also the key of the first 30-day period, so
 * usage recorded before one-time periods existed still counts.
 */
export function getOneTimePeriodStart(
  billingActivatedAt?: string | Date | null,
): string {
  if (!billingActivatedAt) return ONE_TIME_PLAN_FALLBACK_PERIOD_START;
  const activation = new Date(billingActivatedAt);
  return isNaN(activation.getTime())
    ? ONE_TIME_PLAN_FALLBACK_PERIOD_START
    : activation.toISOString().slice(0, 10);
}
