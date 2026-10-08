import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  EasyOrdersConnection,
  EasyOrdersConnectionsRepository,
} from '../../database/repositories/easyorders-connections.repository';
import type { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../../../modules/webhook-queue/webhook-queue.constants';
import { EASYORDERS_CONFIG } from '../../../shared/config/easyorders.config';
import {
  decryptToken,
  encryptToken,
} from '../../../shared/utils/token-encryption.util';
import {
  orderCreatedFixture,
  orderStatusFixture,
} from '../../../../test/fixtures/easyorders/load';
import {
  generateInstallToken,
  hashInstallToken,
} from '../../../shared/commerce/install-token';
import type {
  EasyOrdersApiClient,
  EasyOrdersOrderLookup,
} from './easyorders-api.client';
import { EASYORDERS_UNVERIFIED_MARKER } from './easyorders-ingestion.policy';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';
import { EasyOrdersWebhookService } from './easyorders-webhook.service';

const orderCreated = orderCreatedFixture();
const statusUpdate = orderStatusFixture();
const ENCRYPTION_KEY = 'k'.repeat(32);
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const STORE_ID = orderCreated.store_id;
const ORDERS_SECRET = 'orders-secret-01';
const STATUS_SECRET = 'status-secret-02';
const TOKEN = generateInstallToken();

function connection(
  overrides: Partial<EasyOrdersConnection> = {},
): EasyOrdersConnection {
  return {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeId: STORE_ID,
    storeVerifiedAt: null,
    apiKeyEncrypted: encryptToken('api-key', ENCRYPTION_KEY),
    webhookTokenHash: hashInstallToken(TOKEN),
    webhookTokenHint: TOKEN.slice(-6),
    webhookTokenEncrypted: encryptToken(TOKEN, ENCRYPTION_KEY),
    providerCleanup: null,
    ordersWebhookSecretEncrypted: encryptToken(ORDERS_SECRET, ENCRYPTION_KEY),
    disconnectedAt: null,
    disconnectedBy: null,
    statusWebhookSecretEncrypted: encryptToken(STATUS_SECRET, ENCRYPTION_KEY),
    health: 'ok',
    currency: 'EGP',
    phoneCountry: 'EG',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

function createService(
  options: {
    ingestionEnabled?: boolean;
    connection?: EasyOrdersConnection | null;
    sourceActive?: boolean;
    lookup?: EasyOrdersOrderLookup;
    budgetLeft?: boolean;
  } = {},
) {
  const bound =
    options.connection === undefined ? connection() : options.connection;
  const connections = {
    findByWebhookTokenHash: jest.fn((hash: string) =>
      Promise.resolve(
        bound && hash === bound.webhookTokenHash
          ? { connection: bound, sourceActive: options.sourceActive ?? true }
          : undefined,
      ),
    ),
    recordRejectedDelivery: jest.fn().mockResolvedValue(undefined),
    learnWebhookSecret: jest.fn().mockResolvedValue(true),
  };
  const api = {
    getOrder: jest.fn().mockResolvedValue(
      options.lookup ?? {
        kind: 'found',
        order: { ...orderCreated },
      },
    ),
  };
  const limiter = new EasyOrdersRateLimiter();
  if (options.budgetLeft === false)
    jest
      .spyOn(limiter, 'acquire')
      .mockReturnValue({ allowed: false, retryAfterMs: 1_000 });
  const pause = jest.spyOn(limiter, 'pause');
  const producer = {
    ingest: jest.fn().mockResolvedValue({ enqueued: true }),
  };
  const config = {
    get: (key: string) =>
      key === EASYORDERS_CONFIG
        ? { ingestionEnabled: options.ingestionEnabled ?? true }
        : undefined,
    getOrThrow: () => ENCRYPTION_KEY,
  };
  const service = new EasyOrdersWebhookService(
    connections as unknown as EasyOrdersConnectionsRepository,
    producer as unknown as WebhookQueueProducer,
    config as unknown as ConfigService,
    api as unknown as EasyOrdersApiClient,
    limiter,
  );
  return { service, connections, producer, api, pause };
}

async function answerOf(
  promise: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    await promise;
    return { status: 200 };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { code?: string }).code,
    };
  }
}

