import type { BillingPlanId } from './billing-plan';
import { usesPrepaidCredits } from './credit-eligibility';

/** The subscription plans whose stores send their logo on messages. */
export const LOGO_HEADER_PLAN_IDS: readonly BillingPlanId[] = [
  'pro',
  'business',
];

/**
 * Whether the store's billing includes the logo header. A prepaid-credit
 * source has no plan tier and always includes it; a subscription source
 * includes it on the plans above. Only the current plan counts: a pending
 * change starts counting once it is active.
 */
export function includesLogoHeader(source: {
  platformType: string | null;
  billingPlanId: string | null;
}): boolean {
  if (usesPrepaidCredits(source)) return true;
  return (
    source.billingPlanId !== null &&
    (LOGO_HEADER_PLAN_IDS as readonly string[]).includes(source.billingPlanId)
  );
}
