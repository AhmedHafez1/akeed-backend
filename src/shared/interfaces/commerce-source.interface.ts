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
