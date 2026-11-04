import { ownNumberLimit, ownNumberMultiplier } from './billing-plan';
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
      // sender, rule, stored, spare, expected
      ['akeed_system', 'standard', 3, 0, { cost: 2, action: 'reserve' }],
      ['akeed_system', 'standard', 1, 1, { cost: 2, action: 'reserve' }],
      ['akeed_system', 'standard', 0, 1, null],
      ['akeed_system', 'standard', 0, 0, null],
      ['merchant_own', 'standard', 3, 0, { cost: 1, action: 'pack' }],
      ['merchant_own', 'standard', 3, 1, { cost: 1, action: 'use_spare' }],
      ['merchant_own', 'standard', 0, 1, { cost: 1, action: 'use_spare' }],
      ['merchant_own', 'standard', 0, 0, null],
      ['akeed_system', 'fallback', 1, 0, { cost: 2, action: 'reserve' }],
      ['akeed_system', 'fallback', 1, 1, { cost: 2, action: 'reserve' }],
      ['akeed_system', 'fallback', 0, 1, { cost: 1, action: 'use_spare' }],
      ['akeed_system', 'fallback', 0, 0, { cost: 0, action: 'none' }],
    ] as const)(
      '%s %s with %i stored and spare %i',
      (sender, rule, availableStored, spare, expected) => {
        const charge = decidePrepaidCharge({
          sender,
          rule,
          snapshot: { availableStored, spare },
        });
        expect(charge).toEqual(
          expected
            ? { allowed: true, pool: 'credits', ...expected }
            : { allowed: false, reason: 'INSUFFICIENT_CREDITS' },
        );
      },
    );

    it('treats a negative available balance as empty', () => {
      expect(
        decidePrepaidCharge({
          sender: 'akeed_system',
          rule: 'fallback',
          snapshot: { availableStored: -4, spare: 0 },
        }),
      ).toMatchObject({ allowed: true, cost: 0, action: 'none' });
    });

    it('charges exactly one stored credit for two own-number sends, on the first', () => {
      let stored = 5;
      let spare = 0;
      const posted: number[] = [];
      for (let send = 0; send < 2; send++) {
        const charge = decidePrepaidCharge({
          sender: 'merchant_own',
          rule: 'standard',
          snapshot: { availableStored: stored, spare },
        });
        if (!charge.allowed || charge.action === 'reserve')
          throw new Error('unexpected');
        if (charge.action === 'pack') stored -= 1;
        posted.push(stored);
        spare = spareAfterCharge(charge.action as 'pack' | 'use_spare', spare);
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

    it('tells reservation charges from own-number charges', () => {
      expect(
        usesCreditReservation({ billingPool: null, billingCost: null }),
      ).toBe(true);
      expect(
        usesCreditReservation({ billingPool: 'credits', billingCost: 2 }),
      ).toBe(true);
      expect(
        usesCreditReservation({ billingPool: 'credits', billingCost: 1 }),
      ).toBe(false);
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
      ['starter', 30, 90],
      ['basic', 300, 900],
      ['pro', 1000, 3000],
      ['scale', 2500, 7500],
    ])('%s gives %i Akeed and %i own-number messages', (_, akeed, own) => {
      expect(ownNumberLimit(akeed)).toBe(own);
    });

    it('uses a multiplier of three', () => {
      expect(ownNumberMultiplier).toBe(3);
    });

    const pools = (akeedUsed: number, ownUsed: number) => ({
      akeedUsed,
      akeedLimit: 300,
      ownUsed,
      ownLimit: 900,
    });

    it.each([
      // sender, rule, akeed used, own used, expected
      ['akeed_system', 'standard', 0, 0, { pool: 'akeed', cost: 1 }],
      ['akeed_system', 'standard', 300, 0, null],
      ['merchant_own', 'standard', 0, 0, { pool: 'own_number', cost: 1 }],
      ['merchant_own', 'standard', 300, 899, { pool: 'own_number', cost: 1 }],
      // D11: own pool empty, number healthy, Akeed pool not empty.
      ['merchant_own', 'standard', 0, 900, { pool: 'akeed', cost: 1 }],
      ['merchant_own', 'standard', 300, 900, null],
      ['akeed_system', 'fallback', 299, 900, { pool: 'akeed', cost: 1 }],
      // D4: Akeed pool empty takes 3 from the own pool, or what is left.
      ['akeed_system', 'fallback', 300, 0, { pool: 'own_number', cost: 3 }],
      ['akeed_system', 'fallback', 300, 898, { pool: 'own_number', cost: 2 }],
      ['akeed_system', 'fallback', 300, 900, { pool: 'own_number', cost: 0 }],
    ] as const)(
      '%s %s with %i Akeed and %i own used',
      (sender, rule, akeedUsed, ownUsed, expected) => {
        expect(
          decidePeriodicCharge({
            sender,
            rule,
            snapshot: pools(akeedUsed, ownUsed),
          }),
        ).toEqual(
          expected
            ? { allowed: true, ...expected }
            : { allowed: false, reason: 'plan_limit_reached' },
        );
      },
    );

    it('counts both pools only while the next send uses the own number', () => {
      expect(periodicUsageForNextSend(pools(100, 200), 'merchant_own')).toEqual(
        { used: 300, limit: 1200 },
      );
      expect(periodicUsageForNextSend(pools(100, 200), 'akeed_system')).toEqual(
        { used: 100, limit: 300 },
      );
    });
  });
});
