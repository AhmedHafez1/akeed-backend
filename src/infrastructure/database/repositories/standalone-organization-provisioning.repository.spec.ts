import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../../shared/billing/billing-plan';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import {
  buildStandaloneOrganizationSlug,
  buildStandaloneSourceIdentity,
} from './standalone-organization-provisioning.repository';

describe('buildStandaloneOrganizationSlug', () => {
  it('uses the authenticated user ID instead of the company name', () => {
    expect(buildStandaloneOrganizationSlug('user-1')).toBe('standalone-user-1');
    expect(buildStandaloneOrganizationSlug('user-2')).toBe('standalone-user-2');
  });
});

describe('buildStandaloneSourceIdentity', () => {
  it('uses an internal organization-scoped identity', () => {
    expect(buildStandaloneSourceIdentity('org-1')).toBe('standalone:org-1');
  });
});

/**
 * Provisioning writes the billing columns; `resolveEntitlement` reads them. The
 * two have to agree, and there is no default-plan fallback for Standalone the
 * way there is for Shopify — leaving any of the three columns unset silently
 * produced `includedLimit: 0` and blocked every send with `billing_not_active`.
 */
describe('standalone provisioning entitlement grant', () => {
  const identity = { id: 'integration-1', orgId: 'org-1' };
  const provisionedSource = {
    ...identity,
    platformType: 'standalone',
    isActive: true,
    billingStatus: STANDALONE_BILLING_STATUS,
    billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
    billingActivatedAt: '2026-09-01T00:00:00.000Z',
  };

  it('entitles a freshly provisioned source to send', () => {
    const entitlement = resolveEntitlement(provisionedSource, identity);

    expect(entitlement.reason).toBeNull();
    expect(entitlement.allowed).toBe(true);
    expect(entitlement.includedLimit).toBeGreaterThan(0);
  });

  it.each(['billingStatus', 'billingPlanId', 'billingActivatedAt'] as const)(
    'blocks sending when provisioning omits %s',
    (column) => {
      const entitlement = resolveEntitlement(
        { ...provisionedSource, [column]: null },
        identity,
      );

      expect(entitlement.reason).toBe('billing_not_active');
      expect(entitlement.allowed).toBe(false);
    },
  );

  it('reports no quota at all when the plan itself is unset', () => {
    // `includedLimit` is derived from the plan alone, so this is the one
    // omission the dashboard surfaces directly — as `usage.limit: 0`.
    const entitlement = resolveEntitlement(
      { ...provisionedSource, billingPlanId: null },
      identity,
    );

    expect(entitlement.includedLimit).toBe(0);
  });
});
