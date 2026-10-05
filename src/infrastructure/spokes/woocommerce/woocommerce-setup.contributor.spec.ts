import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import type { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';
import { WooCommerceSetupContributor } from './woocommerce-setup.contributor';

const SOURCE = { id: 'integration-1', orgId: 'org-1' };
const NOW = '2026-10-05T10:00:00.000Z';
const STORE = 'https://shop.example.com/eg';

function connection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: SOURCE.id,
    orgId: SOURCE.orgId,
    storeUrl: STORE,
    storeVerifiedAt: NOW,
    consumerKeyEncrypted: 'v1:key',
    consumerSecretEncrypted: 'v1:secret',
    webhookSecretEncrypted: 'v1:webhook',
    webhookTokenHash: 'h'.repeat(64),
    orderCreatedWebhookId: 101,
    orderUpdatedWebhookId: 102,
    orderCreatedWebhookState: 'active',
    orderUpdatedWebhookState: 'active',
    webhooksCheckedAt: NOW,
    wooVersion: '9.8.1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    connectedAt: NOW,
    disconnectedAt: null,
    disconnectedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function contributorFor(row: WooCommerceConnection | undefined) {
  const findByIntegration = jest.fn().mockResolvedValue(row);
  const inspectWebhooks = jest.fn().mockResolvedValue(null);
  const contributor = new WooCommerceSetupContributor(
    { findByIntegration } as unknown as WooCommerceConnectionsRepository,
    { inspectWebhooks } as unknown as WooCommerceConnectionHealthService,
  );
  return { contributor, findByIntegration, inspectWebhooks };
}

describe('WooCommerceSetupContributor', () => {
  it('describes a ready connection by its store, with nothing blocking', async () => {
    const { contributor, findByIntegration, inspectWebhooks } =
      contributorFor(connection());

    await expect(contributor.describe(SOURCE)).resolves.toEqual({
      connectionState: 'connected',
      disconnectedAt: null,
      store: { reference: STORE, verified: true },
      orderDefaults: { currency: null, phoneCountry: null },
      blockedReasons: [],
      credentials: { status: 'ok' },
      delivery: {
        secretsMissing: false,
        rejectedCount: 0,
        lastRejectedAt: null,
      },
    });
    // Scoped to the source and its organization together.
    expect(findByIntegration).toHaveBeenCalledWith('integration-1', 'org-1');
    // Describing never asks the store.
    expect(inspectWebhooks).not.toHaveBeenCalled();
  });

  it('does not ask for a currency or a phone country: every order carries its own', async () => {
    const { contributor } = contributorFor(connection());

    const described = await contributor.describe(SOURCE);

    expect(described?.orderDefaults).toEqual({
      currency: null,
      phoneCountry: null,
    });
    expect(described?.blockedReasons).not.toContain('order_defaults_missing');
    expect(described?.blockedReasons).not.toContain('webhook_secrets_missing');
  });

  it.each(['credentials_rejected', 'permission_denied'])(
    'blocks setup when the store last answered %s',
    async (health) => {
      const { contributor } = contributorFor(connection({ health }));

      await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
        credentials: { status: 'rejected' },
        blockedReasons: ['credentials_rejected'],
      });
    },
  );

  it.each([
    [{ orderCreatedWebhookState: 'disabled' }],
    [{ orderUpdatedWebhookState: 'disabled' }],
    [
      {
        orderCreatedWebhookState: 'disabled',
        orderUpdatedWebhookState: 'disabled',
      },
    ],
  ])(
    'blocks setup while a webhook was last read as disabled (%#)',
    async (states) => {
      const { contributor } = contributorFor(connection(states));

      await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
        blockedReasons: ['webhook_disabled'],
      });
    },
  );

  it.each(['paused', 'missing', null])(
    'does not block setup for a webhook last read as %s',
    async (state) => {
      const { contributor } = contributorFor(
        connection({
          orderCreatedWebhookState: state,
          orderUpdatedWebhookState: state,
        }),
      );

      await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
        blockedReasons: [],
      });
    },
  );

  it('lists rejected keys before a disabled webhook', async () => {
    const { contributor } = contributorFor(
      connection({
        health: 'credentials_rejected',
        orderUpdatedWebhookState: 'disabled',
      }),
    );

    await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
      blockedReasons: ['credentials_rejected', 'webhook_disabled'],
    });
  });

  it('reports refused deliveries as they were counted', async () => {
    const { contributor } = contributorFor(
      connection({ rejectedDeliveries: 4, lastRejectedAt: NOW }),
    );

    await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
      delivery: {
        secretsMissing: false,
        rejectedCount: 4,
        lastRejectedAt: NOW,
      },
    });
  });

  it('describes a disconnected source with one thing to fix and no credential', async () => {
    const { contributor } = contributorFor(
      connection({
        storeVerifiedAt: null,
        consumerKeyEncrypted: null,
        consumerSecretEncrypted: null,
        webhookSecretEncrypted: null,
        webhookTokenHash: null,
        orderCreatedWebhookId: null,
        orderUpdatedWebhookId: null,
        orderCreatedWebhookState: null,
        orderUpdatedWebhookState: null,
        // What the store last said no longer matters once the keys are gone.
        health: 'credentials_rejected',
        disconnectedAt: NOW,
        disconnectedBy: 'user-1',
      }),
    );

    await expect(contributor.describe(SOURCE)).resolves.toMatchObject({
      connectionState: 'disconnected',
      disconnectedAt: NOW,
      store: { reference: STORE, verified: false },
      blockedReasons: ['source_disconnected'],
      credentials: { status: 'removed' },
    });
  });

  it('has nothing to say of a source with no connection row', async () => {
    const { contributor } = contributorFor(undefined);

    await expect(contributor.describe(SOURCE)).resolves.toBeNull();
  });

  it('stays readable after a disconnect', () => {
    expect(contributorFor(undefined).contributor).toMatchObject({
      platformType: 'woocommerce',
      readableWhenDisconnected: true,
    });
  });

  it('asks the store only for the source it was given', async () => {
    const { contributor, inspectWebhooks } = contributorFor(connection());

    await contributor.inspectWebhooks(SOURCE);

    expect(inspectWebhooks).toHaveBeenCalledWith('integration-1', 'org-1');
  });
});
