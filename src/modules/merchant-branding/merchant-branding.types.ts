/** What the merchant's settings show about the store's logo. */
export interface MerchantBrandingDto {
  logoUrl: string | null;
  bannerUrl: string | null;
  updatedAt: string | null;
  /** Staff switched the logo header on, so the banner is sent. */
  logoHeaderAvailable: boolean;
}

/** The settings view of a store's logo columns. */
export function toMerchantBrandingDto(integration: {
  logoUrl: string | null;
  logoBannerUrl: string | null;
  logoUpdatedAt: string | null;
  logoHeaderEnabled: boolean;
}): MerchantBrandingDto {
  return {
    logoUrl: integration.logoUrl,
    bannerUrl: integration.logoBannerUrl,
    updatedAt: integration.logoUpdatedAt,
    logoHeaderAvailable: integration.logoHeaderEnabled,
  };
}
