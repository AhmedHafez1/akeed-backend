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
    ['starter', 30],
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

  it.each([
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
  ])(
    'leaves prepaid credit eligibility independent of legacy plan fields %j',
    (overrides) => {
      expect(
        resolveEntitlement({ ...source, ...overrides }, source, now),
      ).toMatchObject({ allowed: true, reason: null });
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
