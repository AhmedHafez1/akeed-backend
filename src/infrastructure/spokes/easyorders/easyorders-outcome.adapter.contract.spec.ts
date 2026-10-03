import type { ConfigService } from '@nestjs/config';
import { defineCommerceOutcomeAdapterContract } from '../../../../test/contracts/commerce-outcome-adapter.contract';
import { easyOrdersProviderFake } from '../../../../test/contracts/easyorders-provider-fake';
import {
  orderCreatedFixture,
  orderStatusFixture,
} from '../../../../test/fixtures/easyorders/load';
import type {
  EasyOrdersConnection,
  EasyOrdersConnectionsRepository,
} from '../../database/repositories/easyorders-connections.repository';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapterRequest,
} from '../../../shared/commerce/commerce-outcome';
import { EASYORDERS_CONFIG } from '../../../shared/config/easyorders.config';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { PhoneService } from '../../../shared/services/phone.service';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import { EasyOrdersApiClient } from './easyorders-api.client';
import { EasyOrdersOrderEligibilityStrategy } from './easyorders-order-eligibility.strategy';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';
import { EasyOrdersOutcomeAdapter } from './easyorders-outcome.adapter';
import {
  EASYORDERS_OUTCOME_ACTIONS,
  EASYORDERS_WRITABLE_FROM_STATUS,
  easyOrdersStatusFor,
} from './easyorders-outcome.mapping';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';

const ENCRYPTION_KEY = 'k'.repeat(32);
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_STORE_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * The adapter and the normalizer as the application builds them, over the
 * provider fake, with the documented fixtures as the store's data (US-06-06).
 */
function setup(options: { enabled?: boolean } = {}) {
  const order = orderCreatedFixture();
  const provider = easyOrdersProviderFake();
  const apiKey = provider.issueKey(order.store_id);
  provider.placeOrder(order.store_id, order.id, order, order.status as string);

  const connection = {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeId: order.store_id,
    storeVerifiedAt: '2026-10-03T09:00:00.000Z',
    apiKeyEncrypted: encryptToken(apiKey, ENCRYPTION_KEY),
    disconnectedAt: null,
    health: 'ok',
    currency: 'EGP',
    phoneCountry: 'EG',
  } as EasyOrdersConnection;
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(connection),
    setHealth: jest.fn().mockResolvedValue(undefined),
    markStoreVerified: jest.fn().mockResolvedValue('verified'),
  };
  const config = {
    get: (key: string) =>
      key === EASYORDERS_CONFIG
        ? { outcomeSyncEnabled: options.enabled ?? true }
        : undefined,
    getOrThrow: () => ENCRYPTION_KEY,
  } as unknown as ConfigService;
  const api = new EasyOrdersApiClient(provider.http);
  const limiter = new EasyOrdersRateLimiter();
  const repository = connections as unknown as EasyOrdersConnectionsRepository;
  const adapter = new EasyOrdersOutcomeAdapter(
    repository,
    api,
    limiter,
    config,
  );
  const normalizer = new EasyOrdersOrderNormalizer(
    repository,
    api,
    limiter,
    new PhoneService(),
    config,
  );
  const request = (
    action: CommerceOutcomeAction,
  ): CommerceOutcomeAdapterRequest => ({
    orgId: ORG_ID,
    integrationId: INTEGRATION_ID,
    externalOrderId: order.id,
    correlationId: 'adapter-contract-verification',
    action,
    connection: {} as CommerceOutcomeAdapterRequest['connection'],
  });
  return {
    order,
    provider,
    apiKey,
    connection,
    connections,
    adapter,
    normalizer,
    request,
  };
}

