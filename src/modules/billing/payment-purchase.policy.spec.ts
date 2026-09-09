import type {
  DisputeStatus,
  ProviderEventSource,
  PurchaseSignal,
  PurchaseStatus,
} from '../../shared/ports/payments.port';
import {
  decidePurchaseTransition,
  type PurchaseSnapshot,
  type PurchaseTransition,
} from './payment-purchase.policy';

const STATUSES: PurchaseStatus[] = [
  'pending',
  'successful',
  'failed',
  'canceled',
  'expired',
  'refunded',
];
const SIGNALS: PurchaseSignal[] = [
  'success',
  'pending',
  'decline',
  'cancel',
  'void',
  'expiry_confirmed',
  'refund',
  'chargeback_open',
  'chargeback_lost',
  'chargeback_won',
];

/** 100 credits at 200 piastres, fully granted and untouched. */
function snapshot(overrides: Partial<PurchaseSnapshot> = {}): PurchaseSnapshot {
  return {
    status: 'successful',
    disputeStatus: 'none',
    quantity: 100,
    unitPriceMinor: 200,
    totalMinor: 20000,
    refundedMinor: 0,
    refundReversedCredits: 0,
    chargebackReversedCredits: 0,
    chargebackReinstatedCredits: 0,
    ...overrides,
  };
}

function decide(
  input: Partial<PurchaseTransition> & { signal: PurchaseSignal },
) {
  return decidePurchaseTransition({
    current: snapshot(),
    source: 'callback',
    ...input,
  });
}

