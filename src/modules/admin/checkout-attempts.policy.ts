/**
 * What happened to a merchant's latest live checkout, in the words staff use
 * when they follow up: did the merchant pay, did the bank decline, or did they
 * leave the Paymob page without paying.
 */
export const CHECKOUT_OUTCOMES = [
  'paid',
  'declined',
  'failed',
  'canceled',
  'left_checkout',
  'in_checkout',
] as const;
export type CheckoutOutcome = (typeof CHECKOUT_OUTCOMES)[number];

/** Which merchants the list shows: every one, or split by whether they ever paid. */
export const CHECKOUT_PAID_FILTERS = ['all', 'unpaid', 'paid'] as const;
export type CheckoutPaidFilter = (typeof CHECKOUT_PAID_FILTERS)[number];

export interface LatestCheckout {
  status: string;
  /** The provider's decline code from the latest verified callback, if any. */
  declineCode: string | null;
  checkoutExpiresAt: string | null;
}

/**
 * A pending checkout past its window counts as left: Paymob reported no payment
 * in time, so the merchant is someone to contact rather than someone paying.
 */
export function checkoutOutcome(
  latest: LatestCheckout,
  now: number,
): CheckoutOutcome {
  switch (latest.status) {
    case 'successful':
    case 'refunded':
      return 'paid';
    case 'failed':
      return latest.declineCode ? 'declined' : 'failed';
    case 'canceled':
      return 'canceled';
    case 'expired':
      return 'left_checkout';
    default:
      return latest.checkoutExpiresAt &&
        Date.parse(latest.checkoutExpiresAt) <= now
        ? 'left_checkout'
        : 'in_checkout';
  }
}