defineCommerceOutcomeAdapterContract({
  name: 'EasyOrders',
  platformType: 'easyorders',
  capabilities: EASYORDERS_OUTCOME_ACTIONS,
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

describe('EasyOrders adapter against the provider fake', () => {
  describe('mapping fixtures', () => {
    it.each(EASYORDERS_OUTCOME_ACTIONS)(
      'writes the approved status for %s, once, from pending',
      async (action) => {
        const { adapter, request, provider, order, apiKey } = setup();

        await expect(adapter.execute(request(action))).resolves.toEqual({
          status: 'applied',
          providerStatus: easyOrdersStatusFor(action),
        });

        expect(provider.statusOf(order.id)).toBe(easyOrdersStatusFor(action));
        expect(provider.writes()).toEqual([
          {
            method: 'PATCH',
            key: apiKey,
            orderId: order.id,
            status: easyOrdersStatusFor(action),
            answered: 200,
          },
        ]);
      },
    );

    it('the status fixture is the transition a customer confirmation makes', async () => {
      const { adapter, request, provider, order } = setup();
      const status = orderStatusFixture();

      expect(status.order_id).toBe(order.id);
      expect(status.old_status).toBe(EASYORDERS_WRITABLE_FROM_STATUS);
      expect(order.status).toBe(status.old_status);

      await adapter.execute(request('customer_confirmation'));

      expect(provider.statusOf(order.id)).toBe(status.new_status);
    });

    it.each(
      COMMERCE_OUTCOME_ACTIONS.filter(
        (action) => !EASYORDERS_OUTCOME_ACTIONS.includes(action),
      ),
    )(
      '%s is unsupported and reaches EasyOrders with nothing',
      async (action) => {
        const { adapter, request, provider, order } = setup();

        await expect(adapter.execute(request(action))).resolves.toEqual({
          status: 'unsupported',
          reason: 'capability_not_supported',
        });

        expect(provider.requests).toHaveLength(0);
        expect(provider.statusOf(order.id)).toBe('pending');
      },
    );

    it('offers nothing and asks nothing while remote writes are switched off', async () => {
      const { adapter, request, provider } = setup({ enabled: false });

      expect(adapter.capabilities.size).toBe(0);
      for (const action of COMMERCE_OUTCOME_ACTIONS)
        await expect(adapter.execute(request(action))).resolves.toMatchObject({
          status: 'unsupported',
        });

      expect(provider.requests).toHaveLength(0);
    });

    it('normalizes the order fixture with the integration’s currency and phone country', async () => {
      const { normalizer, order, provider } = setup();

      const normalized = await normalizer.normalizeOrder(
        { ...order },
        INTEGRATION_ID,
        ORG_ID,
      );

      expect(normalized).toMatchObject({
        externalOrderId: order.id,
        customerPhone: '+201000000000',
        customerName: order.full_name,
        totalPrice: '750.00',
        currency: 'EGP',
        paymentMethod: 'cod',
        paymentSignals: ['cod'],
      });
      expect(
        new EasyOrdersOrderEligibilityStrategy().evaluateOrderForVerification(
          normalized as NormalizedOrder,
        ),
      ).toMatchObject({ eligible: true, reason: 'cod_match' });
      // The webhook carries the order: no lookup on the webhook path.
      expect(provider.requests).toHaveLength(0);
    });

    it('reads an incomplete order back with the integration’s own key', async () => {
      const { normalizer, order, provider, apiKey } = setup();

      const normalized = await normalizer.normalizeOrder(
        { ...order, full_name: undefined },
        INTEGRATION_ID,
        ORG_ID,
      );

      expect(normalized).toMatchObject({ customerName: order.full_name });
      expect(provider.requests).toEqual([
        { method: 'GET', key: apiKey, orderId: order.id, answered: 200 },
      ]);
    });
  });

  describe('authentication fixtures', () => {
    it('a revoked key stops at once, flags the connection and is not retried', async () => {
      const { adapter, request, provider, order, apiKey, connections } =
        setup();
      provider.revokeKey(apiKey);

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
      expect(provider.requests).toHaveLength(1);
      expect(provider.statusOf(order.id)).toBe('pending');
    });

    it('a key of another store cannot see the order, and nothing is written', async () => {
      const { adapter, request, provider, order, connection } = setup();
      connection.apiKeyEncrypted = encryptToken(
        provider.issueKey(OTHER_STORE_ID),
        ENCRYPTION_KEY,
      );

      await expect(
        adapter.execute(request('customer_cancellation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'order_not_found',
      });

      expect(provider.writes()).toHaveLength(0);
      expect(provider.statusOf(order.id)).toBe('pending');
    });

    it('fails closed if EasyOrders lets a key read another store’s order', async () => {
      const { adapter, request, provider, order, connection } = setup();
      // Section 2 of the contract record: cross-store reads are UNKNOWN.
      provider.behavior.crossStoreReads = true;
      connection.storeId = OTHER_STORE_ID;
      connection.apiKeyEncrypted = encryptToken(
        provider.issueKey(OTHER_STORE_ID),
        ENCRYPTION_KEY,
      );

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'store_mismatch',
      });

      expect(provider.writes()).toHaveLength(0);
      expect(provider.statusOf(order.id)).toBe('pending');
    });

    it('an inactive store is a health state that is retried slowly, not a rejected key', async () => {
      const { adapter, request, provider, order, connections } = setup();
      provider.setStoreActive(order.store_id, false);

      await expect(
        adapter.execute(request('customer_confirmation')),
      ).resolves.toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_store_inactive',
      });

      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'store_inactive',
      );
      expect(provider.writes()).toHaveLength(0);
    });
  });
});
