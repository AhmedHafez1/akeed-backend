import { resolvePeriodicPlanAllowances } from './billing-plan';
import {
  decideShippingCharge,
  shippingReserveFor,
} from './shipping-reserve.policy';

const pools = (
  akeedUsed: number,
  akeedLimit: number,
  ownUsed = 0,
  ownLimit = 0,
) => ({ akeedUsed, akeedLimit, ownUsed, ownLimit });

describe('shippingReserveFor', () => {
  it.each([
    [300, 30],
    [2000, 200],
    [60, 6],
    [200, 20],
    [1000, 100],
    [2500, 250],
    [5, 1],
    [1, 1],
    [11, 2],
    [0, 0],
    [-3, 0],
  ])('keeps a tenth of %i, rounded up: %i', (limit, reserve) => {
    expect(shippingReserveFor(limit)).toBe(reserve);
  });

  it('never rounds an exact tenth up by floating point (300 stays 30)', () => {
    for (let limit = 10; limit <= 20000; limit += 10)
      expect(shippingReserveFor(limit)).toBe(limit / 10);
  });

  it.each([
    ['starter', 6, 20],
    ['basic', 30, 200],
    ['pro', 100, 500],
    ['business', 250, 2000],
  ] as const)(
    'keeps a tenth of the Shopify %s pools (%i Akeed, %i own number)',
    (plan, akeed, own) => {
      const allowances = resolvePeriodicPlanAllowances(plan, 'shopify');
      expect(shippingReserveFor(allowances.includedLimit)).toBe(akeed);
      expect(shippingReserveFor(allowances.ownNumberIncludedLimit)).toBe(own);
    },
  );
});

describe('decideShippingCharge: Akeed number', () => {
  const send = (akeedUsed: number, akeedLimit: number) =>
    decideShippingCharge({
      sender: 'akeed_system',
      snapshot: pools(akeedUsed, akeedLimit),
    });

  it('Basic: the 270th message is the last one, leaving 30 for confirmations', () => {
    expect(send(269, 300)).toEqual({ allowed: true, pool: 'akeed', cost: 1 });
    expect(send(270, 300)).toEqual({
      allowed: false,
      reason: 'allowance_low',
    });
  });

  it('Starter one-time pool: 54 of 60 is the last allowed, 6 kept', () => {
    expect(send(53, 60).allowed).toBe(true);
    expect(send(54, 60)).toEqual({ allowed: false, reason: 'allowance_low' });
  });

  it('an empty pool is no_allowance, not allowance_low', () => {
    expect(send(300, 300)).toEqual({ allowed: false, reason: 'no_allowance' });
    expect(send(301, 300)).toEqual({ allowed: false, reason: 'no_allowance' });
    expect(send(0, 0)).toEqual({ allowed: false, reason: 'no_allowance' });
  });

  it('a small pool keeps at least one message', () => {
    expect(send(3, 5).allowed).toBe(true);
    expect(send(4, 5)).toEqual({ allowed: false, reason: 'allowance_low' });
  });

  it('a fallback from the own number is charged as an Akeed send', () => {
    expect(
      decideShippingCharge({
        sender: 'merchant_own',
        chargeRule: 'fallback',
        snapshot: pools(270, 300, 0, 2000),
      }),
    ).toEqual({ allowed: false, reason: 'allowance_low' });
    expect(
      decideShippingCharge({
        sender: 'akeed_system',
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

  it('uses the own pool while it keeps its reserve (Basic 2,000: 200 kept)', () => {
    expect(own(0, 300, 1799, 2000)).toEqual({
      allowed: true,
      pool: 'own_number',
      cost: 1,
    });
  });

  it('spills over to the Akeed pool once the own pool reaches its reserve', () => {
    expect(own(0, 300, 1800, 2000)).toEqual({
      allowed: true,
      pool: 'akeed',
      cost: 1,
    });
    expect(own(0, 300, 2000, 2000)).toEqual({
      allowed: true,
      pool: 'akeed',
      cost: 1,
    });
  });

  it('is refused only when both pools are inside their reserves', () => {
    expect(own(270, 300, 1800, 2000)).toEqual({
      allowed: false,
      reason: 'allowance_low',
    });
    expect(own(300, 300, 1900, 2000)).toEqual({
      allowed: false,
      reason: 'allowance_low',
    });
  });

  it('is no_allowance only when both pools are empty', () => {
    expect(own(300, 300, 2000, 2000)).toEqual({
      allowed: false,
      reason: 'no_allowance',
    });
  });

  it('Starter one-time pools: 180 of 200 own, then 54 of 60 Akeed', () => {
    expect(own(0, 60, 179, 200).allowed && own(0, 60, 179, 200)).toMatchObject({
      pool: 'own_number',
    });
    expect(own(0, 60, 180, 200)).toMatchObject({ pool: 'akeed' });
    expect(own(54, 60, 180, 200)).toEqual({
      allowed: false,
      reason: 'allowance_low',
    });
  });

  it('a store with no own pool spills straight to the Akeed pool', () => {
    expect(own(0, 300, 0, 0)).toMatchObject({ allowed: true, pool: 'akeed' });
  });
});
