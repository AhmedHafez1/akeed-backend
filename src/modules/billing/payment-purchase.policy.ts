import type {
  DisputeStatus,
  ProviderEventSource,
  PurchaseSignal,
  PurchaseStatus,
} from '../../shared/ports/payments.port';
import type { ReconciliationCode } from './billing.types';

/**
 * The canonical purchase state machine.
 *
 * Pure on purpose: every rule in the epic's precedence list is decided here,
 * away from HMAC, HTTP, transactions and provider payloads, so the whole matrix
 * of statuses, dispute states and signals can be asserted directly.
 *
 * Arrival order is deliberately not an input. Providers deliver callbacks out
 * of order and replay them, so precedence -- not sequence -- decides the
 * outcome.
 */

export interface PurchaseSnapshot {
  status: PurchaseStatus;
  disputeStatus: DisputeStatus;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  refundedMinor: number;
  /** Credits already taken back by `refund_reversal` entries. */
  refundReversedCredits: number;
  /** Credits already taken back by `chargeback_reversal` entries. */
  chargebackReversedCredits: number;
  /** Credits already returned by `chargeback_reinstatement` entries. */
  chargebackReinstatedCredits: number;
}

export interface PurchaseTransition {
  current: PurchaseSnapshot;
  signal: PurchaseSignal;
  source: ProviderEventSource;
  /** Cumulative refunded amount reported by the provider, not a delta. */
  refundedMinorTotal?: number;
  /** Provider refund or dispute identifier. */
  sourceReference?: string;
}

export interface LedgerReversal {
  type: 'refund_reversal' | 'chargeback_reversal' | 'chargeback_reinstatement';
  /** Signed to satisfy `credit_ledger_sign_check`. */
  quantity: number;
  sourceReference: string;
}

export type PurchaseRejection =
  | 'not_provider_confirmed'
  | 'no_downgrade'
  | 'already_final'
  | 'refund_without_success'
  | 'refund_reference_missing'
  | 'dispute_without_grant';

export interface PurchaseDecision {
  /** True when the purchase row itself must be written. */
  changed: boolean;
  status: PurchaseStatus;
  disputeStatus: DisputeStatus;
  refundedMinor: number;
  grant: { quantity: number } | null;
  reversal: LedgerReversal | null;
  reconciliationCode: ReconciliationCode | null;
  rejected: PurchaseRejection | null;
}

/** A purchase is only ever granted from these states. */
const PROMOTABLE = new Set<PurchaseStatus>([
  'pending',
  'failed',
  'canceled',
  'expired',
]);
const DOWNGRADES = new Set<PurchaseSignal>([
  'pending',
  'decline',
  'cancel',
  'void',
]);
const DISPUTES = new Set<PurchaseSignal>([
  'chargeback_open',
  'chargeback_lost',
  'chargeback_won',
]);
/** Only a purchase that was actually granted has credits to take back. */
const GRANTED = new Set<PurchaseStatus>(['successful', 'refunded']);

function hold(
  current: PurchaseSnapshot,
  rejected: PurchaseRejection | null = null,
): PurchaseDecision {
  return {
    changed: false,
    status: current.status,
    disputeStatus: current.disputeStatus,
    refundedMinor: current.refundedMinor,
    grant: null,
    reversal: null,
    reconciliationCode: null,
    rejected,
  };
}

/** Records a code for staff without moving the purchase or the ledger. */
function quarantine(
  current: PurchaseSnapshot,
  reconciliationCode: ReconciliationCode,
  rejected: PurchaseRejection | null = null,
): PurchaseDecision {
  return { ...hold(current, rejected), changed: true, reconciliationCode };
}

