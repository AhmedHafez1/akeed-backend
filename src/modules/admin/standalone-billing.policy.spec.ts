import {
  countApprovalRows,
  evaluateStandaloneApproval,
} from './standalone-billing.policy';
import type {
  ApprovalAccount,
  ApprovalSnapshot,
  ApprovalSource,
} from './standalone-billing.types';

const now = new Date('2026-09-03T12:00:00Z');
const FREE_GRANT = 30;

function account(overrides: Partial<ApprovalAccount> = {}): ApprovalAccount {
  return {
    status: 'pending_approval',
    postedBalance: 0,
    heldCredits: 0,
    version: 0,
    approvedAt: null,
    ...overrides,
  };
}
function snapshot(): ApprovalSnapshot {
  return {
    orgId: 'org-1',
    organization: { id: 'org-1', name: 'Synthetic merchant' },
    memberships: [{ id: 'membership-1', userId: 'owner-1', role: 'owner' }],
    ownedOrganizations: [{ userId: 'owner-1', orgId: 'org-1' }],
    sources: [],
    identityConflict: false,
    claims: [],
    usage: [],
    orderCount: 0,
    account: account(),
    freeGrantPresent: false,
  };
}
function source(overrides: Partial<ApprovalSource> = {}): ApprovalSource {
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

describe('Standalone credit approval eligibility', () => {
  it('proposes the launch grant without mutating the source-free account', () => {
    const pending = snapshot();
    expect(
      evaluateStandaloneApproval(pending, FREE_GRANT, now).row,
    ).toMatchObject({
      status: 'eligible',
      reason: 'create_source',
      proposed: {
        createSource: true,
        freeGrantQuantity: FREE_GRANT,
        accountStatus: 'active',
      },
    });
    expect(pending.sources).toEqual([]);
    expect(pending.account).toEqual(account());
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
    ['account_missing', { account: null }],
    ['account_suspended', { account: account({ status: 'suspended' }) }],
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
  ] satisfies [string, Partial<ApprovalSnapshot>][])(
    'reports %s without proposing a grant',
    (reason, override) => {
      const result = evaluateStandaloneApproval(
        { ...snapshot(), ...override },
        FREE_GRANT,
        now,
      );
      expect(result.row.reason).toBe(reason);
      expect(result.row.proposed).toBeNull();
    },
  );

  it.each([
    ['an active account', { account: account({ status: 'active' }) }],
    ['a posted launch grant', { freeGrantPresent: true }],
  ] satisfies [string, Partial<ApprovalSnapshot>][])(
    'reports already_approved for %s',
    (_label, override) => {
      expect(
        evaluateStandaloneApproval(
          { ...snapshot(), ...override },
          FREE_GRANT,
          now,
        ).row,
      ).toMatchObject({ status: 'already_approved', proposed: null });
    },
  );

  /**
   * The migration cohort already carries the Starter columns provisioning used
   * to write. Those are no longer the approval authority, so such an
   * organization stays eligible for its one launch grant.
   */
  it('still approves a migration-cohort source that already holds Starter', () => {
    const migrated = {
      ...snapshot(),
      sources: [
        source({
          billingPlanId: 'starter',
          billingStatus: 'not_required',
          billingActivatedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      orderCount: 4,
    };
    expect(
      evaluateStandaloneApproval(migrated, FREE_GRANT, now).row,
    ).toMatchObject({
      status: 'eligible',
      reason: 'activate_source',
      proposed: { billingActivatedAt: '2026-01-01T00:00:00Z' },
    });
  });

  it.each(['basic', 'pro', 'business'])(
    'reports a %s plan as a billing conflict instead of approving it',
    (plan) => {
      const conflicted = {
        ...snapshot(),
        sources: [
          source({
            billingPlanId: plan,
            billingStatus: 'not_required',
            billingActivatedAt: '2026-01-01T00:00:00Z',
          }),
        ],
      };
      expect(
        evaluateStandaloneApproval(conflicted, FREE_GRANT, now).row,
      ).toMatchObject({ status: 'ambiguous', reason: 'billing_conflict' });
    },
  );

  it('fingerprints credit-side drift so a stale preview cannot be applied', () => {
    const before = evaluateStandaloneApproval(snapshot(), FREE_GRANT, now);
    const granted = evaluateStandaloneApproval(
      { ...snapshot(), freeGrantPresent: true },
      FREE_GRANT,
      now,
    );
    const sourced = evaluateStandaloneApproval(
      { ...snapshot(), sources: [source()] },
      FREE_GRANT,
      now,
    );

    expect(before.fingerprint).not.toBe(granted.fingerprint);
    expect(before.fingerprint).not.toBe(sourced.fingerprint);
    expect(countApprovalRows([before.row, granted.row, sourced.row])).toEqual({
      eligible: 2,
      alreadyApproved: 1,
      skipped: 0,
      ambiguous: 0,
      existingSource: 1,
    });
  });
});