describe('EasyOrdersWebhookService', () => {
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

  describe('order created', () => {
    it('queues an authenticated order under the token’s tenant, keyed by integration and order', async () => {
      const { service, producer } = createService();

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).resolves.toEqual({ received: true });

      expect(producer.ingest).toHaveBeenCalledTimes(1);
      expect(producer.ingest).toHaveBeenCalledWith({
        platform: 'easyorders',
        storeDomain: `easyorders:${ORG_ID}`,
        jobType: WebhookJobType.ORDER_CREATE,
        idempotencyKey: `order.create:${INTEGRATION_ID}:${orderCreated.id}`,
        rawPayload: orderCreated,
      });
    });

    it('asks EasyOrders nothing while it holds the secret', async () => {
      const { service, api, connections } = createService();

      await service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated);

      expect(api.getOrder).not.toHaveBeenCalled();
      expect(connections.learnWebhookSecret).not.toHaveBeenCalled();
    });

    it('drops a marker the payload brought itself', async () => {
      const { service, producer } = createService();

      await service.handleOrderCreated(TOKEN, ORDERS_SECRET, {
        ...orderCreated,
        [EASYORDERS_UNVERIFIED_MARKER]: true,
      });

      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ rawPayload: orderCreated }),
      );
    });

    it('answers a repeated delivery as a duplicate', async () => {
      const { service, producer } = createService();
      producer.ingest.mockResolvedValue({ enqueued: false, duplicate: true });

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).resolves.toEqual({ received: true, duplicate: true });
    });

    it('still acknowledges when the queue is down: the event row is the durable record', async () => {
      const { service, producer } = createService();
      producer.ingest.mockResolvedValue({ enqueued: false });

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).resolves.toEqual({ received: true });
    });

    it('does not acknowledge an event it could not persist', async () => {
      const { service, producer } = createService();
      producer.ingest.mockRejectedValue(new Error('connection terminated'));

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).rejects.toThrow('connection terminated');
      expect(
        logged.some((line) =>
          line.includes('easyorders-webhook-not-persisted'),
        ),
      ).toBe(true);
    });

    it.each([
      ['an unknown token', generateInstallToken(), ORDERS_SECRET, {}],
      ['a malformed token', 'not-a-token', ORDERS_SECRET, {}],
      ['a wrong secret', TOKEN, 'orders-secret-00', {}],
      ['a secret of another length', TOKEN, 'short', {}],
      ['no secret header', TOKEN, undefined, {}],
      ['the status webhook’s secret', TOKEN, STATUS_SECRET, {}],
      [
        'no secret header while none is held yet',
        TOKEN,
        undefined,
        { connection: connection({ ordersWebhookSecretEncrypted: null }) },
      ],
      [
        'something that is not a secret while none is held yet',
        TOKEN,
        'a b',
        { connection: connection({ ordersWebhookSecretEncrypted: null }) },
      ],
      ['a disconnected source', TOKEN, ORDERS_SECRET, { sourceActive: false }],
    ])(
      'answers 401 and queues nothing for %s',
      async (_label, token, secret, options) => {
        const { service, producer } = createService(options);

        await expect(
          answerOf(service.handleOrderCreated(token, secret, orderCreated)),
        ).resolves.toEqual({
          status: 401,
          code: 'EASYORDERS_WEBHOOK_UNAUTHORIZED',
        });
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );

    it('never looks up a malformed token', async () => {
      const { service, connections } = createService();

      await answerOf(
        service.handleOrderCreated('../etc', ORDERS_SECRET, orderCreated),
      );

      expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
    });

    it('counts a wrong secret on a valid token, and nothing else', async () => {
      const { service, connections } = createService();

      await answerOf(service.handleOrderCreated(TOKEN, 'orders-secret-00', {}));
      await answerOf(
        service.handleOrderCreated(generateInstallToken(), ORDERS_SECRET, {}),
      );

      expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
      expect(connections.recordRejectedDelivery).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
      );
    });

    it.each([
      ['another store’s id', { ...orderCreated, store_id: 'other' }],
      ['no store id', { ...orderCreated, store_id: undefined }],
    ])('answers 403 and queues nothing for %s', async (_label, payload) => {
      const { service, producer } = createService();

      await expect(
        answerOf(service.handleOrderCreated(TOKEN, ORDERS_SECRET, payload)),
      ).resolves.toEqual({
        status: 403,
        code: 'EASYORDERS_WEBHOOK_STORE_MISMATCH',
      });
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a status event with the right store id',
        { ...statusUpdate, store_id: STORE_ID, id: 'order-1' },
      ],
      [
        'an unknown event type',
        { ...orderCreated, event_type: 'order-deleted' },
      ],
      ['an order without an id', { ...orderCreated, id: undefined }],
      ['a non-text id', { ...orderCreated, id: 42 }],
      ['an id with spaces', { ...orderCreated, id: 'a b' }],
    ])('keeps %s out of the create path', async (_label, payload) => {
      const { service, producer } = createService();

      await expect(
        answerOf(service.handleOrderCreated(TOKEN, ORDERS_SECRET, payload)),
      ).resolves.toEqual({ status: 400, code: 'EASYORDERS_WEBHOOK_MALFORMED' });
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([[[]], ['text'], [null]])(
      'refuses a body that is not an object: %j',
      async (body) => {
        const { service, producer } = createService();

        expect(
          (
            await answerOf(
              service.handleOrderCreated(TOKEN, ORDERS_SECRET, body),
            )
          ).status,
        ).toBe(403);
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );

    it('answers 404 and reads nothing while ingestion is switched off', async () => {
      const { service, connections, producer } = createService({
        ingestionEnabled: false,
      });

      await expect(
        answerOf(
          service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
        ),
      ).resolves.toEqual({
        status: 404,
        code: 'EASYORDERS_INGESTION_UNAVAILABLE',
      });
      expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
      expect(producer.ingest).not.toHaveBeenCalled();
    });
  });

  describe('learning a secret', () => {
    const unlearned = () => ({
      connection: connection({
        ordersWebhookSecretEncrypted: null,
        statusWebhookSecretEncrypted: null,
      }),
    });

    it('keeps the secret of the first order EasyOrders confirms, encrypted, and queues it unmarked', async () => {
      const { service, connections, producer, api } =
        createService(unlearned());

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).resolves.toEqual({ received: true });

      expect(api.getOrder).toHaveBeenCalledWith('api-key', orderCreated.id);
      const [integrationId, orgId, kind, stored] = connections
        .learnWebhookSecret.mock.calls[0] as [string, string, string, string];
      expect([integrationId, orgId, kind]).toEqual([
        INTEGRATION_ID,
        ORG_ID,
        'orders',
      ]);
      expect(stored).not.toContain(ORDERS_SECRET);
      expect(decryptToken(stored, ENCRYPTION_KEY)).toBe(ORDERS_SECRET);
      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ rawPayload: orderCreated }),
      );
    });

    it.each([
      ['an order the key cannot see', { kind: 'not_found' as const }],
      [
        'an order of another store',
        {
          kind: 'found' as const,
          order: { ...orderCreated, store_id: 'other-store' },
        },
      ],
    ])('refuses %s, counts it and keeps nothing', async (_label, lookup) => {
      const { service, connections, producer } = createService({
        ...unlearned(),
        lookup,
      });

      await expect(
        answerOf(
          service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
        ),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_WEBHOOK_UNAUTHORIZED',
      });
      expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
      expect(connections.learnWebhookSecret).not.toHaveBeenCalled();
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([
      [
        'EasyOrders is unavailable',
        { lookup: { kind: 'unavailable' as const } },
      ],
      [
        'EasyOrders rate limits the key',
        { lookup: { kind: 'rate_limited' as const, retryAfterMs: 30_000 } },
      ],
      [
        'the store is inactive',
        { lookup: { kind: 'store_inactive' as const } },
      ],
      [
        'the key is rejected',
        { lookup: { kind: 'credentials_rejected' as const } },
      ],
      [
        'EasyOrders answers without a store id',
        { lookup: { kind: 'found' as const, order: {} } },
      ],
      ['the rate budget is spent', { budgetLeft: false }],
    ])(
      'takes the order marked for a read-back and keeps nothing when %s',
      async (_label, options) => {
        const { service, connections, producer } = createService({
          ...unlearned(),
          ...options,
        });

        await expect(
          service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
        ).resolves.toEqual({ received: true });

        expect(connections.learnWebhookSecret).not.toHaveBeenCalled();
        expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
        expect(producer.ingest).toHaveBeenCalledWith(
          expect.objectContaining({
            rawPayload: {
              ...orderCreated,
              [EASYORDERS_UNVERIFIED_MARKER]: true,
            },
          }),
        );
      },
    );

    it('spends no request when the budget is spent, and holds the budget after a 429', async () => {
      const spent = createService({ ...unlearned(), budgetLeft: false });
      await spent.service.handleOrderCreated(
        TOKEN,
        ORDERS_SECRET,
        orderCreated,
      );
      expect(spent.api.getOrder).not.toHaveBeenCalled();

      const limited = createService({
        ...unlearned(),
        lookup: { kind: 'rate_limited', retryAfterMs: 30_000 },
      });
      await limited.service.handleOrderCreated(
        TOKEN,
        ORDERS_SECRET,
        orderCreated,
      );
      expect(limited.pause).toHaveBeenCalledWith(INTEGRATION_ID, 30_000);
    });

    it('lets the first writer win: a second learner is still accepted', async () => {
      const { service, connections, producer } = createService(unlearned());
      connections.learnWebhookSecret.mockResolvedValue(false);

      await expect(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
      ).resolves.toEqual({ received: true });
      expect(producer.ingest).toHaveBeenCalledTimes(1);
    });

    it('learns the status webhook’s own secret from the order its event names', async () => {
      const { service, connections, producer, api } =
        createService(unlearned());

      await expect(
        service.handleStatusUpdate(TOKEN, STATUS_SECRET, statusUpdate),
      ).resolves.toEqual({ received: true });

      expect(api.getOrder).toHaveBeenCalledWith(
        'api-key',
        statusUpdate.order_id,
      );
      expect(connections.learnWebhookSecret).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORG_ID,
        'status',
        expect.stringMatching(/^v1:/),
      );
      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ rawPayload: statusUpdate }),
      );
    });

    it('refuses a status event naming an order the key cannot see, and records one it cannot check', async () => {
      const forged = createService({
        ...unlearned(),
        lookup: { kind: 'not_found' },
      });
      expect(
        (
          await answerOf(
            forged.service.handleStatusUpdate(
              TOKEN,
              STATUS_SECRET,
              statusUpdate,
            ),
          )
        ).status,
      ).toBe(401);
      expect(forged.producer.ingest).not.toHaveBeenCalled();

      const unknown = createService({
        ...unlearned(),
        lookup: { kind: 'unavailable' },
      });
      await unknown.service.handleStatusUpdate(
        TOKEN,
        STATUS_SECRET,
        statusUpdate,
      );
      expect(unknown.connections.learnWebhookSecret).not.toHaveBeenCalled();
      expect(unknown.producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ rawPayload: statusUpdate }),
      );
    });

    it('reads nothing back before the payload checks pass', async () => {
      const { service, api } = createService(unlearned());

      await answerOf(
        service.handleOrderCreated(TOKEN, ORDERS_SECRET, {
          ...orderCreated,
          store_id: 'other',
        }),
      );
      await answerOf(
        service.handleStatusUpdate(TOKEN, STATUS_SECRET, orderCreated),
      );

      expect(api.getOrder).not.toHaveBeenCalled();
    });
  });

  describe('status update', () => {
    it('records the event as an update, keyed by integration, order and transition', async () => {
      const { service, producer } = createService();

      await expect(
        service.handleStatusUpdate(TOKEN, STATUS_SECRET, statusUpdate),
      ).resolves.toEqual({ received: true });

      expect(producer.ingest).toHaveBeenCalledWith({
        platform: 'easyorders',
        storeDomain: `easyorders:${ORG_ID}`,
        jobType: WebhookJobType.ORDER_UPDATE,
        idempotencyKey: `order.status:${INTEGRATION_ID}:${statusUpdate.order_id}:pending:confirmed`,
        rawPayload: statusUpdate,
      });
    });

    it('needs the status webhook’s own secret', async () => {
      const { service, producer } = createService();

      expect(
        (
          await answerOf(
            service.handleStatusUpdate(TOKEN, ORDERS_SECRET, statusUpdate),
          )
        ).status,
      ).toBe(401);
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([
      ['an order payload', orderCreated],
      [
        'an unknown event type',
        { ...statusUpdate, event_type: 'order-refunded' },
      ],
      ['a missing transition', { ...statusUpdate, new_status: '' }],
    ])('refuses %s', async (_label, payload) => {
      const { service, producer } = createService();

      await expect(
        answerOf(service.handleStatusUpdate(TOKEN, STATUS_SECRET, payload)),
      ).resolves.toEqual({ status: 400, code: 'EASYORDERS_WEBHOOK_MALFORMED' });
      expect(producer.ingest).not.toHaveBeenCalled();
    });
  });

  it('never writes the token, a secret or the payload into a log line', async () => {
    const { service, producer } = createService();
    producer.ingest.mockRejectedValueOnce(new Error('connection terminated'));

    await answerOf(
      service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
    ).catch(() => undefined);
    await service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated);
    await answerOf(
      service.handleOrderCreated(TOKEN, 'wrong-secret-000', orderCreated),
    );
    await answerOf(
      service.handleOrderCreated(TOKEN, ORDERS_SECRET, {
        ...orderCreated,
        store_id: 'other-store',
      }),
    );
    const learning = {
      connection: connection({ ordersWebhookSecretEncrypted: null }),
    };
    await createService(learning).service.handleOrderCreated(
      TOKEN,
      ORDERS_SECRET,
      orderCreated,
    );
    await answerOf(
      createService({
        ...learning,
        lookup: { kind: 'not_found' },
      }).service.handleOrderCreated(TOKEN, ORDERS_SECRET, orderCreated),
    );
    expect(logged.join('\n')).toContain('easyorders-webhook-secret-learn');

    const output = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const forbidden of [
      TOKEN,
      hashInstallToken(TOKEN),
      ORDERS_SECRET,
      'wrong-secret-000',
      orderCreated.phone,
      orderCreated.full_name,
      orderCreated.address,
    ])
      expect(output).not.toContain(forbidden);
  });
});
