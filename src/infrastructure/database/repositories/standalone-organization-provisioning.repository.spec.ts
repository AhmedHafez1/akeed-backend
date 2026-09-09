import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../../shared/billing/billing-plan';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
import { integrations } from '../schema';
import {
  buildStandaloneOrganizationSlug,
  buildStandaloneSourceIdentity,
  provisionStandaloneSourceForOrganization,
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

/**
 * Credit billing moves the entitlement grant from signup to staff approval.
 * Provisioning still has to leave behind the pending account that approval
 * activates, in both modes — otherwise an organization can never be approved.
 */
describe('provisionStandaloneSourceForOrganization', () => {
  function integrationRow(orgId: string) {
    return Object.keys(getTableColumns(integrations)).map((column) => {
      if (column === 'id') return 'integration-1';
      if (column === 'orgId') return orgId;
      if (column === 'isActive') return true;
      return null;
    });
  }

  async function provision(grantEntitlement: boolean) {
    const statements: { query: string; params: unknown[] }[] = [];
    const execute = jest.fn((query: string, params: unknown[]) => {
      statements.push({ query, params });
      if (query.includes('from "organizations"')) {
        return Promise.resolve({ rows: [['org-1']] });
      }
      if (query.includes('insert into "integrations"')) {
        return Promise.resolve({ rows: [integrationRow('org-1')] });
      }
      return Promise.resolve({ rows: [] });
    });
    const session = drizzle(execute as never, { schema });
    const result = await provisionStandaloneSourceForOrganization(
      session as never,
      'org-1',
      { grantEntitlement },
    );
    return { result, statements };
  }

  it.each([true, false])(
    'seeds the pending credit account when grantEntitlement is %s',
    async (grantEntitlement) => {
      const { statements } = await provision(grantEntitlement);

      const account = statements.find((statement) =>
        statement.query.includes('insert into "credit_accounts"'),
      );
      expect(account?.query).toContain('on conflict do nothing');
      expect(account?.params).toEqual(['org-1']);
    },
  );

  it('grants the Starter entitlement while credit billing is disabled', async () => {
    const { statements, result } = await provision(true);

    const source = statements.find((statement) =>
      statement.query.includes('insert into "integrations"'),
    );
    expect(source?.params).toEqual(
      expect.arrayContaining([
        STANDALONE_DEFAULT_PLAN_ID,
        STANDALONE_BILLING_STATUS,
      ]),
    );
    expect(result.sourceCreated).toBe(true);
  });

  it('leaves the entitlement to staff approval while credit billing is enabled', async () => {
    const { statements } = await provision(false);

    const source = statements.find((statement) =>
      statement.query.includes('insert into "integrations"'),
    );
    expect(source?.params).not.toContain(STANDALONE_DEFAULT_PLAN_ID);
    expect(source?.params).not.toContain(STANDALONE_BILLING_STATUS);
  });
});
