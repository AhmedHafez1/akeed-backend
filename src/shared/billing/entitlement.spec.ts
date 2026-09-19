import {
  getBillingManagement,
  resolveEntitlement,
  type EntitlementSource,
} from './entitlement';

const source: EntitlementSource = {
  id: 'integration-1',
  orgId: 'org-1',
  platformType: 'standalone',
  isActive: true,
  billingStatus: 'not_required',
  billingPlanId: 'starter',
  billingActivatedAt: '2026-05-01T00:00:00Z',
};
const now = new Date('2026-05-15T00:00:00Z');

describe('provider-neutral entitlement policy', () => {
  it.each([
    ['basic', 300],
    ['pro', 1000],
    ['business', 2500],
  ])('uses the existing %s quota', (billingPlanId, includedLimit) => {
    expect(
      resolveEntitlement(
        { ...source, billingPlanId: String(billingPlanId) },
        source,
        now,
      ),
    ).toMatchObject({
      allowed: true,
      reason: null,
      includedLimit,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
  });

  it.each(['basic', 'pro', 'business'])(
    'rolls the paid %s quota into a new 30-day period',
    (billingPlanId) => {
      expect(
        resolveEntitlement(
          { ...source, billingPlanId },
          source,
          new Date('2026-06-05T00:00:00Z'),
        ),
      ).toMatchObject({ periodStart: '2026-05-31', periodEnd: '2026-06-30' });
    },
  );

  it.each([
    '2026-05-01T00:00:00Z',
    '2026-06-01T00:00:00Z',
    '2026-07-05T00:00:00Z',
    '2027-06-05T00:00:00Z',
  ])(
    'keeps the starter allowance one-time instead of renewing it (at %s)',
    (at) => {
      expect(resolveEntitlement(source, source, new Date(at))).toMatchObject({
        allowed: true,
        planId: 'starter',
        includedLimit: 30,
        periodStart: '2026-05-01',
        periodEnd: null,
      });
    },
  );

  it.each(['shopify', 'standalone'])(
    'gives a %s starter source without an activation date a fixed one-time period',
    (platformType) => {
      for (const at of ['2026-05-15T00:00:00Z', '2026-09-18T00:00:00Z']) {
        expect(
          resolveEntitlement(
            {
              ...source,
              platformType,
              billingStatus: 'active',
              billingPlanId: platformType === 'shopify' ? null : 'starter',
              billingActivatedAt: null,
            },
            source,
            new Date(at),
          ),
        ).toMatchObject({ periodStart: '2000-01-01', periodEnd: null });
      }
    },
  );

  const legacyPlanFieldGaps = [
    { billingStatus: null },
    { billingStatus: 'active' },
    { billingStatus: 'pending' },
    { billingStatus: 'cancelled' },
    { billingStatus: 'frozen' },
    { billingStatus: 'expired' },
    { billingPlanId: null },
    { billingPlanId: 'unknown' },
    { billingActivatedAt: null },
    { billingActivatedAt: 'invalid' },
  ];

  it.each(legacyPlanFieldGaps)(
    'leaves prepaid credit eligibility independent of legacy plan fields %j',
    (overrides) => {
      expect(
        resolveEntitlement(
          { ...source, ...overrides },
          source,
          now,
          'prepaid_credit',
        ),
      ).toMatchObject({ allowed: true, reason: null });
    },
  );

  // With credit billing off a Standalone source is billed on the periodic plan
  // it shipped with, so the plan columns gate it exactly as they did in E04.
  it.each(legacyPlanFieldGaps)(
    'does not infer periodic Standalone provisioning from %j',
    (overrides) => {
      expect(
        resolveEntitlement({ ...source, ...overrides }, source, now),
      ).toMatchObject({ allowed: false, reason: 'billing_not_active' });
    },
  );

  it('rejects missing, mismatched, and inactive sources', () => {
    expect(resolveEntitlement(undefined, source, now).reason).toBe(
      'missing_linked_integration',
    );
    expect(
      resolveEntitlement(source, { ...source, orgId: 'other' }, now).reason,
    ).toBe('source_identity_mismatch');
    expect(
      resolveEntitlement({ ...source, isActive: false }, source, now).reason,
    ).toBe('integration_inactive');
  });

  it.each(['active', 'not_required', ' ACTIVE '])(
    'preserves Shopify %s and legacy starter fallback',
    (billingStatus) => {
      expect(
        resolveEntitlement(
          {
            ...source,
            platformType: 'shopify',
            billingStatus,
            billingPlanId: null,
            billingActivatedAt: null,
          },
          source,
          now,
        ),
      ).toMatchObject({ allowed: true, planId: 'starter', includedLimit: 30 });
    },
  );

  it('keeps management capability distinct from entitlement access', () => {
    expect(getBillingManagement(source)).toEqual({
      mode: 'manual',
      canManageBilling: false,
    });
    expect(
      getBillingManagement({ ...source, platformType: 'shopify' }),
    ).toEqual({ mode: 'shopify', canManageBilling: true });
    expect(
      getBillingManagement({
        ...source,
        platformType: 'shopify',
        isActive: false,
      }).canManageBilling,
    ).toBe(false);
  });
});
