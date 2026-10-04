/**
 * Mirrors the `platform_type` CHECK constraint on `integrations` and
 * `billing_free_plan_claims` (see akeed-backend/drizzle schema). 'shopify'
 * 'standalone' and 'easyorders' have a full spoke under
 * src/infrastructure/spokes/ (EasyOrders ships behind its switches).
 * 'woocommerce' has its connection only so far (US-07-02), behind its switch.
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
