/** A store is deletable only after this long, so a new store is never lost. */
export const STORE_DELETION_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type AdminStoreDeletionBlock =
  | 'not_critical_or_uninstalled'
  | 'installed_recently'
  | 'has_usage'
  | 'has_credit_history'
  | 'shares_organization';

export interface AdminStoreDeletionFacts {
  healthStatus: string;
  lifecycleStatus: string;
  installedAt: string;
  usageUsed: number;
  /** A real (non-test) message sent, a customer message or an answer. */
  hasRealActivity: boolean;
  /** Credit ledger or payment rows, which the database keeps forever. */
  hasCreditHistory: boolean;
  /** Stores in the store's organization, itself included. */
  orgStoreCount: number;
}

/**
 * Why staff may not delete this store, or null when they may. Deleting removes
 * the whole organization, so only dead stores qualify: critical or
 * uninstalled, older than a week, never used, with no credit history and no
 * other store in the organization.
 */
export function storeDeletionBlock(
  facts: AdminStoreDeletionFacts,
  now: Date,
): AdminStoreDeletionBlock | null {
  if (
    facts.healthStatus !== 'critical' &&
    facts.lifecycleStatus !== 'uninstalled'
  )
    return 'not_critical_or_uninstalled';
  const installedAt = Date.parse(facts.installedAt);
  if (
    !Number.isFinite(installedAt) ||
    now.getTime() - installedAt <= STORE_DELETION_MIN_AGE_MS
  )
    return 'installed_recently';
  if (facts.usageUsed > 0 || facts.hasRealActivity) return 'has_usage';
  if (facts.hasCreditHistory) return 'has_credit_history';
  if (facts.orgStoreCount !== 1) return 'shares_organization';
  return null;
}
