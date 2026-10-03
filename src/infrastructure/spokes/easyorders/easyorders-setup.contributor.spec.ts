import type {
  EasyOrdersConnection,
  EasyOrdersConnectionsRepository,
} from '../../database/repositories/easyorders-connections.repository';
import { EasyOrdersSetupContributor } from './easyorders-setup.contributor';

const SOURCE = { id: 'integration-1', orgId: 'org-1' };
const NOW = '2026-10-03T10:00:00.000Z';

function connection(
  overrides: Partial<EasyOrdersConnection> = {},
): EasyOrdersConnection {
  return {
    integrationId: SOURCE.id,
    orgId: SOURCE.orgId,
    storeId: 'store-1',
    storeVerifiedAt: NOW,
    apiKeyEncrypted: 'v1:key',
    webhookTokenHash: 'h'.repeat(64),
    webhookTokenHint: 'abc123',
    ordersWebhookSecretEncrypted: 'v1:orders',
    statusWebhookSecretEncrypted: 'v1:status',
    disconnectedAt: null,
    disconnectedBy: null,
    health: 'ok',
    currency: 'EGP',
    phoneCountry: 'EG',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function describeWith(row: EasyOrdersConnection | undefined) {
  const findByIntegration = jest.fn().mockResolvedValue(row);
  const contributor = new EasyOrdersSetupContributor({
    findByIntegration,
  } as unknown as EasyOrdersConnectionsRepository);
  return { result: contributor.describe(SOURCE), findByIntegration };
}

describe('EasyOrdersSetupContributor', () => {
  it('describes a ready connection with nothing blocking', async () => {
    const { result, findByIntegration } = describeWith(connection());

    await expect(result).resolves.toEqual({
      connectionState: 'connected',
      disconnectedAt: null,
      store: { reference: 'store-1', verified: true },
      orderDefaults: { currency: 'EGP', phoneCountry: 'EG' },
      blockedReasons: [],
      credentials: { status: 'ok' },
      delivery: {
        secretsMissing: false,
        rejectedCount: 0,
        lastRejectedAt: null,
      },
    });
    // The order's own integration, scoped by its organization.
    expect(findByIntegration).toHaveBeenCalledWith('integration-1', 'org-1');
  });

  it('answers nothing for a source without a connection row', async () => {
    await expect(describeWith(undefined).result).resolves.toBeNull();
  });

  it('blocks setup on a key EasyOrders rejected', async () => {
    await expect(
      describeWith(connection({ health: 'credentials_rejected' })).result,
    ).resolves.toMatchObject({
      credentials: { status: 'rejected' },
      blockedReasons: ['credentials_rejected'],
    });
  });

  it('reports an inactive store as health, not as a setup blocker', async () => {
    await expect(
      describeWith(connection({ health: 'store_inactive' })).result,
    ).resolves.toMatchObject({
      credentials: { status: 'store_inactive' },
      blockedReasons: [],
    });
  });

  it.each([
    [{ ordersWebhookSecretEncrypted: null }],
    [{ statusWebhookSecretEncrypted: null }],
  ])('blocks setup while a webhook secret is missing: %j', async (missing) => {
    await expect(
      describeWith(
        connection({
          ...missing,
          rejectedDeliveries: 2,
          lastRejectedAt: NOW,
        }),
      ).result,
    ).resolves.toMatchObject({
      blockedReasons: ['webhook_secrets_missing'],
      delivery: { secretsMissing: true, rejectedCount: 2, lastRejectedAt: NOW },
    });
  });

  it.each([[{ currency: null }], [{ phoneCountry: null }]])(
    'blocks setup while an order default is missing: %j',
    async (missing) => {
      await expect(
        describeWith(connection(missing)).result,
      ).resolves.toMatchObject({ blockedReasons: ['order_defaults_missing'] });
    },
  );

  it('describes a disconnected connection by its one fix, with no credentials', async () => {
    await expect(
      describeWith(
        connection({
          apiKeyEncrypted: null,
          webhookTokenHash: null,
          webhookTokenHint: null,
          ordersWebhookSecretEncrypted: null,
          statusWebhookSecretEncrypted: null,
          storeVerifiedAt: null,
          disconnectedAt: NOW,
          disconnectedBy: 'user-1',
          health: 'credentials_rejected',
        }),
      ).result,
    ).resolves.toMatchObject({
      connectionState: 'disconnected',
      disconnectedAt: NOW,
      store: { reference: 'store-1', verified: false },
      blockedReasons: ['source_disconnected'],
      credentials: { status: 'removed' },
      delivery: { secretsMissing: false },
    });
  });
});
