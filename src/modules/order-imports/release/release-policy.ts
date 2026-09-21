import {
  adjustForQuietHours,
  nextQuietHoursStart,
  type QuietHoursConfig,
} from '../../../shared/utils/quiet-hours.util';

/** The release job runs twice a minute. */
export const RELEASE_TICK_MS = 30_000;

const MS_PER_MINUTE = 60_000;
/** Bounds the estimate loop; every iteration crosses at least one window. */
const MAX_ESTIMATE_STEPS = 1_000;

/**
 * Held events one tick may release for an organization, shared by all of its
 * releasing batches, so two imports never double the pace.
 */
export function releaseBudgetPerTick(ratePerMinute: number): number {
  return Math.ceil(ratePerMinute * (RELEASE_TICK_MS / MS_PER_MINUTE));
}

/**
 * Credits the Buy button proposes for a shortfall: at least the smallest
 * useful pack, rounded up to the next 50.
 */
export function suggestedCreditPurchase(shortfall: number): number {
  return Math.max(100, Math.ceil(Math.max(shortfall, 0) / 50) * 50);
}

/**
 * Minutes until `orders` held events are released at `ratePerMinute`, starting
 * `now`: the sending minutes, `ceil(orders / rate)`, plus every quiet-hours
 * window the sending span runs into, in the store's timezone.
 */
export function estimateReleaseMinutes(params: {
  orders: number;
  ratePerMinute: number;
  now: Date;
  quietHours: QuietHoursConfig;
}): number {
  let remaining = Math.ceil(
    Math.max(params.orders, 0) / Math.max(params.ratePerMinute, 1),
  );
  let cursor = params.now;
  let total = 0;
  for (let step = 0; remaining > 0 && step < MAX_ESTIMATE_STEPS; step++) {
    const resumesAt = adjustForQuietHours(cursor, params.quietHours);
    if (resumesAt.getTime() > cursor.getTime()) {
      total += Math.ceil(
        (resumesAt.getTime() - cursor.getTime()) / MS_PER_MINUTE,
      );
      cursor = resumesAt;
      continue;
    }
    const nextQuiet = nextQuietHoursStart(cursor, params.quietHours);
    const open = nextQuiet
      ? Math.max(
          Math.floor((nextQuiet.getTime() - cursor.getTime()) / MS_PER_MINUTE),
          1,
        )
      : remaining;
    const sending = Math.min(remaining, open);
    total += sending;
    remaining -= sending;
    cursor = new Date(cursor.getTime() + sending * MS_PER_MINUTE);
  }
  return total + remaining;
}
