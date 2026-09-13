import { createHash } from 'node:crypto';
import type {
  BalanceState,
  Contradiction,
  PurchaseFact,
  ReconciliationReport,
  ReservationFact,
} from './standalone-billing-operations.types';

/**
 * Pure rules for the staff billing console, kept away from HTTP and SQL so
 * every branch can be asserted directly.
 */

export function balanceState(
  account: {
    status: string;
    postedBalance: number;
    heldCredits: number;
  } | null,
  lowBalanceThreshold: number,
): BalanceState {
  if (!account) return 'none';
  if (account.postedBalance < 0) return 'debt';
  const available = Math.max(account.postedBalance - account.heldCredits, 0);
  if (available === 0) return 'zero';
  return available <= lowBalanceThreshold ? 'low' : 'ok';
}

/**
 * Names every source row that disagrees with another source row.
 *
 * These are different from a projection mismatch. A projection that has
 * drifted from a sound ledger and reservation set can be rebuilt from them; a
 * reservation marked consumed with no consumption entry cannot, because there
 * is no way to tell which of the two is the lie. Repair refuses while any of
 * these exist.
 */
export function findContradictions(
  reservations: ReservationFact[],
  purchases: PurchaseFact[],
): Contradiction[] {
  const found: Contradiction[] = [];
  for (const reservation of reservations) {
    const add = (code: Contradiction['code']) =>
      found.push({ code, reservationId: reservation.reservationId });
    if (reservation.status === 'held') {
      if (reservation.consumed || reservation.reversed)
        add('reservation_held_with_ledger');
      // Acceptance consumes and rejection releases in the same transaction
      // that settles the dispatch, so a hold can only outlive an unsettled one.
      if (
        reservation.dispatchState === 'accepted' ||
        reservation.dispatchState === 'rejected'
      )
        add('reservation_held_on_settled_dispatch');
    } else if (reservation.status === 'consumed') {
      if (!reservation.consumed)
        add('reservation_consumed_without_consumption');
      if (reservation.reversed) add('reservation_consumed_with_reversal');
    } else if (reservation.consumed !== reservation.reversed) {
      add('reservation_released_unbalanced');
    }
  }
  for (const purchase of purchases) {
    const add = (code: Contradiction['code']) =>
      found.push({ code, purchaseRef: purchase.reference });
    const settled =
      purchase.status === 'successful' || purchase.status === 'refunded';
    if (purchase.granted && !settled) add('purchase_entry_without_success');
    if (!purchase.granted && settled) add('purchase_success_without_entry');
    if (purchase.netReversed > purchase.quantity || purchase.netReversed < 0)
      add('purchase_reversal_exceeds_grant');
  }
  return found;
}

export function buildReconciliationReport(input: {
  postedBalance: number;
  heldCredits: number;
  ledgerBalance: number;
  reservationHolds: number;
  contradictions: Contradiction[];
}): ReconciliationReport {
  const postedDifference = input.ledgerBalance - input.postedBalance;
  const heldDifference = input.reservationHolds - input.heldCredits;
  return {
    postedBalance: input.postedBalance,
    heldCredits: input.heldCredits,
    ledgerBalance: input.ledgerBalance,
    reservationHolds: input.reservationHolds,
    postedDifference,
    heldDifference,
    consistent: postedDifference === 0 && heldDifference === 0,
    contradictions: input.contradictions,
  };
}

/**
 * Binds a preview to the exact state it was taken from. Any send, grant,
 * refund or earlier adjustment bumps the account version, so an apply against
 * a changed account is refused instead of trusting a stale review.
 */
export function fingerprint(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
