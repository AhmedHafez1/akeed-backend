/**
 * HTTP error codes the staff billing console answers with. They travel to the
 * browser and follow the SCREAMING_SNAKE convention of the merchant billing
 * API; the console localizes them.
 */
export const STAFF_BILLING_ERROR_CODES = {
  operationsDisabled: 'STANDALONE_BILLING_OPERATIONS_DISABLED',
  operatorRequired: 'STANDALONE_BILLING_OPERATOR_REQUIRED',
  accountNotFound: 'BILLING_ACCOUNT_NOT_FOUND',
  accountNotApproved: 'BILLING_ACCOUNT_NOT_APPROVED',
  projectionMismatch: 'CREDIT_PROJECTION_MISMATCH',
  previewNotFound: 'BILLING_PREVIEW_NOT_FOUND',
  previewStale: 'BILLING_PREVIEW_STALE',
  previewAlreadyApplied: 'BILLING_PREVIEW_ALREADY_APPLIED',
  idempotencyKeyRequired: 'BILLING_IDEMPOTENCY_KEY_REQUIRED',
  idempotencyConflict: 'BILLING_IDEMPOTENCY_CONFLICT',
  dispatchNotFound: 'BILLING_DISPATCH_NOT_FOUND',
  dispatchNotCreditBilled: 'BILLING_DISPATCH_NOT_CREDIT_BILLED',
  dispatchResolutionConflict: 'MESSAGE_DISPATCH_RESOLUTION_CONFLICT',
  purchaseNotFound: 'BILLING_PURCHASE_NOT_FOUND',
  purchaseNotEligible: 'BILLING_PURCHASE_NOT_ELIGIBLE',
  repairContradictory: 'REPAIR_SOURCE_CONTRADICTORY',
} as const;

export type StaffBillingErrorCode =
  (typeof STAFF_BILLING_ERROR_CODES)[keyof typeof STAFF_BILLING_ERROR_CODES];
