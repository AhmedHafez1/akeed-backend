export const CREDIT_ACCOUNTING_PORT = Symbol('CREDIT_ACCOUNTING_PORT');

export type CreditAccountStatus = 'pending_approval' | 'active' | 'suspended';
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

export interface BillableIdentity {
  orgId: string;
  integrationId: string;
  verificationId: string;
  dispatchId: string;
  kind: 'initial' | 'follow_up';
  generation: number;
}

export interface CreditOperation {
  orgId: string;
  idempotencyKey: string;
  actorId?: string;
  reason: string;
}

export interface CreditResolution extends CreditOperation {
  reservationId: string;
}

export type CreditMutationResult = {
  outcome: 'applied' | 'duplicate';
  summary: CreditSummary;
  reservationId?: string;
  ledgerEntryId?: string;
};

export interface CreditAccountingPort<Transaction> {
  hold(
    transaction: Transaction,
    input: BillableIdentity & { quantity: number },
  ): Promise<CreditMutationResult>;
  consume(
    transaction: Transaction,
    input: CreditResolution & { providerMessageId: string },
  ): Promise<CreditMutationResult>;
  release(
    transaction: Transaction,
    input: CreditResolution,
  ): Promise<CreditMutationResult>;
  reverse(
    transaction: Transaction,
    input: CreditOperation & {
      sourceLedgerEntryId: string;
      sourceReference?: string;
      type:
        | 'failure_reversal'
        | 'refund_reversal'
        | 'chargeback_reversal'
        | 'chargeback_reinstatement';
      quantity: number;
    },
  ): Promise<CreditMutationResult>;
  grant(
    transaction: Transaction,
    input: CreditOperation &
      (
        | { type: 'free_grant'; quantity: number; actorId: string }
        | { type: 'purchase'; quantity: number; purchaseId: string }
      ),
  ): Promise<CreditMutationResult>;
  adjust(
    transaction: Transaction,
    input: CreditOperation & { actorId: string; quantity: number },
  ): Promise<CreditMutationResult>;
}
