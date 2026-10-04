/**
 * Mirrors the `platform_type` CHECK constraint on `integrations` and
 * `billing_free_plan_claims` (see akeed-backend/drizzle schema). 'shopify'
 * 'standalone' and 'easyorders' have a full spoke under
 * src/infrastructure/spokes/ (EasyOrders ships behind its switches).
 * 'woocommerce' has its connection and order ingestion (US-07-02, US-07-03),
 * each behind its switch; outcome writes are not built yet.
 * 'salla' and 'zid' are reserved, not implemented.
 * Adding/removing a value here requires a matching DB migration to the
 * CHECK constraint, not just a type change.
 */
export const SUPPORTED_PLATFORM_TYPES = [
  'shopify',
  'salla',
  'zid',
  'woocommerce',
  'standalone',
  'easyorders',
] as const;

export type PlatformType = (typeof SUPPORTED_PLATFORM_TYPES)[number];

export function isPlatformType(value: unknown): value is PlatformType {
  return (
    typeof value === 'string' &&
    (SUPPORTED_PLATFORM_TYPES as readonly string[]).includes(value)
  );
}

export type CodStatus = 'cod' | 'non_cod' | 'unknown';
