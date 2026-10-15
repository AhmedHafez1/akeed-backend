export const MERCHANT_BRANDING_CONFIG = 'merchantBranding';

/**
 * Where merchant logos and banners are stored. The bucket must be public: the
 * provider downloads the banner from its URL when it sends a message.
 */
export interface MerchantBrandingConfig {
  bucket: string;
}

export const DEFAULT_MERCHANT_LOGO_BUCKET = 'merchant-logos';

/** Supabase Storage bucket ids: lowercase letters, digits, dots and dashes. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function parseMerchantBrandingConfig(
  config: Record<string, unknown>,
): MerchantBrandingConfig {
  const raw = config.MERCHANT_LOGO_BUCKET;
  const bucket =
    typeof raw === 'string' && raw.trim().length > 0
      ? raw.trim()
      : DEFAULT_MERCHANT_LOGO_BUCKET;
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new Error(
      'Invalid environment configuration:\n - MERCHANT_LOGO_BUCKET must be a Supabase Storage bucket id (lowercase letters, digits, dots and dashes).',
    );
  }
  return { bucket };
}
