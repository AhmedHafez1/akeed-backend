import {
  BILLING_PLAN_IDS,
  resolveBillingPlans,
  resolveIncludedVerificationsLimit,
  resolveOwnNumberIncludedVerifications,
} from './billing-plan';
import {
  decidePeriodicCharge,
  decidePrepaidCharge,
  displayedBalance,
  holdsSpareCharge,
  nextSendDisplayedCost,
  periodicUsageForNextSend,
  refundOwnNumberCredit,
  spareAfterCharge,
  storedCreditsForMessages,
  usesCreditReservation,
} from './own-number-billing.policy';

describe('own-number billing policy', () => {
  describe('prepaid charges (displayed credits)', () => {
    it.each([
      // sender, stored, spare, expected
      ['akeed_system', 3, 0, { cost: 2, action: 'reserve' }],
      ['akeed_system', 1, 1, { cost: 2, action: 'reserve' }],
      ['akeed_system', 0, 1, null],
      ['akeed_system', 0, 0, null],
      ['merchant_own', 3, 0, { cost: 1, action: 'pack' }],
      ['merchant_own', 3, 1, { cost: 1, action: 'use_spare' }],
      ['merchant_own', 0, 1, { cost: 1, action: 'use_spare' }],
      ['merchant_own', 0, 0, null],
    ] as const)(
      '%s with %i stored and spare %i',
      (sender, availableStored, spare, expected) => {
        const charge = decidePrepaidCharge({
          sender,
          snapshot: { availableStored, spare },
        });
        expect(charge).toEqual(
          expected
            ? { allowed: true, pool: 'credits', ...expected }
            : { allowed: false, reason: 'INSUFFICIENT_CREDITS' },
        );
      },
    );

    it('charges a fallback the full Akeed-number price or refuses it', () => {
      // A fallback is an Akeed-number send: a spare alone or an empty
      // balance no longer lets it go out for 1 or 0 credits.
      expect(
        decidePrepaidCharge({
          sender: 'akeed_system',
          snapshot: { availableStored: 0, spare: 1 },
        }),
      ).toEqual({ allowed: false, reason: 'INSUFFICIENT_CREDITS' });
      expect(
        decidePrepaidCharge({
          sender: 'akeed_system',
          snapshot: { availableStored: -4, spare: 0 },
        }),
      ).toEqual({ allowed: false, reason: 'INSUFFICIENT_CREDITS' });
    });

    it('charges exactly one stored credit for two own-number sends, on the first', () => {
      let stored = 5;
      let spare = 0;
      const posted: number[] = [];
      for (let send = 0; send < 2; send++) {
        const charge = decidePrepaidCharge({
          sender: 'merchant_own',
          snapshot: { availableStored: stored, spare },
        });
        if (!charge.allowed || charge.action === 'reserve')
          throw new Error('unexpected');
        if (charge.action === 'pack') stored -= 1;
        posted.push(stored);
        spare = spareAfterCharge(charge.action, spare);
      }
      expect(posted).toEqual([4, 4]);
      expect(spare).toBe(0);
    });

    it('returns a spare, and two spares become a stored credit', () => {
      expect(refundOwnNumberCredit(0)).toEqual({ spare: 1, reversal: false });
      expect(refundOwnNumberCredit(1)).toEqual({ spare: 0, reversal: true });
    });

    it('refuses impossible spare transitions', () => {
      expect(() => spareAfterCharge('pack', 1)).toThrow();
      expect(() => spareAfterCharge('use_spare', 0)).toThrow();
    });

    it('displays stored credits as two and the spare as one', () => {
      expect(displayedBalance({ availableStored: 3, spare: 1 })).toBe(7);
      expect(displayedBalance({ availableStored: -2, spare: 0 })).toBe(0);
    });

    it('prices the next send by its likely sender', () => {
      expect(nextSendDisplayedCost('akeed_system')).toBe(2);
      expect(nextSendDisplayedCost('merchant_own')).toBe(1);
    });

    it.each([
      [10, 'akeed_system', 1, 10],
      [10, 'merchant_own', 0, 5],
      [10, 'merchant_own', 1, 5],
      [11, 'merchant_own', 0, 6],
      [11, 'merchant_own', 1, 5],
      [1, 'merchant_own', 1, 0],
    ] as const)(
      '%i messages from %s with spare %i need %i stored credits',
      (messages, sender, spare, stored) => {
        expect(storedCreditsForMessages(messages, sender, spare)).toBe(stored);
      },
    );

    it('tells reservation charges from own-number charges, including recorded partial fallbacks', () => {
      expect(
        usesCreditReservation({ billingPool: null, billingCost: null }),
      ).toBe(true);
      expect(
        usesCreditReservation({ billingPool: 'credits', billingCost: 2 }),
      ).toBe(true);
      expect(
        usesCreditReservation({ billingPool: 'credits', billingCost: 1 }),
      ).toBe(false);
      // Rows recorded before fallbacks were charged in full still settle.
      expect(
        usesCreditReservation({ billingPool: 'credits', billingCost: 0 }),
      ).toBe(false);
      expect(
        holdsSpareCharge({
          billingPool: 'credits',
          billingCost: 1,
          billingRefundedAt: null,
        }),
      ).toBe(true);
      expect(
        holdsSpareCharge({
          billingPool: 'credits',
          billingCost: 1,
          billingRefundedAt: '2026-11-03T00:00:00Z',
        }),
      ).toBe(false);
      expect(
        holdsSpareCharge({
          billingPool: 'credits',
          billingCost: 0,
          billingRefundedAt: null,
        }),
      ).toBe(false);
    });
  });

  describe('Shopify pools', () => {
    it.each([
      ['starter', 60, 200],
      ['basic', 300, 2000],
      ['pro', 1000, 5000],
      ['business', 2500, 20000],
    ] as const)(
      '%s gives %i Akeed and %i own-number messages',
      (planId, akeed, own) => {
        expect(resolveIncludedVerificationsLimit(planId)).toBe(akeed);
        expect(resolveOwnNumberIncludedVerifications(planId)).toBe(own);
      },
    );

    it('keeps plan ids and prices, and every own-number pool is finite', () => {
      const plans = resolveBillingPlans({
        currencyCode: 'USD',
        testMode: true,
      });
      expect(plans.map((plan) => [plan.id, plan.amount])).toEqual([
        ['starter', 0],
        ['basic', 9.99],
        ['pro', 22.99],
        ['business', 49.99],
      ]);
      for (const plan of plans) {
        expect(Number.isSafeInteger(plan.ownNumberIncludedVerifications)).toBe(
          true,
        );
        expect(plan.ownNumberIncludedVerifications).toBeGreaterThan(0);
      }
      expect(BILLING_PLAN_IDS).toEqual(['starter', 'basic', 'pro', 'business']);
    });

    it('gives no own-number pool without a plan', () => {
      expect(resolveOwnNumberIncludedVerifications(null)).toBe(0);
    });

    it.each([
      ['starter', 60, 200],
      ['basic', 300, 2000],
      ['pro', 1000, 5000],
      ['business', 2500, 20000],
    ] as const)(
      '%s: each pool pays for its own sender, an own number spills into the Akeed pool',
      (_, akeedLimit, ownLimit) => {
        const charge = (
          sender: 'akeed_system' | 'merchant_own',
          akeedUsed: number,
          ownUsed: number,
        ) =>
          decidePeriodicCharge({
            sender,
            snapshot: { akeedUsed, akeedLimit, ownUsed, ownLimit },
          });
        const blocked = { allowed: false, reason: 'plan_limit_reached' };
        // Own number: its pool to the last unit, then the Akeed pool (D11).
        expect(charge('merchant_own', 0, ownLimit - 1)).toEqual({
          allowed: true,
          pool: 'own_number',
          cost: 1,
        });
        expect(charge('merchant_own', akeedLimit - 1, ownLimit)).toEqual({
          allowed: true,
          pool: 'akeed',
          cost: 1,
        });
        expect(charge('merchant_own', akeedLimit, ownLimit)).toEqual(blocked);
        // Akeed's number, fallbacks included: the Akeed pool only.
        expect(charge('akeed_system', akeedLimit - 1, ownLimit)).toEqual({
          allowed: true,
          pool: 'akeed',
          cost: 1,
        });
        for (const ownUsed of [0, ownLimit - 2, ownLimit])
          expect(charge('akeed_system', akeedLimit, ownUsed)).toEqual(blocked);
        // An empty Akeed pool never stops the own number while it has room.
        expect(charge('merchant_own', akeedLimit, 10)).toEqual({
          allowed: true,
          pool: 'own_number',
          cost: 1,
        });
      },
    );

    it('counts both pools only while the next send uses the own number', () => {
      const pools = {
        akeedUsed: 100,
        akeedLimit: 300,
        ownUsed: 200,
        ownLimit: 1000,
      };
      expect(periodicUsageForNextSend(pools, 'merchant_own')).toEqual({
        used: 300,
        limit: 1300,
      });
      expect(periodicUsageForNextSend(pools, 'akeed_system')).toEqual({
        used: 100,
        limit: 300,
      });
    });
  });
});
