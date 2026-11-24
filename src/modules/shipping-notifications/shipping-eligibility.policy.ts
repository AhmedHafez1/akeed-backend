import type { ShippingFailureReason } from '../../shared/shipping/shipping-notification.types';

/** Orders older than this never get a shipping notification. */
export const SHIPPING_MAX_ORDER_AGE_DAYS = 30;
const MAX_ORDER_AGE_MS = SHIPPING_MAX_ORDER_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface ShippingEligibilityFacts {
  /** The order or the store event is a test. */
  isTest: boolean;
  verificationStatus: string;
  verificationCanceledAt: string | null;
  merchantCanceledAt: string | null;
  /** When the store cancelled the order, from the event. */
  sourceCancelledAt: string | null;
  /** The store's own creation time of the order, from the event. */
  sourceCreatedAt: string | null;
  /** When Akeed received the order; used when the store's time is unreadable. */
  orderCreatedAt: string | null;
  now: Date;
}

export type ShippingEligibility =
  | { write: false }
  | { write: true; status: 'pending' }
  | { write: true; status: 'failed'; reason: ShippingFailureReason };

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Whether a shipped order gets a notification. A test order writes nothing.
 * A cancelled or too-old order still writes a failed record, so the merchant
 * sees why no message went out.
 */
export function evaluateShippingEligibility(
  facts: ShippingEligibilityFacts,
): ShippingEligibility {
  if (facts.isTest) return { write: false };
  if (
    facts.verificationStatus === 'canceled' ||
    facts.verificationCanceledAt !== null ||
    facts.merchantCanceledAt !== null ||
    facts.sourceCancelledAt !== null
  ) {
    return { write: true, status: 'failed', reason: 'order_cancelled' };
  }
  const createdAt =
    parseTime(facts.sourceCreatedAt) ?? parseTime(facts.orderCreatedAt);
  if (
    createdAt !== null &&
    facts.now.getTime() - createdAt > MAX_ORDER_AGE_MS
  ) {
    return { write: true, status: 'failed', reason: 'order_too_old' };
  }
  return { write: true, status: 'pending' };
}
