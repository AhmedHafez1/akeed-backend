import { resolvePeriodicPlanAllowances } from './billing-plan';
import { decidePeriodicCharge } from './own-number-billing.policy';
import { decideShippingCharge } from './shipping-charge.policy';

const pools = (
  akeedUsed: number,
  akeedLimit: number,
  ownUsed = 0,
  ownLimit = 0,
) => ({ akeedUsed, akeedLimit, ownUsed, ownLimit });

describe('decideShippingCharge: Akeed number', () => {
  const send = (akeedUsed: number, akeedLimit: number) =>
    decideShippingCharge({
      sender: 'akeed_system',
      snapshot: pools(akeedUsed, akeedLimit),
    });

  it('Basic: every message of the pool can pay, the 300th included', () => {
    expect(send(270, 300)).toEqual({ allowed: true, pool: 'akeed', cost: 1 });
    expect(send(299, 300)).toEqual({ allowed: true, pool: 'akeed', cost: 1 });
  });

  it('Starter one-time pool: the 60th message is the last one', () => {
    expect(send(59, 60).allowed).toBe(true);
    expect(send(60, 60)).toEqual({ allowed: false, reason: 'no_allowance' });
  });

  it('an empty or overdrawn pool is no_allowance', () => {
    expect(send(300, 300)).toEqual({ allowed: false, reason: 'no_allowance' });
    expect(send(301, 300)).toEqual({ allowed: false, reason: 'no_allowance' });
    expect(send(0, 0)).toEqual({ allowed: false, reason: 'no_allowance' });
  });

  it('a fallback from the own number is charged as an Akeed send', () => {
    expect(
      decideShippingCharge({
        sender: 'merchant_own',
        chargeRule: 'fallback',
        snapshot: pools(300, 300, 0, 2000),
      }),
    ).toEqual({ allowed: false, reason: 'no_allowance' });
    expect(
      decideShippingCharge({
        sender: 'merchant_own',
        chargeRule: 'fallback',
        snapshot: pools(0, 300, 0, 2000),
      }),
    ).toEqual({ allowed: true, pool: 'akeed', cost: 1 });
  });
});

describe('decideShippingCharge: own number', () => {
  const own = (
    akeedUsed: number,
    akeedLimit: number,
    ownUsed: number,
    ownLimit: number,
  ) =>
    decideShippingCharge({
      sender: 'merchant_own',
      snapshot: pools(akeedUsed, akeedLimit, ownUsed, ownLimit),
    });

  it('uses the own pool to its last message (Basic 2,000)', () => {
    expect(own(0, 300, 1999, 2000)).toEqual({
      allowed: true,
      pool: 'own_number',
      cost: 1,
    });
  });

  it('spills over to the Akeed pool once the own pool is empty', () => {
    expect(own(0, 300, 2000, 2000)).toEqual({
      allowed: true,
      pool: 'akeed',
      cost: 1,
    });
    expect(own(299, 300, 2000, 2000)).toMatchObject({ pool: 'akeed' });
  });

  it('is refused only when both pools are empty', () => {
    expect(own(300, 300, 2000, 2000)).toEqual({
      allowed: false,
      reason: 'no_allowance',
    });
  });

  it('a store with no own pool spills straight to the Akeed pool', () => {
    expect(own(0, 300, 0, 0)).toMatchObject({ allowed: true, pool: 'akeed' });
  });
});

describe('decideShippingCharge agrees with confirmations', () => {
  it.each(['starter', 'basic', 'pro', 'business'] as const)(
    'Shopify %s: same pool or refusal as a confirmation at every boundary',
    (plan) => {
      const { includedLimit: akeed, ownNumberIncludedLimit: ownLimit } =
        resolvePeriodicPlanAllowances(plan, 'shopify');
      const points = (limit: number) => [0, limit - 1, limit, limit + 1];
      for (const sender of ['akeed_system', 'merchant_own'] as const)
        for (const akeedUsed of points(akeed))
          for (const ownUsed of points(ownLimit)) {
            const snapshot = pools(akeedUsed, akeed, ownUsed, ownLimit);
            const shipping = decideShippingCharge({ sender, snapshot });
            const confirmation = decidePeriodicCharge({ sender, snapshot });
            expect(shipping.allowed).toBe(confirmation.allowed);
            if (shipping.allowed && confirmation.allowed)
              expect(shipping.pool).toBe(confirmation.pool);
          }
    },
  );
});
