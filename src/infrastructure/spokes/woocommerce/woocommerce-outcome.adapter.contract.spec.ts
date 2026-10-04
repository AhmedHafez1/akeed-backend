import type { ConfigService } from '@nestjs/config';
import { defineCommerceOutcomeAdapterContract } from '../../../../test/contracts/commerce-outcome-adapter.contract';
import {
  FAKE_PUBLIC_ADDRESS,
  FakeWooCommerce,
} from '../../../../test/contracts/woocommerce-provider-fake';
import { placedCodFixture } from '../../../../test/fixtures/woocommerce/load';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapterRequest,
} from '../../../shared/commerce/commerce-outcome';
import { WOOCOMMERCE_CONFIG } from '../../../shared/config/woocommerce.config';
import { createRestrictedHttp } from '../../../shared/http/restricted-http';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import { WooCommerceApiClient } from './woocommerce-api.client';
import { WooCommerceOutcomeAdapter } from './woocommerce-outcome.adapter';
import {
  WOOCOMMERCE_CONFIRMATION_NOTE,
  WOOCOMMERCE_OUTCOME_ACTIONS,
  wooCommerceEffectFor,
} from './woocommerce-outcome.mapping';

const ENCRYPTION_KEY = 'k'.repeat(32);
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = 'adapter-contract-verification';

/**
 * The adapter as the application builds it, on the real restricted outbound
 * client, over the provider fake as its DNS and transport, with the
 * documented placed-order fixture as the store's data.
 */
function setup(options: { enabled?: boolean } = {}) {
  const fake = new FakeWooCommerce();
  const store = fake.addStore();
  const keys = store.issueKeys();
  const order = placedCodFixture().payload;
  store.placeOrder(order);

  const connection = {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeUrl: store.url,
    storeVerifiedAt: '2026-10-04T09:00:00.000Z',
    consumerKeyEncrypted: encryptToken(keys.consumerKey, ENCRYPTION_KEY),
    consumerSecretEncrypted: encryptToken(keys.consumerSecret, ENCRYPTION_KEY),
    health: 'ok',
  } as WooCommerceConnection;
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(connection),
    setHealth: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: (key: string) =>
      key === WOOCOMMERCE_CONFIG
        ? { outcomeSyncEnabled: options.enabled ?? true }
        : undefined,
    getOrThrow: () => ENCRYPTION_KEY,
  } as unknown as ConfigService;
  const adapter = new WooCommerceOutcomeAdapter(
    connections as unknown as WooCommerceConnectionsRepository,
    new WooCommerceApiClient(
      createRestrictedHttp({ lookup: fake.lookup, transport: fake.transport }),
    ),
    config,
  );
  const request = (
    action: CommerceOutcomeAction,
  ): CommerceOutcomeAdapterRequest => ({
    orgId: ORG_ID,
    integrationId: INTEGRATION_ID,
    externalOrderId: String(order.id),
    correlationId: CORRELATION_ID,
    action,
    connection: {} as CommerceOutcomeAdapterRequest['connection'],
  });
  const remote = () => store.orders.get(order.id)!;
  return {
    fake,
    store,
    keys,
    order,
    remote,
    connection,
    connections,
    adapter,
    request,
  };
}

defineCommerceOutcomeAdapterContract({
  name: 'WooCommerce',
  platformType: 'woocommerce',
  capabilities: WOOCOMMERCE_OUTCOME_ACTIONS,
  expectedStatus: {
    customer_confirmation: 'applied',
    customer_cancellation: 'applied',
    merchant_no_reply_cancellation: 'applied',
  },
  createFixture: (action) => {
    const { adapter, request } = setup();
    return { adapter, request: request(action) };
  },
});

