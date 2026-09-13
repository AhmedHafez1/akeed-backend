/**
 * The code vocabulary this module writes to the database and to HTTP clients.
 *
 * `reconciliation_code`, `result_code` and `error_code` are CHECK-constrained
 * to `^[a-z0-9_]{1,80}$` by migration 0032, so a stray capital or hyphen is a
 * 23514 raised inside the money path rather than a lint failure. They are also
 * what finance and staff tooling will filter on, so they are enumerated here
 * instead of written inline at each call site.
 */

/** Purchases and credits are priced in Egyptian piastres. */
export const PURCHASE_CURRENCY = 'EGP';
export const PAYMENT_PROVIDER_PAYMOB = 'paymob';

export const PROVIDER_CODE_PATTERN = /^[a-z0-9_]{1,80}$/;

/** Why a purchase needs a human before it can settle. */
export const RECONCILIATION_CODES = [
  'provider_rejected',
  'provider_unavailable',
  'callback_mismatch',
  'partial_refund_not_whole_credit',
  'refund_without_success',
  'refund_reference_missing',
  'dispute_open',
  'dispute_lost',
  'dispute_without_grant',
  'credit_invariant_frozen',
  'inquiry_unresolved',
  'staff_evidence_mismatch',
] as const;
export type ReconciliationCode = (typeof RECONCILIATION_CODES)[number];

/**
 * The provider name staff-recorded evidence is stored under. It is never a
 * processor, so an event under it can never be mistaken for a verified
 * provider fact.
 */
export const STAFF_EVIDENCE_PROVIDER = 'akeed_staff';

/** What ingestion did with a provider event. */
export const EVENT_RESULT_CODES = [
  'granted',
  'transitioned',
  'no_change',
  'duplicate_event',
  'unmatched_reference',
  'trusted_data_mismatch',
  'unsupported_event_type',
  'credit_invariant_frozen',
] as const;
export type EventResultCode = (typeof EVENT_RESULT_CODES)[number];

/** Which trusted field failed to match, for a quarantined event. */
export const EVENT_ERROR_CODES = [
  'amount_mismatch',
  'currency_mismatch',
  'integration_mismatch',
  'mode_mismatch',
  'ownership_mismatch',
  'refund_without_success',
  'refund_reference_missing',
  'partial_refund_not_whole_credit',
  'dispute_without_grant',
  'dispute_amount_mismatch',
] as const;
export type EventErrorCode = (typeof EVENT_ERROR_CODES)[number];

/**
 * HTTP error codes. Not provider codes -- these travel to the browser and
 * follow the SCREAMING_SNAKE convention the rest of the API already uses.
 */
export const BILLING_ERROR_CODES = {
  validationFailed: 'BILLING_VALIDATION_FAILED',
  disabled: 'BILLING_DISABLED',
  sourceUnsupported: 'BILLING_SOURCE_UNSUPPORTED',
  sourceAmbiguous: 'BILLING_SOURCE_AMBIGUOUS',
  roleRequired: 'BILLING_PURCHASE_ROLE_REQUIRED',
  accountNotProvisioned: 'CREDIT_ACCOUNT_NOT_PROVISIONED',
  accountSuspended: 'CREDIT_ACCOUNT_SUSPENDED',
  idempotencyKeyRequired: 'BILLING_IDEMPOTENCY_KEY_REQUIRED',
  idempotencyConflict: 'BILLING_IDEMPOTENCY_CONFLICT',
  cursorInvalid: 'BILLING_CURSOR_INVALID',
  purchaseNotFound: 'BILLING_PURCHASE_NOT_FOUND',
  providerRejected: 'BILLING_PROVIDER_REJECTED',
  providerUnavailable: 'BILLING_PROVIDER_UNAVAILABLE',
  checkoutAlreadyIssued: 'CHECKOUT_URL_ALREADY_ISSUED',
} as const;

/** Server-owned purchase terms. Nothing here is ever read from the request. */
export interface PurchasePricing {
  priceMinor: number;
  purchaseMin: number;
  purchaseMax: number;
  purchaseStep: number;
  lowBalanceThreshold: number;
}
