import type { CreditSummary } from '../ports/credit-accounting.port';
import {
  AKEED_SEND_DISPLAYED_COST,
  displayedBalance,
} from './own-number-billing.policy';

export type CreditDenialCode =
  | 'CREDIT_ACCOUNT_NOT_PROVISIONED'
  | 'CREDIT_ACCOUNT_SUSPENDED'
  | 'CREDIT_DEBT_OUTSTANDING'
  | 'INSUFFICIENT_CREDITS'
  | 'PAYMENT_PENDING_RECONCILIATION';

/**
 * Why the next send cannot be charged, or null.
 *
 * `displayedCost` is what that send costs in displayed credits: 2 from the
 * Akeed number (one stored credit, the default), 1 from the merchant's own
 * number, 0 for a fallback, which charges what is left. With the default it is
 * exactly the old "at least one stored credit available" rule, because a
 * spare alone never reaches 2.
 */
export function creditDenial(
  summary: CreditSummary | undefined,
  displayedCost: number = AKEED_SEND_DISPLAYED_COST,
): CreditDenialCode | null {
  // Provisioning opens the account in the same transaction as the source, so a
  // missing account is a data fault rather than a state a merchant waits in.
  if (!summary) return 'CREDIT_ACCOUNT_NOT_PROVISIONED';
  if (summary.status === 'suspended') return 'CREDIT_ACCOUNT_SUSPENDED';
  if (summary.debtCredits > 0) return 'CREDIT_DEBT_OUTSTANDING';
  if (
    displayedBalance({
      availableStored: summary.availableCredits,
      spare: summary.spareCredit ?? 0,
    }) < displayedCost
  )
    return 'INSUFFICIENT_CREDITS';
  return null;
}

/**
 * The sources metered by prepaid credits: Standalone and the store platforms a
 * merchant connects from it. Shopify settles through its own subscription.
 */
export const PREPAID_CREDIT_PLATFORMS: readonly string[] = [
  'standalone',
  'easyorders',
  'woocommerce',
];

export function usesPrepaidCredits(source: {
  platformType: string | null;
}): boolean {
  return (
    source.platformType !== null &&
    PREPAID_CREDIT_PLATFORMS.includes(source.platformType)
  );
}

export function isCreditDenialCode(value: unknown): value is CreditDenialCode {
  return (
    typeof value === 'string' &&
    [
      'CREDIT_ACCOUNT_NOT_PROVISIONED',
      'CREDIT_ACCOUNT_SUSPENDED',
      'CREDIT_DEBT_OUTSTANDING',
      'INSUFFICIENT_CREDITS',
      'PAYMENT_PENDING_RECONCILIATION',
    ].includes(value)
  );
}
