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
  'late_reply_after_auto_cancel',
  'no_whatsapp',
  'delivery_failed',
  'send_failed',
  'customer_replied',
  'auto_cancel_failed',
  'no_reply_after_follow_up',
  'read_no_reply',
  'no_reply',
] as const;

export type NeedsActionReason = (typeof NEEDS_ACTION_REASONS)[number];

/**
 * Reasons the merchant may cancel for: the customer never answered, or their
 * number cannot receive WhatsApp and the merchant settled it by phone. A
 * `no_reply` order the customer wrote about without answering, or whose
 * automatic cancellation failed at the store, is still the merchant's to
 * cancel. Other delivery and send failures are left out because the customer
 * never saw the question.
 */
export const NO_REPLY_CANCELLABLE_REASONS = [
  'no_whatsapp',
  'customer_replied',
  'auto_cancel_failed',
  'no_reply_after_follow_up',
  'read_no_reply',
  'no_reply',
] as const satisfies readonly NeedsActionReason[];

/** The statuses those reasons are assigned to. */
export const NO_REPLY_CANCELLABLE_STATUSES = [
  'no_reply',
  'no_whatsapp',
] as const;

/**
 * `cancellation_source` of an order the merchant canceled from Akeed: after
 * the customer never answered, or after calling a customer whose number is not
 * on WhatsApp. Both cancel the order in the store the same way; the source
 * only says why.
 */
export const MERCHANT_CANCELLATION_SOURCES = [
  'merchant_no_reply',
  'merchant_no_whatsapp',
] as const;

export type MerchantCancellationSource =
  (typeof MERCHANT_CANCELLATION_SOURCES)[number];

export function isMerchantCancellationSource(
  value: unknown,
): value is MerchantCancellationSource {
  return (
    typeof value === 'string' &&
    (MERCHANT_CANCELLATION_SOURCES as readonly string[]).includes(value)
  );
}

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
  'no_whatsapp',
] as const;

export type VerificationListTab = (typeof VERIFICATION_LIST_TABS)[number];

/** Rows the dashboard's "needs action" card shows at most. */
export const NEEDS_ACTION_TOP_LIMIT = 3;
