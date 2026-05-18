const BILLING_STATUSES_ALLOWING_VERIFICATION: ReadonlySet<string> = new Set([
  'active',
  'not_required',
]);

export function isBillingStatusActive(
  billingStatus: string | null | undefined,
): boolean {
  const normalized = billingStatus?.trim().toLowerCase();
  return !!normalized && BILLING_STATUSES_ALLOWING_VERIFICATION.has(normalized);
}
