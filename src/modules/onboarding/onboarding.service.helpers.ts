export {
  DEFAULT_BILLING_PLAN_ID,
  isBillingPlanId as isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
  resolveBillingPlan,
  resolveBillingPlans,
  type BillingPlanConfig,
} from '../../shared/billing/billing-plan';

interface BillingRedirectParams {
  shop: string;
  host?: string;
}

export function buildBillingReturnUrl(
  apiUrl: string,
  shopDomain: string,
  host?: string,
): string {
  const url = new URL('/api/onboarding/billing/callback', apiUrl);
  url.searchParams.set('shop', shopDomain);
  if (host) {
    url.searchParams.set('host', host);
  }
  return url.toString();
}

export function buildPostBillingRedirectUrl(
  appUrl: string,
  params: BillingRedirectParams,
): string {
  const url = new URL(appUrl);
  url.searchParams.set('shop', params.shop);

  if (params.host) {
    url.searchParams.set('host', params.host);
  }

  return url.toString();
}

export function resolveBooleanConfig(
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  if (rawValue === undefined) {
    return defaultValue;
  }

  return parseBooleanConfig(rawValue);
}

function parseBooleanConfig(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