export function decidePurchaseTransition(
  input: PurchaseTransition,
): PurchaseDecision {
  const { current, signal, source } = input;

  // 1. Expiry is the one transition that needs the provider to be asked, not
  //    to have spoken. A callback -- and certainly a browser redirect -- can
  //    never expire a purchase that may yet succeed.
  if (signal === 'expiry_confirmed') {
    if (source !== 'inquiry') return hold(current, 'not_provider_confirmed');
    if (current.status !== 'pending') return hold(current, 'already_final');
    return { ...hold(current), changed: true, status: 'expired' };
  }

  // 2. Disputes live in their own column and are the only thing a refunded
  //    purchase still reacts to, so they are resolved before status rules.
  if (DISPUTES.has(signal)) return decideDispute(input);

  // 3. Refund dominates success and is the one allowed post-success move, so
  //    it is resolved before the no-downgrade rule.
  if (signal === 'refund') return decideRefund(input);

  if (current.status === 'refunded') return hold(current, 'already_final');

  // 4. A settled payment is never walked backwards by a late failure notice.
  if (current.status === 'successful' && DOWNGRADES.has(signal))
    return hold(current, 'no_downgrade');

  // 5. A verified success promotes any non-final state, however late.
  if (signal === 'success') {
    if (!PROMOTABLE.has(current.status)) return hold(current, 'already_final');
    return {
      ...hold(current),
      changed: true,
      status: 'successful',
      grant: { quantity: current.quantity },
    };
  }

  // 6. `pending` only ever binds provider identifiers.
  if (signal === 'pending') return hold(current);

  // 7. A definitive decline or cancellation, and only from `pending`.
  if (current.status !== 'pending') return hold(current, 'already_final');
  return {
    ...hold(current),
    changed: true,
    status: signal === 'decline' ? 'failed' : 'canceled',
  };
}

function decideRefund(input: PurchaseTransition): PurchaseDecision {
  const { current } = input;
  const refundedMinorTotal = input.refundedMinorTotal ?? 0;
  const sourceReference = input.sourceReference;

  // Refunding something that was never granted is a provider or matching
  // anomaly, not an accounting event. It never reverses credits.
  if (!GRANTED.has(current.status))
    return quarantine(
      current,
      'refund_without_success',
      'refund_without_success',
    );
  if (!sourceReference)
    return quarantine(
      current,
      'refund_reference_missing',
      'refund_reference_missing',
    );
  // The provider reports a cumulative total, so an older or replayed notice
  // carries no new money.
  if (refundedMinorTotal <= current.refundedMinor)
    return hold(current, 'already_final');

  const outstanding = (credits: number) =>
    Math.max(credits - current.refundReversedCredits, 0);
  const reversal = (quantity: number): LedgerReversal | null =>
    quantity > 0
      ? { type: 'refund_reversal', quantity: -quantity, sourceReference }
      : null;

  if (refundedMinorTotal === current.totalMinor)
    return {
      ...hold(current),
      changed: true,
      status: 'refunded',
      refundedMinor: refundedMinorTotal,
      reversal: reversal(outstanding(current.quantity)),
    };

  if (refundedMinorTotal % current.unitPriceMinor === 0)
    return {
      ...hold(current),
      changed: true,
      refundedMinor: refundedMinorTotal,
      reversal: reversal(
        outstanding(refundedMinorTotal / current.unitPriceMinor),
      ),
    };

  // A refund that does not land on a whole credit cannot be settled by an
  // integer ledger. Record the money and leave the credits to staff.
  return {
    ...quarantine(current, 'partial_refund_not_whole_credit'),
    refundedMinor: refundedMinorTotal,
  };
}

function decideDispute(input: PurchaseTransition): PurchaseDecision {
  const { current, signal } = input;
  const sourceReference = input.sourceReference;
  if (!GRANTED.has(current.status))
    return quarantine(
      current,
      'dispute_without_grant',
      'dispute_without_grant',
    );
  if (!sourceReference)
    return quarantine(
      current,
      'refund_reference_missing',
      'refund_reference_missing',
    );

  if (signal === 'chargeback_won') {
    // Only what a chargeback actually took back is put back; a refund on the
    // same purchase stays reversed.
    const owed =
      current.chargebackReversedCredits - current.chargebackReinstatedCredits;
    if (current.disputeStatus === 'won' && owed <= 0)
      return hold(current, 'already_final');
    return {
      ...hold(current),
      changed: true,
      disputeStatus: 'won',
      reversal:
        owed > 0
          ? {
              type: 'chargeback_reinstatement',
              quantity: owed,
              sourceReference,
            }
          : null,
    };
  }

  const disputeStatus: DisputeStatus =
    signal === 'chargeback_open' ? 'open' : 'lost';
  const reconciliationCode: ReconciliationCode =
    signal === 'chargeback_open' ? 'dispute_open' : 'dispute_lost';
  // Opening and then losing the same dispute must not take the credits twice.
  const outstanding = Math.max(
    current.quantity -
      current.refundReversedCredits -
      current.chargebackReversedCredits,
    0,
  );
  if (current.disputeStatus === disputeStatus && outstanding === 0)
    return hold(current, 'already_final');
  return {
    ...hold(current),
    changed: true,
    disputeStatus,
    reconciliationCode,
    reversal:
      outstanding > 0
        ? {
            type: 'chargeback_reversal',
            quantity: -outstanding,
            sourceReference,
          }
        : null,
  };
}
