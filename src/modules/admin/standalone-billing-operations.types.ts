import type { CreditAccountStatus } from '../../shared/ports/credit-accounting.port';

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
  sourceContradictory: 'CREDIT_SOURCE_CONTRADICTORY',
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

export type BalanceState = 'none' | 'ok' | 'low' | 'zero' | 'debt';
export const BALANCE_FILTERS = ['low', 'zero', 'debt'] as const;
export type BalanceFilter = (typeof BALANCE_FILTERS)[number];
export const RECONCILIATION_FILTERS = ['required'] as const;
export type ReconciliationFilter = (typeof RECONCILIATION_FILTERS)[number];

export interface AccountFilters {
  accountStatus?: CreditAccountStatus;
  balance?: BalanceFilter;
  reconciliation?: ReconciliationFilter;
}

/** What the account list shows beside each approval row. */
export interface AccountBillingSummary {
  debtCredits: number;
  balanceState: BalanceState;
  projectionConsistent: boolean;
  /** Purchases carrying `reconciliation_required`. */
  flaggedPurchases: number;
  /** Credit holds whose send is `outcome_unknown` and awaits staff. */
  unresolvedHolds: number;
  reconciliationRequired: boolean;
}

export type ContradictionCode =
  | 'reservation_held_with_ledger'
  | 'reservation_held_on_settled_dispatch'
  | 'reservation_consumed_without_consumption'
  | 'reservation_consumed_with_reversal'
  | 'reservation_released_unbalanced'
  | 'purchase_entry_without_success'
  | 'purchase_success_without_entry'
  | 'purchase_reversal_exceeds_grant';

export interface Contradiction {
  code: ContradictionCode;
  reservationId?: string;
  purchaseRef?: string;
}

export interface ReservationFact {
  reservationId: string;
  status: 'held' | 'consumed' | 'released';
  dispatchState: string | null;
  consumed: boolean;
  reversed: boolean;
}

export interface PurchaseFact {
  reference: string;
  status: string;
  quantity: number;
  granted: boolean;
  /** Credits reversed by refunds and chargebacks, net of reinstatements. */
  netReversed: number;
}

export interface ReconciliationReport {
  postedBalance: number;
  heldCredits: number;
  /** Sum of the immutable ledger: what `postedBalance` must equal. */
  ledgerBalance: number;
  /** Credits in `held` reservations: what `heldCredits` must equal. */
  reservationHolds: number;
  postedDifference: number;
  heldDifference: number;
  consistent: boolean;
  contradictions: Contradiction[];
}

export interface OperationsAccess {
  enabled: boolean;
  operator: boolean;
}
