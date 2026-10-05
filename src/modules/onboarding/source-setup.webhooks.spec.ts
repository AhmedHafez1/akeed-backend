import { SourceSetupService } from './source-setup.service';
import type { integrations } from '../../infrastructure/database/schema';
import type {
  SourceSetupContribution,
  SourceSetupContributor,
  SourceWebhookHealth,
} from '../../shared/commerce/source-setup';

type Source = typeof integrations.$inferSelect;

const CONNECTED: SourceSetupContribution = {
  connectionState: 'connected',
  disconnectedAt: null,
  store: { reference: 'https://shop.example.com', verified: true },
  orderDefaults: { currency: null, phoneCountry: null },
  blockedReasons: [],
  credentials: { status: 'ok' },
  delivery: { secretsMissing: false, rejectedCount: 0, lastRejectedAt: null },
};
const WEBHOOKS: SourceWebhookHealth = {
  checkedAt: '2026-10-05T09:00:00.000Z',
  items: [
    { kind: 'order_created', state: 'active' },
    { kind: 'order_updated', state: 'disabled' },
  ],
};
const SOURCE = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'made-up',
  isActive: true,
} as Source;

/**
 * Webhook state in the source health (US-07-05). The source here is a
 * made-up platform on purpose: the service only knows that a contributor may
 * be able to ask its store.
 */
describe('source health: webhook state read from the store', () => {
  const calls: string[] = [];
  const events = {
    summarizeForIntegration: jest.fn().mockResolvedValue({
      lastAcceptedAt: null,
      acceptedCount: 0,
      failedCount: 0,
      lastFailedAt: null,
      waitingCount: 0,
      oldestWaitingAt: null,
    }),
  };
  const syncs = {
    summarizeForIntegration: jest.fn().mockResolvedValue({
      failedCount: 0,
      lastFailedAt: null,
      requiresAssistance: false,
      pendingCount: 0,
    }),
  };

  function serviceWith(contributor: SourceSetupContributor) {
    return new SourceSetupService(
      [contributor],
      { findByOrg: jest.fn() } as never,
      events as never,
      syncs as never,
      { supports: () => false } as never,
    );
  }

  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
  });

  it('adds each webhook as the store answered, with no overall verdict', async () => {
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => Promise.resolve(CONNECTED),
      inspectWebhooks: () => Promise.resolve(WEBHOOKS),
    });

    const health = await service.health(SOURCE);

    expect(health.webhooks).toEqual(WEBHOOKS);
    expect(health).not.toHaveProperty('status');
    expect(health).not.toHaveProperty('ok');
  });

  it('asks the store before it describes the connection, so the credential answer is the latest', async () => {
    let credentials: SourceSetupContribution['credentials'] = { status: 'ok' };
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => {
        calls.push('describe');
        return Promise.resolve({ ...CONNECTED, credentials });
      },
      inspectWebhooks: () => {
        calls.push('inspect');
        // The store refused the key while it was being asked.
        credentials = { status: 'rejected' };
        return Promise.resolve({
          ...WEBHOOKS,
          items: WEBHOOKS.items.map((item) => ({ ...item, state: 'unknown' })),
        });
      },
    });

    const health = await service.health(SOURCE);

    expect(calls).toEqual(['inspect', 'describe']);
    expect(health.credentials).toEqual({ status: 'rejected' });
    expect(health.webhooks?.items.map((item) => item.state)).toEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('asks only for the source being read, by its own organization', async () => {
    const inspectWebhooks = jest.fn().mockResolvedValue(WEBHOOKS);
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => Promise.resolve(CONNECTED),
      inspectWebhooks,
    });

    await service.health(SOURCE);

    expect(inspectWebhooks).toHaveBeenCalledTimes(1);
    expect(inspectWebhooks).toHaveBeenCalledWith({
      id: 'int-1',
      orgId: 'org-1',
    });
  });

  it('leaves the key out when there is no live connection to ask', async () => {
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => Promise.resolve(CONNECTED),
      inspectWebhooks: () => Promise.resolve(null),
    });

    expect(await service.health(SOURCE)).not.toHaveProperty('webhooks');
  });

  it('leaves the key out for a source whose webhooks cannot be read', async () => {
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => Promise.resolve(CONNECTED),
    });

    expect(await service.health(SOURCE)).not.toHaveProperty('webhooks');
  });

  it('never asks a store when the state is only described', async () => {
    const inspectWebhooks = jest.fn().mockResolvedValue(WEBHOOKS);
    const service = serviceWith({
      platformType: 'made-up',
      readableWhenDisconnected: true,
      describe: () => Promise.resolve(CONNECTED),
      inspectWebhooks,
    });

    await service.describe(SOURCE);

    expect(inspectWebhooks).not.toHaveBeenCalled();
  });
});
