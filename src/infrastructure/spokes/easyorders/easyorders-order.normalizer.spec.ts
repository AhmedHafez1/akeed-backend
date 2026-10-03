import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  EasyOrdersConnection,
  EasyOrdersConnectionsRepository,
} from '../../database/repositories/easyorders-connections.repository';
import {
  RetryableProviderError,
  RetryAfterError,
} from '../../../shared/http/bounded-http';
import { PhoneService } from '../../../shared/services/phone.service';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import { orderCreatedFixture } from '../../../../test/fixtures/easyorders/load';
import type {
  EasyOrdersApiClient,
  EasyOrdersOrderLookup,
} from './easyorders-api.client';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';
import {
  EASYORDERS_LOOKUPS_PER_MINUTE,
  EasyOrdersRateLimiter,
} from './easyorders-rate-limiter';

const ENCRYPTION_KEY = 'k'.repeat(32);
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const API_KEY = 'eo-api-key-under-test';
const fixture = orderCreatedFixture();

function connection(
  overrides: Partial<EasyOrdersConnection> = {},
): EasyOrdersConnection {
  return {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeId: fixture.store_id,
    storeVerifiedAt: '2026-10-03T09:00:00.000Z',
    apiKeyEncrypted: encryptToken(API_KEY, ENCRYPTION_KEY),
    webhookTokenHash: 'h'.repeat(64),
    webhookTokenHint: 'abc123',
    ordersWebhookSecretEncrypted: null,
    statusWebhookSecretEncrypted: null,
    health: 'ok',
    currency: 'EGP',
    phoneCountry: 'EG',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    createdAt: '2026-10-03T09:00:00.000Z',
    updatedAt: '2026-10-03T09:00:00.000Z',
    ...overrides,
  };
}

function createNormalizer(
  options: {
    connection?: EasyOrdersConnection | null;
    lookup?: EasyOrdersOrderLookup;
  } = {},
) {
  const bound =
    options.connection === undefined ? connection() : options.connection;
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(bound ?? undefined),
    setHealth: jest.fn().mockResolvedValue(undefined),
    markStoreVerified: jest.fn().mockResolvedValue('verified'),
  };
  const api = {
    getOrder: jest
      .fn<Promise<EasyOrdersOrderLookup>, [string, string]>()
      .mockResolvedValue(
        options.lookup ?? { kind: 'found', order: { ...fixture } },
      ),
  };
  const limiter = new EasyOrdersRateLimiter();
  const normalizer = new EasyOrdersOrderNormalizer(
    connections as unknown as EasyOrdersConnectionsRepository,
    api as unknown as EasyOrdersApiClient,
    limiter,
    new PhoneService(),
    { getOrThrow: () => ENCRYPTION_KEY } as unknown as ConfigService,
  );
  const normalize = (payload: Record<string, unknown> = { ...fixture }) =>
    normalizer.normalizeOrder(payload, INTEGRATION_ID, ORG_ID);
  return { normalizer, normalize, connections, api, limiter };
}

