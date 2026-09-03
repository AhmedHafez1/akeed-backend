import {
  countPilotRows,
  evaluateStandalonePilot,
} from './standalone-pilot.policy';
import type { PilotSnapshot, PilotSource } from './standalone-pilot.types';

const now = new Date('2026-09-03T12:00:00Z');
function snapshot(): PilotSnapshot {
  return {
    orgId: 'org-1',
    organization: { id: 'org-1', name: 'Synthetic pilot' },
    memberships: [{ id: 'membership-1', userId: 'owner-1', role: 'owner' }],
    ownedOrganizations: [{ userId: 'owner-1', orgId: 'org-1' }],
    sources: [],
    identityConflict: false,
    claims: [],
    usage: [],
    orderCount: 0,
  };
}
function source(overrides: Partial<PilotSource> = {}): PilotSource {
  return {
    id: 'source-1',
    orgId: 'org-1',
    platformType: 'standalone',
    identity: 'standalone:org-1',
    isActive: true,
    billingPlanId: null,
    billingStatus: null,
    billingActivatedAt: null,
    billingStatusUpdatedAt: null,
    pendingBillingPlanId: null,
    billingInitiatedAt: null,
    billingCanceledAt: null,
    hasSubscription: false,
    hasCredentials: false,
    updatedAt: null,
    ...overrides,
  };
}

describe('Standalone pilot eligibility', () => {
  it('proposes Starter without mutating the source-free account', () => {
    const account = snapshot();
    expect(evaluateStandalonePilot(account, now).row).toMatchObject({
      status: 'eligible',
      reason: 'create_source',
      proposed: { planId: 'starter', includedLimit: 30, createSource: true },
    });
    expect(account.sources).toEqual([]);
  });
  it.each([
    [
      'native_source',
      { sources: [source({ platformType: 'shopify', isActive: false })] },
    ],
    [
      'native_billing_history',
      { claims: [{ id: 'claim', platformType: 'woocommerce' }] },
    ],
    ['owner_missing', { memberships: [] }],
    [
      'multiple_owners',
      {
        memberships: [
          ...snapshot().memberships,
          { id: 'membership-2', userId: 'owner-2', role: 'owner' },
        ],
      },
    ],
    [
      'multiple_owned_organizations',
      {
        ownedOrganizations: [
          ...snapshot().ownedOrganizations,
          { userId: 'owner-1', orgId: 'org-2' },
        ],
      },
    ],
    [
      'source_conflict',
      { sources: [source({ identity: 'standalone:another-org' })] },
    ],
    ['source_conflict', { identityConflict: true }],
    ['source_conflict', { sources: [source(), source({ id: 'source-2' })] }],
    ['source_inactive', { sources: [source({ isActive: false })] }],
    ['billing_conflict', { sources: [source({ billingStatus: 'canceled' })] }],
    ['billing_conflict', { sources: [source({ hasSubscription: true })] }],
    ['billing_conflict', { sources: [source({ hasCredentials: true })] }],
    [
      'billing_conflict',
      { sources: [source({ pendingBillingPlanId: 'pro' })] },
    ],
    [
      'billing_conflict',
      { sources: [source({ billingActivatedAt: '2030-01-01' })] },
    ],
    [
      'billing_conflict',
      { sources: [source({ billingActivatedAt: 'invalid' })] },
    ],
    ['accounting_anchor_missing', { sources: [source()], orderCount: 1 }],
    [
      'accounting_anchor_missing',
      {
        sources: [source()],
        usage: [
          {
            id: 'usage',
            integrationId: 'source-1',
            periodStart: '2026-09-01',
            includedLimit: 30,
            consumedCount: 7,
            blockedCount: 2,
          },
        ],
      },
    ],
  ] satisfies [string, Partial<PilotSnapshot>][])(
    'reports %s without proposing writes',
    (reason, override) => {
      const result = evaluateStandalonePilot(
        { ...snapshot(), ...override },
        now,
      );
      expect(result.row.reason).toBe(reason);
      expect(result.row.proposed).toBeNull();
    },
  );
  it.each(['starter', 'basic', 'pro', 'business'])(
    'preserves an existing %s manual entitlement',
    (plan) => {
      const account = {
        ...snapshot(),
        sources: [
          source({
            billingPlanId: plan,
            billingStatus: 'not_required',
            billingActivatedAt: '2026-01-01T00:00:00Z',
          }),
        ],
        orderCount: 4,
      };
      expect(evaluateStandalonePilot(account, now).row).toMatchObject({
        status: 'already_entitled',
        proposed: null,
      });
    },
  );
  it('preserves the accounting anchor when filling a missing entitlement', () => {
    const account = {
      ...snapshot(),
      sources: [source({ billingActivatedAt: '2026-01-01T00:00:00Z' })],
      orderCount: 4,
    };
    expect(
      evaluateStandalonePilot(account, now).row.proposed?.billingActivatedAt,
    ).toBe('2026-01-01T00:00:00Z');
  });
  it('fingerprints changes and reports overlapping existing-source counts', () => {
    const before = evaluateStandalonePilot(snapshot(), now);
    const after = evaluateStandalonePilot(
      { ...snapshot(), sources: [source()] },
      now,
    );
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(countPilotRows([before.row, after.row])).toEqual({
      eligible: 2,
      alreadyEntitled: 0,
      skipped: 0,
      ambiguous: 0,
      existingSource: 1,
    });
  });
});
