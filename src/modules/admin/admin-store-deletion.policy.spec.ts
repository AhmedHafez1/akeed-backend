import {
  storeDeletionBlock,
  type AdminStoreDeletionFacts,
} from './admin-store-deletion.policy';

const now = new Date('2026-11-19T12:00:00.000Z');

function facts(
  overrides: Partial<AdminStoreDeletionFacts> = {},
): AdminStoreDeletionFacts {
  return {
    healthStatus: 'critical',
    lifecycleStatus: 'installed',
    installedAt: '2026-11-01T00:00:00.000Z',
    usageUsed: 0,
    hasRealActivity: false,
    hasCreditHistory: false,
    orgStoreCount: 1,
    ...overrides,
  };
}

describe('storeDeletionBlock', () => {
  it('allows a critical store that was never used', () => {
    expect(storeDeletionBlock(facts(), now)).toBeNull();
  });

  it('allows an uninstalled store whatever its health', () => {
    expect(
      storeDeletionBlock(
        facts({ healthStatus: 'healthy', lifecycleStatus: 'uninstalled' }),
        now,
      ),
    ).toBeNull();
  });

  it.each([
    [{ healthStatus: 'attention_required' }, 'not_critical_or_uninstalled'],
    [{ installedAt: '2026-11-13T00:00:00.000Z' }, 'installed_recently'],
    [{ installedAt: 'not a date' }, 'installed_recently'],
    [{ usageUsed: 1 }, 'has_usage'],
    [{ hasRealActivity: true }, 'has_usage'],
    [{ hasCreditHistory: true }, 'has_credit_history'],
    [{ orgStoreCount: 2 }, 'shares_organization'],
  ] as const)('blocks %j as %s', (overrides, block) => {
    expect(storeDeletionBlock(facts(overrides), now)).toBe(block);
  });
});
