import type { CreditSummary } from '../ports/credit-accounting.port';

export type CreditDenialCode =
  | 'STANDALONE_APPROVAL_REQUIRED'
  | 'CREDIT_ACCOUNT_SUSPENDED'
  | 'CREDIT_DEBT_OUTSTANDING'
  | 'INSUFFICIENT_CREDITS'
  | 'PAYMENT_PENDING_RECONCILIATION';

export function creditDenial(
  summary: CreditSummary | undefined,
): CreditDenialCode | null {
  if (!summary || summary.status === 'pending_approval')
    return 'STANDALONE_APPROVAL_REQUIRED';
  if (summary.status === 'suspended') return 'CREDIT_ACCOUNT_SUSPENDED';
  if (summary.debtCredits > 0) return 'CREDIT_DEBT_OUTSTANDING';
  if (summary.availableCredits < 1) return 'INSUFFICIENT_CREDITS';
  return null;
}

export function usesPrepaidCredits(source: { platformType: string }): boolean {
  return source.platformType === 'standalone';
}

export function isCreditDenialCode(value: unknown): value is CreditDenialCode {
  return (
    typeof value === 'string' &&
    [
      'STANDALONE_APPROVAL_REQUIRED',
      'CREDIT_ACCOUNT_SUSPENDED',
      'CREDIT_DEBT_OUTSTANDING',
      'INSUFFICIENT_CREDITS',
      'PAYMENT_PENDING_RECONCILIATION',
    ].includes(value)
  );
}
