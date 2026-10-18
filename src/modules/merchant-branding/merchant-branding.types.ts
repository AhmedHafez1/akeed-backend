import { includesLogoHeader } from '../../shared/billing/plan-features';

/** What the merchant's settings show about the store's logo. */
export interface MerchantBrandingDto {
  logoUrl: string | null;
  bannerUrl: string | null;
  updatedAt: string | null;
  /** The store's logo header is on (staff have not switched it off). */
  logoHeaderAvailable: boolean;
  /** The store's plan includes the logo header; below it the card is locked. */
  logoHeaderIncluded: boolean;
}

/** The switch and the plan, as the settings show them. */
export function logoHeaderAccess(integration: {
  platformType: string | null;
  billingPlanId: string | null;
  logoHeaderEnabled: boolean;
}): Pick<MerchantBrandingDto, 'logoHeaderAvailable' | 'logoHeaderIncluded'> {
  return {
    logoHeaderAvailable: integration.logoHeaderEnabled,
    logoHeaderIncluded: includesLogoHeader(integration),
  };
}

/** The settings view of a store's logo columns. */
export function toMerchantBrandingDto(integration: {
  logoUrl: string | null;
  logoBannerUrl: string | null;
  logoUpdatedAt: string | null;
  platformType: string | null;
  billingPlanId: string | null;
  logoHeaderEnabled: boolean;
}): MerchantBrandingDto {
  return {
    logoUrl: integration.logoUrl,
    bannerUrl: integration.logoBannerUrl,
    updatedAt: integration.logoUpdatedAt,
    ...logoHeaderAccess(integration),
  };
}
