import {
  ONBOARDING_SHIPPING_CURRENCIES,
  type OnboardingShippingCurrency,
} from './dto/onboarding.dto';

export const DEFAULT_SHIPPING_CURRENCY: OnboardingShippingCurrency = 'USD';

/**
 * The store's shipping currency as a supported code: the stored value when it
 * is in the list (any case), otherwise the default. Onboarding shows it and
 * the order import uses it as the default currency.
 */
export function resolveShippingCurrency(
  stored: string | null | undefined,
): OnboardingShippingCurrency {
  const currency = stored?.trim().toUpperCase();
  if (!currency) return DEFAULT_SHIPPING_CURRENCY;
  return ONBOARDING_SHIPPING_CURRENCIES.includes(
    currency as OnboardingShippingCurrency,
  )
    ? (currency as OnboardingShippingCurrency)
    : DEFAULT_SHIPPING_CURRENCY;
}
