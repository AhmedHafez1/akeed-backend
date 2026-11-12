import {
  getBillingPeriodEnd,
  getBillingPeriodEndAt,
  getBillingPeriodStart,
} from './billing-period';
import {
  paidThroughTrialDays,
  resolvePaidThroughAtUninstall,
  type PaidThroughUninstallState,
} from './paid-through.policy';
import { resolveEntitlement } from './entitlement';
import {
  effectiveBillingStatus,
  isBillingStatusActive,
} from '../utils/billing.util';

const ACTIVATED_AT = '2026-10-31T08:30:00.000Z';

const paidPro: PaidThroughUninstallState = {
  billingPlanId: 'pro',
  billingStatus: 'active',
  billingActivatedAt: ACTIVATED_AT,
  billingCanceledAt: null,
  shopifySubscriptionId: 'gid://shopify/AppSubscription/1',
  paidThroughAt: null,
  uninstalledAt: null,
};

describe('getBillingPeriodEndAt', () => {
  it.each([
    '2026-10-31T08:30:00.000Z',
    '2026-11-11T16:54:00.000Z',
    '2026-11-30T08:29:59.000Z',
    '2026-11-30T08:30:00.000Z',
    '2027-02-14T00:00:00.000Z',
  ])('agrees with getBillingPeriodEnd on the date at %s', (at) => {
    const end = getBillingPeriodEndAt(ACTIVATED_AT, new Date(at));
    expect(end?.slice(0, 10)).toBe(
      getBillingPeriodEnd(getBillingPeriodStart(ACTIVATED_AT, new Date(at))),
    );
    expect(end?.slice(10)).toBe('T08:30:00.000Z');
  });

  it('returns null without an activation', () => {
    expect(getBillingPeriodEndAt(null)).toBeNull();
    expect(getBillingPeriodEndAt('not a date')).toBeNull();
  });
});

describe('resolvePaidThroughAtUninstall', () => {
  it('is the end of the period holding the uninstall (real case: Nov 30)', () => {
    expect(
      resolvePaidThroughAtUninstall(paidPro, '2026-11-11T16:54:00.000Z'),
    ).toBe('2026-11-30T08:30:00.000Z');
  });

  it('counts a cancel 5 minutes before as the uninstall, not 6', () => {
    const cancelled = { ...paidPro, billingStatus: 'cancelled' };
    expect(
      resolvePaidThroughAtUninstall(
        { ...cancelled, billingCanceledAt: '2026-11-11T16:49:00.000Z' },
        '2026-11-11T16:54:00.000Z',
      ),
    ).toBe('2026-11-30T08:30:00.000Z');
    expect(
      resolvePaidThroughAtUninstall(
        { ...cancelled, billingCanceledAt: '2026-11-11T16:48:00.000Z' },
        '2026-11-11T16:54:00.000Z',
      ),
    ).toBeNull();
  });

  it('caps a subscription still in its Shopify trial at its first charge', () => {
    expect(
      resolvePaidThroughAtUninstall(
        { ...paidPro, billingActivatedAt: '2026-11-30T17:01:00.000Z' },
        '2026-11-20T10:00:00.000Z',
      ),
    ).toBe('2026-11-30T17:01:00.000Z');
  });

  it('never moves the date across uninstall/reinstall loops', () => {
    // First uninstall records Nov 30.
    let row: PaidThroughUninstallState = { ...paidPro };
    const first = resolvePaidThroughAtUninstall(
      row,
      '2026-11-11T16:54:00.000Z',
    );
    expect(first).toBe('2026-11-30T08:30:00.000Z');

    const dates: Array<string | null> = [];
    let at = new Date('2026-11-11T17:01:00.000Z').getTime();
    row = { ...row, paidThroughAt: first, billingStatus: 'cancelled' };
    for (let loop = 0; loop < 5; loop += 1) {
      // Reinstall: resumed as paid_through, subscription id gone.
      row = {
        ...row,
        billingStatus: 'paid_through',
        shopifySubscriptionId: null,
        billingCanceledAt: null,
        uninstalledAt: null,
      };
      at += 3 * 86_400_000;
      const next = resolvePaidThroughAtUninstall(
        row,
        new Date(at).toISOString(),
      );
      // Uninstall again: nothing new is written.
      expect(next).toBeNull();
      row = {
        ...row,
        paidThroughAt: next ?? row.paidThroughAt,
        billingStatus: 'cancelled',
        uninstalledAt: new Date(at).toISOString(),
      };
      dates.push(row.paidThroughAt);
    }
    expect(new Set(dates)).toEqual(new Set(['2026-11-30T08:30:00.000Z']));
  });
});

describe('paidThroughTrialDays', () => {
  it('rounds the days left up', () => {
    expect(
      paidThroughTrialDays(
        '2026-11-30T08:30:00.000Z',
        new Date('2026-11-11T17:01:00.000Z'),
      ),
    ).toBe(19);
    expect(
      paidThroughTrialDays(
        '2026-11-30T08:30:00.000Z',
        new Date('2026-11-29T08:30:00.000Z'),
      ),
    ).toBe(1);
  });

  it('is zero once the date has passed or without one', () => {
    expect(
      paidThroughTrialDays(
        '2026-11-30T08:30:00.000Z',
        new Date('2026-11-30T08:30:00.000Z'),
      ),
    ).toBe(0);
    expect(paidThroughTrialDays(null)).toBe(0);
  });
});

describe('paid_through status', () => {
  const before = new Date('2026-11-20T00:00:00.000Z');
  const after = new Date('2026-11-30T08:30:00.001Z');

  it('is active only while the date is in the future, and fails closed without it', () => {
    expect(
      isBillingStatusActive('paid_through', '2026-11-30T08:30:00.000Z', before),
    ).toBe(true);
    expect(
      isBillingStatusActive('paid_through', '2026-11-30T08:30:00.000Z', after),
    ).toBe(false);
    expect(isBillingStatusActive('paid_through')).toBe(false);
    expect(isBillingStatusActive('active')).toBe(true);
    expect(isBillingStatusActive('not_required')).toBe(true);
  });

  it('reads as cancelled once lapsed', () => {
    expect(
      effectiveBillingStatus(
        'paid_through',
        '2026-11-30T08:30:00.000Z',
        before,
      ),
    ).toBe('paid_through');
    expect(
      effectiveBillingStatus('paid_through', '2026-11-30T08:30:00.000Z', after),
    ).toBe('cancelled');
    expect(effectiveBillingStatus('active', null, after)).toBe('active');
  });

  it('allows sends with the old period and counters before the date, not after', () => {
    const source = {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'shopify',
      isActive: true,
      billingStatus: 'paid_through',
      billingPlanId: 'pro',
      billingActivatedAt: ACTIVATED_AT,
      paidThroughAt: '2026-11-30T08:30:00.000Z',
    };
    const live = resolveEntitlement(source, source, before);
    expect(live).toMatchObject({
      allowed: true,
      planId: 'pro',
      includedLimit: 1000,
      // The period the 180 used messages were counted in.
      periodStart: '2026-10-31',
      periodEnd: '2026-11-30',
    });
    expect(resolveEntitlement(source, source, after)).toMatchObject({
      allowed: false,
      reason: 'billing_not_active',
    });
    expect(
      resolveEntitlement({ ...source, paidThroughAt: null }, source, before),
    ).toMatchObject({ allowed: false, reason: 'billing_not_active' });
  });
});
