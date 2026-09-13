/**
 * Shared vocabulary for the prepaid credit domain.
 *
 * The runtime seam is `UsageAccountingRouter`, which picks between
 * `PrepaidCreditAccounting` and `PeriodicPlanAccounting`. Both take the
 * dispatch row itself, because a hold, a consumption and a reversal are all
 * identified by the same `(verification, kind, generation)` dispatch identity
 * the ledger and the reservation are keyed on. This file holds the types that
 * cross module boundaries, not a second description of that seam.
 */

export type CreditAccountStatus = 'active' | 'suspended';
export type CreditReservationStatus = 'held' | 'consumed' | 'released';
export type CreditLedgerType =
  | 'free_grant'
  | 'purchase'
  | 'consumption'
  | 'failure_reversal'
  | 'refund_reversal'
  | 'chargeback_reversal'
  | 'chargeback_reinstatement'
  | 'staff_adjustment';

export interface CreditSummary {
  orgId: string;
  status: CreditAccountStatus;
  postedBalance: number;
  heldCredits: number;
  availableCredits: number;
  debtCredits: number;
  version: number;
}

/** The billable identity of one send, shared by the dispatch, the reservation and the ledger. */
export interface BillableIdentity {
  orgId: string;
  integrationId: string;
  verificationId: string;
  dispatchId: string;
  kind: 'initial' | 'follow_up';
  generation: number;
}
