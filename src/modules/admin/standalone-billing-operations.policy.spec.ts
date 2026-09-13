import {
  balanceState,
  buildReconciliationReport,
  findContradictions,
  fingerprint,
} from './standalone-billing-operations.policy';
import type {
  PurchaseFact,
  ReservationFact,
} from './standalone-billing-operations.types';

function reservation(overrides: Partial<ReservationFact>): ReservationFact {
  return {
    reservationId: 'reservation-1',
    status: 'held',
    dispatchState: 'outcome_unknown',
    consumed: false,
    reversed: false,
    ...overrides,
  };
}

function purchase(overrides: Partial<PurchaseFact>): PurchaseFact {
  return {
    reference: 'akd_1',
    status: 'successful',
    quantity: 100,
    granted: true,
    netReversed: 0,
    ...overrides,
  };
}

describe('balanceState', () => {
  it.each([
    [{ status: 'active', postedBalance: -5, heldCredits: 0 }, 'debt'],
    [{ status: 'active', postedBalance: 3, heldCredits: 3 }, 'zero'],
    [{ status: 'active', postedBalance: 10, heldCredits: 0 }, 'low'],
    [{ status: 'active', postedBalance: 11, heldCredits: 0 }, 'ok'],
    [{ status: 'suspended', postedBalance: 1, heldCredits: 0 }, 'low'],
  ] as const)('%o is %s', (account, expected) => {
    expect(balanceState(account, 10)).toBe(expected);
  });

  it('treats a missing account as having no balance state', () => {
    expect(balanceState(null, 10)).toBe('none');
  });
});

describe('findContradictions', () => {
  it('accepts sound reservations and purchases', () => {
    expect(
      findContradictions(
        [
          reservation({}),
          reservation({ status: 'consumed', consumed: true }),
          reservation({ status: 'released' }),
          reservation({ status: 'released', consumed: true, reversed: true }),
        ],
        [
          purchase({}),
          purchase({ status: 'pending', granted: false }),
          purchase({ status: 'refunded', netReversed: 100 }),
        ],
      ),
    ).toEqual([]);
  });

  it.each([
    [reservation({ consumed: true }), 'reservation_held_with_ledger'],
    [
      reservation({ dispatchState: 'accepted' }),
      'reservation_held_on_settled_dispatch',
    ],
    [
      reservation({ dispatchState: 'rejected' }),
      'reservation_held_on_settled_dispatch',
    ],
    [
      reservation({ status: 'consumed' }),
      'reservation_consumed_without_consumption',
    ],
    [
      reservation({ status: 'consumed', consumed: true, reversed: true }),
      'reservation_consumed_with_reversal',
    ],
    [
      reservation({ status: 'released', consumed: true }),
      'reservation_released_unbalanced',
    ],
  ] as const)('flags %o as %s', (fact, code) => {
    expect(findContradictions([fact], [])).toEqual([
      { code, reservationId: 'reservation-1' },
    ]);
  });

  it.each([
    [purchase({ status: 'pending' }), 'purchase_entry_without_success'],
    [purchase({ granted: false }), 'purchase_success_without_entry'],
    [purchase({ netReversed: 101 }), 'purchase_reversal_exceeds_grant'],
    [purchase({ netReversed: -1 }), 'purchase_reversal_exceeds_grant'],
  ] as const)('flags %o as %s', (fact, code) => {
    expect(findContradictions([], [fact])).toEqual([
      { code, purchaseRef: 'akd_1' },
    ]);
  });
});

describe('buildReconciliationReport', () => {
  it('reports how far the projection drifted from its sources', () => {
    expect(
      buildReconciliationReport({
        postedBalance: 30,
        heldCredits: 2,
        ledgerBalance: 25,
        reservationHolds: 1,
        contradictions: [],
      }),
    ).toMatchObject({
      postedDifference: -5,
      heldDifference: -1,
      consistent: false,
    });
  });
});

describe('fingerprint', () => {
  it('changes with any bound value', () => {
    const base = { orgId: 'org-1', version: 3, quantity: 5 };
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, version: 4 }));
    expect(fingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});
