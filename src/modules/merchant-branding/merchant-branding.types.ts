/** What the merchant's settings show about the store's logo. */
export interface MerchantBrandingDto {
  logoUrl: string | null;
  bannerUrl: string | null;
  updatedAt: string | null;
  /** The store's logo header is on (staff have not switched it off). */
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
