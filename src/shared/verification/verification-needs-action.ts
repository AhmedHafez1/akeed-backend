/**
 * Why a verification is waiting on the merchant.
 *
 * The rule that assigns one of these lives in a single SQL expression
 * (`needsActionReasonSql`), so the dashboard's action list, its count, the
 * confirmations tab and each row's reason can never disagree. This file only
 * names the outcomes and the tabs so both the repository and the API speak the
 * same vocabulary.
 */
export const NEEDS_ACTION_REASONS = [
  'delivery_failed',
  'no_reply_after_follow_up',
  'read_no_reply',
  'no_reply',
] as const;

export type NeedsActionReason = (typeof NEEDS_ACTION_REASONS)[number];

/**
 * Reasons the merchant may cancel for: the customer never answered. A delivery
 * failure is left out because the customer never saw the question.
 */
export const NO_REPLY_CANCELLABLE_REASONS = [
  'no_reply_after_follow_up',
  'read_no_reply',
  'no_reply',
] as const satisfies readonly NeedsActionReason[];

/** Every status a no-reply reason can be assigned to. */
export const NO_REPLY_CANCELLABLE_STATUSES = [
  'sent',
  'delivered',
  'read',
  'no_reply',
] as const;

export function isNeedsActionReason(
  value: unknown,
): value is NeedsActionReason {
  return (
    typeof value === 'string' &&
    (NEEDS_ACTION_REASONS as readonly string[]).includes(value)
  );
}

/** Tabs of the confirmations list, each backed by a server-side filter. */
export const VERIFICATION_LIST_TABS = [
  'all',
  'needs_action',
  'confirmed',
  'canceled',
  'failed',
] as const;

export type VerificationListTab = (typeof VERIFICATION_LIST_TABS)[number];

/** Rows the dashboard's "needs action" card shows at most. */
export const NEEDS_ACTION_TOP_LIMIT = 5;

/** Used when a source has no escalation delay of its own. */
export const DEFAULT_ESCALATION_DELAY_MINUTES = 360;