describe('EasyOrdersOrderNormalizer', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(String(args[0]));
        });
  });

  afterEach(() => jest.restoreAllMocks());

  it('normalizes the documented order from the payload and the integration’s settings', async () => {
    const { normalize, api, connections } = createNormalizer();

    await expect(normalize()).resolves.toEqual({
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
      externalOrderId: fixture.id,
      orderNumber: fixture.id.slice(0, 8),
      customerPhone: '+201000000000',
      customerName: 'Test Customer',
      totalPrice: '750.00',
      currency: 'EGP',
      paymentMethod: 'cod',
      paymentSignals: ['cod'],
      rawPayload: fixture,
    });
    expect(connections.findByIntegration).toHaveBeenCalledWith(
      INTEGRATION_ID,
      ORG_ID,
    );
    // A complete order from a verified store costs no request.
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['a local number', '01000000000', 'EG', '+201000000000'],
    ['a local number with spaces', '0100 000 0000', 'EG', '+201000000000'],
    ['an international number', '+966512345678', 'EG', '+966512345678'],
    ['a 00-prefixed number', '00966512345678', 'EG', '+966512345678'],
    ['a local Saudi number', '0512345678', 'SA', '+966512345678'],
  ])(
    'reads %s in the integration’s phone country',
    async (_label, phone, phoneCountry, e164) => {
      const { normalize } = createNormalizer({
        connection: connection({ phoneCountry }),
      });

      await expect(normalize({ ...fixture, phone })).resolves.toMatchObject({
        customerPhone: e164,
      });
    },
  );

  it.each([
    ['a number that does not parse', '12345'],
    ['a landline', '0223456789'],
    ['text', 'call me'],
  ])('does not guess %s', async (_label, phone) => {
    const { normalize } = createNormalizer();

    await expect(normalize({ ...fixture, phone })).resolves.toEqual({
      skipped: true,
      reason: 'invalid_phone',
    });
  });

  it.each([
    [{ currency: null }, 'missing_currency'],
    [{ phoneCountry: null }, 'missing_phone_country'],
  ])('records %j as a reason instead of guessing', async (settings, reason) => {
    const { normalize } = createNormalizer({
      connection: connection(settings),
    });

    await expect(normalize()).resolves.toEqual({ skipped: true, reason });
  });

  it.each([
    [0, 'invalid_amount'],
    [-5, 'invalid_amount'],
    ['12,50', 'invalid_amount'],
    [Number.NaN, 'invalid_amount'],
  ])('refuses the amount %j', async (totalCost, reason) => {
    const { normalize } = createNormalizer();

    await expect(
      normalize({ ...fixture, total_cost: totalCost }),
    ).resolves.toEqual({ skipped: true, reason });
  });

  it('writes the amount as decimal text', async () => {
    const { normalize } = createNormalizer();

    await expect(
      normalize({ ...fixture, total_cost: 99.5 }),
    ).resolves.toMatchObject({ totalPrice: '99.50' });
  });

  it('passes a non-COD method through for the eligibility strategy to judge', async () => {
    const { normalize } = createNormalizer();

    await expect(
      normalize({ ...fixture, payment_method: 'card' }),
    ).resolves.toMatchObject({
      paymentMethod: 'card',
      paymentSignals: ['card'],
    });
  });

  it('stops an order naming another store, without a request', async () => {
    const { normalize, api } = createNormalizer();

    await expect(
      normalize({ ...fixture, store_id: 'another-store' }),
    ).resolves.toEqual({ skipped: true, reason: 'store_mismatch' });
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it('stops when the integration has no connection', async () => {
    const { normalize } = createNormalizer({ connection: null });

    await expect(normalize()).resolves.toEqual({
      skipped: true,
      reason: 'source_connection_missing',
    });
  });

  describe('order lookup', () => {
    it.each(['total_cost', 'phone', 'full_name', 'payment_method'])(
      'reads the order back when %s is missing, with this integration’s key',
      async (field) => {
        const { normalize, api } = createNormalizer();

        const result = await normalize({ ...fixture, [field]: undefined });

        expect(api.getOrder).toHaveBeenCalledTimes(1);
        expect(api.getOrder).toHaveBeenCalledWith(API_KEY, fixture.id);
        expect(result).toMatchObject({
          customerPhone: '+201000000000',
          customerName: 'Test Customer',
          totalPrice: '750.00',
          paymentMethod: 'cod',
        });
      },
    );

    it('keeps what the webhook said and only fills what it lacked', async () => {
      const { normalize } = createNormalizer({
        lookup: {
          kind: 'found',
          order: { ...fixture, total_cost: 1, full_name: 'From the API' },
        },
      });

      await expect(
        normalize({ ...fixture, full_name: undefined }),
      ).resolves.toMatchObject({
        customerName: 'From the API',
        totalPrice: '750.00',
      });
    });

    it('records an order that is still incomplete after the lookup', async () => {
      const { normalize } = createNormalizer({
        lookup: {
          kind: 'found',
          order: { id: fixture.id, store_id: fixture.store_id },
        },
      });

      await expect(
        normalize({ ...fixture, phone: undefined }),
      ).resolves.toEqual({ skipped: true, reason: 'incomplete_payload' });
    });

    it('verifies an unverified store on its first order, then stops asking', async () => {
      const unverified = createNormalizer({
        connection: connection({ storeVerifiedAt: null }),
      });

      await expect(unverified.normalize()).resolves.toMatchObject({
        externalOrderId: fixture.id,
      });
      expect(unverified.api.getOrder).toHaveBeenCalledTimes(1);
      expect(unverified.connections.markStoreVerified).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        fixture.store_id,
      );

      const verified = createNormalizer();
      await verified.normalize();
      expect(verified.api.getOrder).not.toHaveBeenCalled();
      expect(verified.connections.markStoreVerified).not.toHaveBeenCalled();
    });

    it.each([
      [
        'names another store',
        { ...fixture, store_id: 'another-store' },
        'store_mismatch',
      ],
      ['names no store', { id: fixture.id }, 'store_unverified'],
    ])(
      'does not verify or use a fetched order that %s',
      async (_label, order, reason) => {
        const { normalize, connections } = createNormalizer({
          connection: connection({ storeVerifiedAt: null }),
          lookup: { kind: 'found', order },
        });

        await expect(normalize()).resolves.toEqual({ skipped: true, reason });
        expect(connections.markStoreVerified).not.toHaveBeenCalled();
      },
    );

    it('stops when another integration already holds the verified store', async () => {
      const { normalize, connections } = createNormalizer({
        connection: connection({ storeVerifiedAt: null }),
      });
      connections.markStoreVerified.mockResolvedValue('taken');

      await expect(normalize()).resolves.toEqual({
        skipped: true,
        reason: 'store_unavailable',
      });
    });

    it('treats 401 and 403 as permanent: health is set and the job is not retried', async () => {
      const { normalize, connections } = createNormalizer({
        lookup: { kind: 'credentials_rejected' },
      });

      await expect(
        normalize({ ...fixture, phone: undefined }),
      ).resolves.toEqual({
        skipped: true,
        reason: 'source_credentials_rejected',
      });
      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'credentials_rejected',
      );
    });

    it('records an order the key cannot see', async () => {
      const { normalize } = createNormalizer({ lookup: { kind: 'not_found' } });

      await expect(
        normalize({ ...fixture, phone: undefined }),
      ).resolves.toEqual({ skipped: true, reason: 'order_not_found' });
    });

    it('asks for a delayed retry on 429 and pauses the integration’s other calls', async () => {
      const { normalize, limiter } = createNormalizer({
        lookup: { kind: 'rate_limited', retryAfterMs: 42_000 },
      });

      const error = await normalize({ ...fixture, phone: undefined }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RetryAfterError);
      expect((error as RetryAfterError).delayMs).toBe(42_000);
      expect((error as RetryAfterError).message).toBe('source_rate_limited');
      expect(limiter.acquire(INTEGRATION_ID, 'outcome').allowed).toBe(false);
      expect(limiter.acquire('another-integration', 'lookup').allowed).toBe(
        true,
      );
    });

    it('waits for the next clock minute when a 429 gives no Retry-After', async () => {
      const { normalize } = createNormalizer({
        lookup: { kind: 'rate_limited', retryAfterMs: null },
      });

      const error = (await normalize({ ...fixture, phone: undefined }).catch(
        (caught: unknown) => caught,
      )) as RetryAfterError;

      expect(error).toBeInstanceOf(RetryAfterError);
      expect(error.delayMs).toBeGreaterThan(0);
      expect(error.delayMs).toBeLessThanOrEqual(70_000);
    });

    it('retries a transient failure through the queue', async () => {
      const { normalize } = createNormalizer({
        lookup: { kind: 'unavailable' },
      });

      const error = await normalize({ ...fixture, phone: undefined }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect(error).not.toBeInstanceOf(RetryAfterError);
    });

    it('treats an inactive store as a health state with a slow retry', async () => {
      const { normalize, connections } = createNormalizer({
        lookup: { kind: 'store_inactive' },
      });

      const error = (await normalize({ ...fixture, phone: undefined }).catch(
        (caught: unknown) => caught,
      )) as RetryAfterError;

      expect(error).toBeInstanceOf(RetryAfterError);
      expect(error.delayMs).toBe(5 * 60_000);
      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'store_inactive',
      );
    });

    it('stays inside the per-integration lookup budget', async () => {
      const { normalize, api } = createNormalizer();
      const incomplete = { ...fixture, phone: undefined };
      jest.useFakeTimers().setSystemTime(new Date('2026-10-03T10:00:01.000Z'));
      try {
        for (let call = 0; call < EASYORDERS_LOOKUPS_PER_MINUTE; call += 1)
          await normalize(incomplete);

        const error = await normalize(incomplete).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(RetryAfterError);
        expect((error as RetryAfterError).message).toBe(
          'source_rate_budget_exhausted',
        );
        expect(api.getOrder).toHaveBeenCalledTimes(
          EASYORDERS_LOOKUPS_PER_MINUTE,
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('never writes the key or customer data into a log line', async () => {
    const { normalize } = createNormalizer({
      connection: connection({ storeVerifiedAt: null }),
    });
    await normalize();
    await normalize({ ...fixture, phone: '12345' });

    const output = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const forbidden of [
      API_KEY,
      fixture.phone,
      fixture.full_name,
      fixture.address,
    ])
      expect(output).not.toContain(forbidden);
  });
});
