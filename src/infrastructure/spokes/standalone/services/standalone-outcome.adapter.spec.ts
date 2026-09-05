import { COMMERCE_OUTCOME_ACTIONS } from '../../../../shared/commerce/commerce-outcome';
import { StandaloneOutcomeAdapter } from './standalone-outcome.adapter';

describe('StandaloneOutcomeAdapter', () => {
  it.each(COMMERCE_OUTCOME_ACTIONS)(
    'records %s locally without requiring an active commerce connection',
    async (action) => {
      const adapter = new StandaloneOutcomeAdapter();
      expect(adapter.requiresActiveConnection).toBe(false);
      expect(adapter.capabilities.has(action)).toBe(true);
      await expect(
        adapter.execute({
          orgId: 'org-1',
          integrationId: 'source-1',
          externalOrderId: 'manual-1',
          action,
          correlationId: 'verification-1',
          connection: {
            id: 'source-1',
            orgId: 'org-1',
            platformType: 'standalone',
            platformStoreUrl: 'standalone:org-1',
            accessToken: null,
            isActive: false,
            metadata: {},
          },
        }),
      ).resolves.toEqual({ status: 'applied' });
    },
  );
});
