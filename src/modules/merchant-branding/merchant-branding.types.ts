/** What the merchant's settings show about the store's logo. */
export interface MerchantBrandingDto {
  logoUrl: string | null;
  bannerUrl: string | null;
  updatedAt: string | null;
  /** The store's logo header is on (staff have not switched it off). */
  logoHeaderAvailable: boolean;
}

/** The staff switch, as the settings show it. */
export function logoHeaderAccess(integration: {
  logoHeaderEnabled: boolean;
}): Pick<MerchantBrandingDto, 'logoHeaderAvailable'> {
  return { logoHeaderAvailable: integration.logoHeaderEnabled };
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
    ...logoHeaderAccess(integration),
  };
}
