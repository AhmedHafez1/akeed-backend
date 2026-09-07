/**
 * Prefix assigned to orders created by the "send a test message" flow
 * (test-verification.service.ts) so downstream code can recognize and skip
 * them (no external commerce action, excluded from milestone tracking, etc.)
 * without a dedicated column round-trip.
 */
export const SYNTHETIC_TEST_ORDER_ID_PREFIX = 'akeed-test-';

export function isSyntheticTestOrderId(
  externalOrderId?: string | null,
): boolean {
  return Boolean(externalOrderId?.startsWith(SYNTHETIC_TEST_ORDER_ID_PREFIX));
}

/** True when an order is a synthetic test send, by flag or by id convention. */
export function isSyntheticOrder(
  order:
    | { isTest?: boolean | null; externalOrderId?: string | null }
    | null
    | undefined,
): boolean {
  return Boolean(
    order?.isTest === true || isSyntheticTestOrderId(order?.externalOrderId),
  );
}