describe('WooCommerce adapter against the provider fake', () => {
  describe('mapping fixtures', () => {
    it('a confirmation leaves the status, adds the marker once and one internal note', async () => {
      const { adapter, request, fake, store, remote, order } = setup();

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toEqual({ status: 'applied', providerStatus: 'processing' });

      expect(order.status).toBe('processing');
      expect(remote()).toMatchObject({
        status: 'processing',
        meta_data: [
          {
            key: 'akeed_outcome',
            value: `customer_confirmation:${CORRELATION_ID}`,
          },
        ],
        notes: [{ note: WOOCOMMERCE_CONFIRMATION_NOTE, customer_note: false }],
      });
      expect(fake.requestsTo(store)).toEqual([
        expect.objectContaining({ route: 'order_read', answered: 200 }),
        expect.objectContaining({
          route: 'order_write',
          method: 'PUT',
          authenticated: true,
          answered: 200,
          body: {
            meta_data: [
              {
                key: 'akeed_outcome',
                value: `customer_confirmation:${CORRELATION_ID}`,
              },
            ],
          },
        }),
        expect.objectContaining({ route: 'note_create', answered: 201 }),
      ]);
    });

    it.each<CommerceOutcomeAction>([
      'customer_cancellation',
      'merchant_no_reply_cancellation',
    ])(
      '%s writes cancelled and the marker in one update, and no note',
      async (action) => {
        const { adapter, request, fake, store, remote } = setup();

        await expect(adapter.execute(request(action))).resolves.toEqual({
          status: 'applied',
          providerStatus: 'cancelled',
        });

        expect(remote()).toMatchObject({
          status: 'cancelled',
          meta_data: [
            { key: 'akeed_outcome', value: `${action}:${CORRELATION_ID}` },
          ],
          notes: [],
        });
        expect(
          fake.requestsTo(store).map((sent) => [sent.route, sent.body]),
        ).toEqual([
          ['order_read', undefined],
          [
            'order_write',
            {
              status: 'cancelled',
              meta_data: [
                { key: 'akeed_outcome', value: `${action}:${CORRELATION_ID}` },
              ],
            },
          ],
        ]);
      },
    );

    it('every request goes to the address that was checked, with the integration’s own key', async () => {
      const { adapter, request, fake, store } = setup();

      await adapter.execute(request('customer_confirmation'));

      for (const sent of fake.requestsTo(store))
        expect(sent).toMatchObject({
          host: store.host,
          address: FAKE_PUBLIC_ADDRESS,
          authenticated: true,
        });
    });

    it('a repeated outcome writes nothing again: one marker, one note', async () => {
      const { adapter, request, fake, store, remote } = setup();

      await adapter.execute(request('customer_confirmation'));
      await adapter.execute(request('customer_confirmation'));

      expect(remote().meta_data).toHaveLength(1);
      expect(remote().notes).toHaveLength(1);
      expect(
        fake.requestsTo(store).filter((sent) => sent.route !== 'order_read'),
      ).toHaveLength(2);
    });

    it.each(
      COMMERCE_OUTCOME_ACTIONS.filter(
        (action) => !WOOCOMMERCE_OUTCOME_ACTIONS.includes(action),
      ),
    )(
      '%s is unsupported and reaches the store with nothing',
      async (action) => {
        const { adapter, request, fake, remote } = setup();

        expect(wooCommerceEffectFor(action)).toBeUndefined();
        await expect(adapter.execute(request(action))).resolves.toEqual({
          status: 'unsupported',
          reason: 'capability_not_supported',
        });

        expect(fake.requests).toHaveLength(0);
        expect(remote()).toMatchObject({ status: 'processing', notes: [] });
      },
    );

    it('offers nothing and asks nothing while remote writes are switched off', async () => {
      const { adapter, request, fake } = setup({ enabled: false });

      expect(adapter.capabilities.size).toBe(0);
      for (const action of COMMERCE_OUTCOME_ACTIONS)
        await expect(adapter.execute(request(action))).resolves.toMatchObject({
          status: 'unsupported',
        });

      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('authentication fixtures', () => {
    it('a revoked key stops at once, flags the connection and is not retried', async () => {
      const { adapter, request, fake, store, keys, connections, remote } =
        setup();
      store.revokeKey(keys.consumerKey);

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'source_credentials_rejected',
        requiresAssistance: true,
      });

      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'credentials_rejected',
      );
      expect(fake.requestsTo(store)).toHaveLength(1);
      expect(remote().meta_data).toHaveLength(0);
    });

    it('a key whose user may not manage the store is a permission failure', async () => {
      const { adapter, request, store, connection, connections, remote } =
        setup();
      const weak = store.issueKeys({ canManage: false });
      connection.consumerKeyEncrypted = encryptToken(
        weak.consumerKey,
        ENCRYPTION_KEY,
      );
      connection.consumerSecretEncrypted = encryptToken(
        weak.consumerSecret,
        ENCRYPTION_KEY,
      );

      await expect(
        adapter.execute(request('customer_cancellation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'source_permission_denied',
        requiresAssistance: true,
      });

      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'permission_denied',
      );
      expect(remote().status).toBe('processing');
    });

    it('fails closed when the answer names another store’s order', async () => {
      const { adapter, request, fake, store, remote } = setup();
      store.orderLinkBase = 'https://another-shop.example.com';

      await expect(
        adapter.execute(request('customer_cancellation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'store_unverified',
      });

      expect(fake.requestsTo(store).map((sent) => sent.route)).toEqual([
        'order_read',
      ]);
      expect(remote().status).toBe('processing');
    });

    it('never sends a key to a store whose address is not public', async () => {
      const { adapter, request, fake, store } = setup();
      store.addresses = ['10.0.0.7'];

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'store_unreachable',
        requiresAssistance: true,
      });

      expect(fake.requests).toHaveLength(0);
    });

    it('does not follow a redirect with the key', async () => {
      const { adapter, request, fake, store } = setup();
      store.redirectTo = 'https://elsewhere.example.com/';

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_unreachable',
      });

      expect(fake.requests).toEqual([
        expect.objectContaining({ host: store.host, answered: 301 }),
      ]);
    });
  });
});