describe('decidePurchaseTransition', () => {
  describe('expiry authority', () => {
    it.each(['callback', 'inquiry'] as ProviderEventSource[])(
      'expires from %s only when the provider was asked',
      (source) => {
        const decision = decide({
          current: snapshot({ status: 'pending' }),
          signal: 'expiry_confirmed',
          source,
        });
        if (source === 'inquiry')
          expect(decision).toMatchObject({ changed: true, status: 'expired' });
        else
          expect(decision).toMatchObject({
            changed: false,
            status: 'pending',
            rejected: 'not_provider_confirmed',
          });
      },
    );

    it('never expires a purchase that already succeeded', () => {
      expect(
        decide({ signal: 'expiry_confirmed', source: 'inquiry' }),
      ).toMatchObject({ changed: false, status: 'successful' });
    });
  });

  describe('grants', () => {
    it.each(['pending', 'failed', 'canceled', 'expired'] as PurchaseStatus[])(
      'promotes a delayed success from %s and grants once',
      (status) => {
        expect(
          decide({ current: snapshot({ status }), signal: 'success' }),
        ).toMatchObject({
          changed: true,
          status: 'successful',
          grant: { quantity: 100 },
        });
      },
    );

    it('treats a replayed success as a no-op', () => {
      expect(decide({ signal: 'success' })).toMatchObject({
        changed: false,
        grant: null,
        rejected: 'already_final',
      });
    });

    it.each(['pending', 'decline', 'cancel', 'void'] as PurchaseSignal[])(
      'refuses to downgrade a successful purchase on %s',
      (signal) => {
        expect(decide({ signal })).toMatchObject({
          changed: false,
          status: 'successful',
          rejected: 'no_downgrade',
        });
      },
    );

    it.each([
      ['decline', 'failed'],
      ['cancel', 'canceled'],
      ['void', 'canceled'],
    ] as [PurchaseSignal, PurchaseStatus][])(
      'applies %s to a pending purchase as %s',
      (signal, status) => {
        expect(
          decide({ current: snapshot({ status: 'pending' }), signal }),
        ).toMatchObject({ changed: true, status, grant: null });
      },
    );

    it('never changes status on a pending signal', () => {
      expect(
        decide({ current: snapshot({ status: 'pending' }), signal: 'pending' }),
      ).toMatchObject({ changed: false, status: 'pending' });
    });
  });

  describe('refunds', () => {
    it('reverses every credit and refunds the purchase on an exact full refund', () => {
      expect(
        decide({
          signal: 'refund',
          refundedMinorTotal: 20000,
          sourceReference: 'rf-1',
        }),
      ).toMatchObject({
        changed: true,
        status: 'refunded',
        refundedMinor: 20000,
        reversal: {
          type: 'refund_reversal',
          quantity: -100,
          sourceReference: 'rf-1',
        },
        reconciliationCode: null,
      });
    });

    it('reverses whole credits and stays successful on an exact partial refund', () => {
      expect(
        decide({
          signal: 'refund',
          refundedMinorTotal: 3000,
          sourceReference: 'rf-2',
        }),
      ).toMatchObject({
        changed: true,
        status: 'successful',
        refundedMinor: 3000,
        reversal: { type: 'refund_reversal', quantity: -15 },
        reconciliationCode: null,
      });
    });

    it('reverses only the credits a cumulative refund adds', () => {
      expect(
        decide({
          current: snapshot({ refundedMinor: 3000, refundReversedCredits: 15 }),
          signal: 'refund',
          refundedMinorTotal: 5000,
          sourceReference: 'rf-3',
        }),
      ).toMatchObject({ reversal: { quantity: -10 } });
    });

    it('records money but no reversal when a partial refund is not whole credits', () => {
      expect(
        decide({
          signal: 'refund',
          refundedMinorTotal: 3050,
          sourceReference: 'rf-4',
        }),
      ).toMatchObject({
        changed: true,
        status: 'successful',
        refundedMinor: 3050,
        reversal: null,
        reconciliationCode: 'partial_refund_not_whole_credit',
      });
    });

    it.each(['pending', 'failed', 'canceled', 'expired'] as PurchaseStatus[])(
      'quarantines a refund against a %s purchase without reversing credits',
      (status) => {
        expect(
          decide({
            current: snapshot({ status }),
            signal: 'refund',
            refundedMinorTotal: 20000,
            sourceReference: 'rf-5',
          }),
        ).toMatchObject({
          reversal: null,
          reconciliationCode: 'refund_without_success',
          rejected: 'refund_without_success',
        });
      },
    );

    it('ignores a refund notice that adds no money', () => {
      expect(
        decide({
          current: snapshot({ refundedMinor: 5000 }),
          signal: 'refund',
          refundedMinorTotal: 3000,
          sourceReference: 'rf-6',
        }),
      ).toMatchObject({ changed: false, reversal: null });
    });

    it('quarantines a refund with no provider reference to key the reversal on', () => {
      expect(
        decide({ signal: 'refund', refundedMinorTotal: 20000 }),
      ).toMatchObject({ reconciliationCode: 'refund_reference_missing' });
    });
  });

  describe('disputes', () => {
    it('reverses the outstanding credits once when a chargeback opens', () => {
      expect(
        decide({ signal: 'chargeback_open', sourceReference: 'cb-1' }),
      ).toMatchObject({
        changed: true,
        status: 'successful',
        disputeStatus: 'open',
        reversal: { type: 'chargeback_reversal', quantity: -100 },
        reconciliationCode: 'dispute_open',
      });
    });

    it('does not reverse twice when the same chargeback is then lost', () => {
      expect(
        decide({
          current: snapshot({
            disputeStatus: 'open',
            chargebackReversedCredits: 100,
          }),
          signal: 'chargeback_lost',
          sourceReference: 'cb-1',
        }),
      ).toMatchObject({ disputeStatus: 'lost', reversal: null });
    });

    it('reinstates only what the chargeback took back', () => {
      expect(
        decide({
          current: snapshot({
            disputeStatus: 'lost',
            refundReversedCredits: 10,
            chargebackReversedCredits: 90,
          }),
          signal: 'chargeback_won',
          sourceReference: 'cb-1',
        }),
      ).toMatchObject({
        disputeStatus: 'won',
        reversal: {
          type: 'chargeback_reinstatement',
          quantity: 90,
          sourceReference: 'cb-1',
        },
      });
    });

    it('reinstates once', () => {
      expect(
        decide({
          current: snapshot({
            disputeStatus: 'won',
            chargebackReversedCredits: 100,
            chargebackReinstatedCredits: 100,
          }),
          signal: 'chargeback_won',
          sourceReference: 'cb-1',
        }),
      ).toMatchObject({ changed: false, reversal: null });
    });

    it('still records a dispute on a refunded purchase', () => {
      expect(
        decide({
          current: snapshot({
            status: 'refunded',
            refundedMinor: 20000,
            refundReversedCredits: 100,
          }),
          signal: 'chargeback_open',
          sourceReference: 'cb-2',
        }),
      ).toMatchObject({
        status: 'refunded',
        disputeStatus: 'open',
        reversal: null,
      });
    });

    it('quarantines a dispute on a purchase that was never granted', () => {
      expect(
        decide({
          current: snapshot({ status: 'pending' }),
          signal: 'chargeback_open',
          sourceReference: 'cb-3',
        }),
      ).toMatchObject({
        reversal: null,
        reconciliationCode: 'dispute_without_grant',
      });
    });
  });

  describe('invariants across the whole matrix', () => {
    const disputes: DisputeStatus[] = ['none', 'open', 'lost', 'won'];
    const cases = STATUSES.flatMap((status) =>
      disputes.flatMap((disputeStatus) =>
        SIGNALS.flatMap((signal) =>
          (['callback', 'inquiry'] as ProviderEventSource[]).map(
            (source) => [status, disputeStatus, signal, source] as const,
          ),
        ),
      ),
    );

    it.each(cases)(
      '%s/%s + %s from %s never downgrades a settled purchase',
      (status, disputeStatus, signal, source) => {
        const decision = decidePurchaseTransition({
          current: snapshot({ status, disputeStatus }),
          signal,
          source,
          refundedMinorTotal: 20000,
          sourceReference: 'ref-1',
        });
        if (status === 'successful')
          expect(['successful', 'refunded']).toContain(decision.status);
        if (status === 'refunded') expect(decision.status).toBe('refunded');
        // Credits are only ever granted by a success, and only once.
        if (decision.grant) expect(signal).toBe('success');
        if (decision.grant) expect(PROMOTABLE_FROM).toContain(status);
        // Nothing is reversed for a purchase that never received credits.
        if (decision.reversal)
          expect(['successful', 'refunded']).toContain(status);
      },
    );
  });
});

const PROMOTABLE_FROM: PurchaseStatus[] = [
  'pending',
  'failed',
  'canceled',
  'expired',
];
