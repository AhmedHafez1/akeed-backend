import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import type { OrdersRepository } from '../../database/repositories/orders.repository';
import type { WebhookEventsRepository } from '../../database/repositories/webhook-events.repository';
import type { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import { WOOCOMMERCE_CONFIG } from '../../../shared/config/woocommerce.config';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import {
  checkoutDraftFixture,
  orderUpdatedFixture,
  placedCodFixture,
  pingFixture,
} from '../../../../test/fixtures/woocommerce/load';
import { projectWooCommerceOrder } from './woocommerce-delivery';
import { hashInstallToken } from '../../../shared/commerce/install-token';
import {
  isOrderDeliveryTopic,
  isValidWooCommerceSignature,
  WooCommerceWebhookService,
  type WooCommerceDeliveryHeaders,
} from './woocommerce-webhook.service';

const ENCRYPTION_KEY = 'k'.repeat(32);
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'w'.repeat(43);
const STORE_URL = 'https://example.com';
const SOURCE_IDENTITY = `woocommerce:${ORG_ID}`;
/** Synthetic, generated per run: never a real secret. */
const SECRET = randomBytes(32).toString('base64url');

function connection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeUrl: STORE_URL,
    storeVerifiedAt: '2025-12-31T00:00:00.000Z',
    consumerKeyEncrypted: 'v1:synthetic',
    consumerSecretEncrypted: 'v1:synthetic',
    webhookSecretEncrypted: encryptToken(SECRET, ENCRYPTION_KEY),
    webhookTokenHash: hashInstallToken(TOKEN),
    orderCreatedWebhookId: 101,
    orderUpdatedWebhookId: 102,
    orderCreatedWebhookState: 'active',
    orderUpdatedWebhookState: 'active',
    webhooksCheckedAt: '2025-12-31T00:00:00.000Z',
    disconnectedAt: null,
    disconnectedBy: null,
    wooVersion: '9.8.1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    // Before every fixture order was created.
    connectedAt: '2025-12-31T00:00:00.000Z',
    createdAt: '2025-12-31T00:00:00.000Z',
    updatedAt: '2025-12-31T00:00:00.000Z',
    ...overrides,
  };
}

interface Setup {
  ingestionEnabled?: boolean;
  /** The connection the token resolves to; null for none. */
  connection?: WooCommerceConnection | null;
  /** Whether the token is one Akeed issued (a connection or an open install). */
  known?: boolean;
  hasCreateEvent?: boolean;
  /** The create event Akeed holds for the order, as its row reads. */
  createEvent?: { status: string; lastError: string | null };
  /** Whether Akeed holds an order for it. */
  hasOrder?: boolean;
}

function createService(setup: Setup = {}) {
  const bound =
    setup.connection === undefined ? connection() : setup.connection;
  const connections = {
    isKnownWebhookToken: jest
      .fn()
      .mockResolvedValue(setup.known ?? Boolean(bound)),
    findByWebhookTokenHash: jest.fn().mockResolvedValue(bound ?? undefined),
    recordRejectedDelivery: jest.fn().mockResolvedValue(undefined),
  };
  const events = {
    findBySourceAndIdempotency: jest
      .fn()
      .mockResolvedValue(
        setup.createEvent
          ? { id: 'event-1', ...setup.createEvent }
          : setup.hasCreateEvent
            ? { id: 'event-1', status: 'completed', lastError: null }
            : undefined,
      ),
  };
  const orders = {
    findBySourceExternalId: jest
      .fn()
      .mockResolvedValue(setup.hasOrder ? { id: 'order-1' } : undefined),
  };
  const producer = {
    ingest: jest
      .fn<Promise<{ enqueued: boolean; duplicate?: boolean }>, [unknown]>()
      .mockResolvedValue({ enqueued: true }),
  };
  const config = {
    get: (key: string) =>
      key === WOOCOMMERCE_CONFIG
        ? { ingestionEnabled: setup.ingestionEnabled ?? true }
        : undefined,
    getOrThrow: (key: string) => {
      if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return ENCRYPTION_KEY;
      throw new Error(`Unexpected configuration key ${key}`);
    },
  };
  const service = new WooCommerceWebhookService(
    connections as unknown as WooCommerceConnectionsRepository,
    events as unknown as WebhookEventsRepository,
    orders as unknown as OrdersRepository,
    producer as unknown as WebhookQueueProducer,
    config as unknown as ConfigService,
  );
  return { service, connections, events, orders, producer };
}

function sign(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/** A delivery as a store sends it: the exact bytes and their signature. */
function delivery(
  order: unknown = placedCodFixture().payload,
  overrides: WooCommerceDeliveryHeaders = {},
): { headers: WooCommerceDeliveryHeaders; body: Buffer } {
  const body = Buffer.isBuffer(order)
    ? order
    : Buffer.from(JSON.stringify(order), 'utf8');
  return {
    body,
    headers: {
      topic: 'order.created',
      signature: sign(body),
      source: `${STORE_URL}/`,
      webhookId: '9001',
      deliveryId: 'synthetic-delivery-0002',
      ...overrides,
    },
  };
}

async function answerOf(promise: Promise<void>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { code: string }).code,
    };
  }
}

const NOT_FOUND = { status: 404, code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE' };
const UNAUTHORIZED = { status: 401, code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED' };

describe('isOrderDeliveryTopic', () => {
  it.each(['order.created', 'order.updated'])(
    '%s is an order delivery',
    (topic) => {
      expect(isOrderDeliveryTopic(topic)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    '',
    'order.deleted',
    'action.woocommerce_ping',
    'ORDER.CREATED',
    ' order.created',
    ['order.created'],
  ])('%p is not', (topic) => {
    expect(isOrderDeliveryTopic(topic)).toBe(false);
  });
});

describe('isValidWooCommerceSignature', () => {
  const body = Buffer.from('{"id":1001,"total":"450.00"}', 'utf8');

  it('accepts the base64 HMAC-SHA256 of the exact bytes', () => {
    expect(isValidWooCommerceSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('refuses bytes that changed after signing', () => {
    const altered = Buffer.from('{"id":1001,"total":"950.00"}', 'utf8');

    expect(isValidWooCommerceSignature(altered, sign(body), SECRET)).toBe(
      false,
    );
  });

  it('refuses the same JSON serialized differently', () => {
    const respaced = Buffer.from('{ "id": 1001, "total": "450.00" }', 'utf8');

    expect(isValidWooCommerceSignature(respaced, sign(body), SECRET)).toBe(
      false,
    );
  });

  it('refuses a signature made with another secret', () => {
    const other = randomBytes(32).toString('base64url');

    expect(isValidWooCommerceSignature(body, sign(body, other), SECRET)).toBe(
      false,
    );
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a repeated header', ['a', 'b']],
    [
      'the digest in hex',
      createHmac('sha256', SECRET).update(body).digest('hex'),
    ],
    ['a short digest', sign(body).slice(0, 20)],
    ['the digest without its padding', sign(body).slice(0, 43)],
    ['padding in the wrong place', `=${sign(body).slice(0, 43)}`],
  ])('refuses %s', (_label, signature) => {
    expect(isValidWooCommerceSignature(body, signature, SECRET)).toBe(false);
  });
});

describe('WooCommerceWebhookService', () => {
  let logged: string[];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    logged = [];
    spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(String(args[0]));
        }),
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
  });

  describe('the ping', () => {
    it.each([
      [undefined, true],
      ['', true],
      ['action.woocommerce_ping', true],
      ['order.deleted', false],
    ])(
      'answers a request with topic %p on a known token, ingestion on: %s',
      async (topic, ingestionEnabled) => {
        const { service, connections, producer } = createService({
          ingestionEnabled,
        });

        await expect(
          answerOf(
            service.handleDelivery(
              TOKEN,
              { topic },
              Buffer.from(pingFixture(), 'utf8'),
            ),
          ),
        ).resolves.toBe(200);
        // Looked up by hash; the token itself goes nowhere.
        expect(connections.isKnownWebhookToken).toHaveBeenCalledWith(
          hashInstallToken(TOKEN),
        );
        // No check beyond the token, nothing counted, nothing stored.
        expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
        expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );

    it.each([
      [true, UNAUTHORIZED],
      [false, NOT_FOUND],
    ])(
      'on an unknown token with ingestion on %s answers %j',
      async (ingestionEnabled, expected) => {
        const { service } = createService({
          ingestionEnabled,
          connection: null,
        });

        await expect(
          answerOf(service.handleDelivery(TOKEN, {}, Buffer.alloc(0))),
        ).resolves.toEqual(expected);
      },
    );

    it.each(['', 'short', `${'w'.repeat(42)}/`, 'w'.repeat(44)])(
      'never takes the malformed token %p to the database',
      async (token) => {
        const { service, connections } = createService();

        await expect(
          answerOf(service.handleDelivery(token, {}, Buffer.alloc(0))),
        ).resolves.toEqual(UNAUTHORIZED);
        await expect(
          answerOf(
            service.handleDelivery(token, delivery().headers, delivery().body),
          ),
        ).resolves.toEqual(UNAUTHORIZED);
        expect(connections.isKnownWebhookToken).not.toHaveBeenCalled();
        expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
      },
    );
  });

  describe('while ingestion is off', () => {
    it.each(['order.created', 'order.updated'])(
      'answers a valid %s delivery as not found, without looking the token up',
      async (topic) => {
        const { service, connections, producer } = createService({
          ingestionEnabled: false,
        });
        const { headers, body } = delivery(undefined, { topic });

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toEqual(NOT_FOUND);
        expect(connections.isKnownWebhookToken).not.toHaveBeenCalled();
        expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );
  });

  describe('the three-part check', () => {
    it('refuses an unknown token before reading anything else, and counts nothing', async () => {
      const { service, connections, events, producer } = createService({
        connection: null,
      });
      const { headers, body } = delivery();

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, body)),
      ).resolves.toEqual(UNAUTHORIZED);
      expect(connections.findByWebhookTokenHash).toHaveBeenCalledWith(
        hashInstallToken(TOKEN),
      );
      expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
      expect(events.findBySourceAndIdempotency).not.toHaveBeenCalled();
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it('answers an order on the token of an install still connecting, and stores nothing', async () => {
      const { service, connections, producer } = createService({
        connection: null,
        known: true,
      });
      const { headers, body } = delivery();

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, body)),
      ).resolves.toBe(200);
      expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([
      ['no signature', () => ({ signature: undefined })],
      [
        'a signature over other bytes',
        () => ({ signature: sign(Buffer.from('{}')) }),
      ],
      [
        'a signature made with another install’s secret',
        () => ({
          signature: sign(
            delivery().body,
            randomBytes(32).toString('base64url'),
          ),
        }),
      ],
      ['no source', () => ({ source: undefined })],
      [
        'another store as the source',
        () => ({ source: 'https://other.example.com' }),
      ],
      ['the store over plain HTTP', () => ({ source: 'http://example.com/' })],
      [
        'the store under a path',
        () => ({ source: 'https://example.com/shop' }),
      ],
      ['the store with www', () => ({ source: 'https://www.example.com' })],
      ['a source that is not a URL', () => ({ source: 'example.com' })],
    ])(
      'refuses %s, counts it and stores nothing',
      async (_label, overrides) => {
        const { service, connections, events, producer } = createService();
        const { headers, body } = delivery(undefined, overrides());

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toEqual(UNAUTHORIZED);
        expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
        expect(connections.recordRejectedDelivery).toHaveBeenCalledWith(
          INTEGRATION_ID,
          ORG_ID,
        );
        expect(events.findBySourceAndIdempotency).not.toHaveBeenCalled();
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );

    it('refuses bytes altered after signing', async () => {
      const { service, connections, producer } = createService();
      const { headers, body } = delivery();
      const altered = Buffer.from(
        body.toString('utf8').replace('"450.00"', '"950.00"'),
        'utf8',
      );

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, altered)),
      ).resolves.toEqual(UNAUTHORIZED);
      expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
      expect(producer.ingest).not.toHaveBeenCalled();
    });

    it.each([
      ['a parsed object', placedCodFixture().payload],
      ['text', JSON.stringify(placedCodFixture().payload)],
      ['nothing', undefined],
    ])(
      'refuses a body that reached it as %s, not as bytes',
      async (_label, body) => {
        const { service, producer } = createService();

        await expect(
          answerOf(service.handleDelivery(TOKEN, delivery().headers, body)),
        ).resolves.toEqual(UNAUTHORIZED);
        expect(producer.ingest).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['is not ciphertext', 'v1:AAAA:AAAA:AAAA'],
      // `decryptToken` would hand this one back unchanged.
      ['is not in the envelope', 'plain-secret'],
    ])(
      'refuses and counts a delivery whose stored secret %s',
      async (_label, stored) => {
        const { service, connections, producer } = createService({
          connection: connection({ webhookSecretEncrypted: stored }),
        });
        const body = delivery().body;
        // Signed with the stored text itself: it must never work as a key.
        const headers = {
          ...delivery().headers,
          signature: sign(body, stored),
        };

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toEqual(UNAUTHORIZED);
        expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
        expect(producer.ingest).not.toHaveBeenCalled();
        expect(logged.join('\n')).toContain('secret_unreadable');
      },
    );

    it('says which part failed in the log only', async () => {
      const { service } = createService();

      const answers = [
        await answerOf(
          service.handleDelivery(
            TOKEN,
            delivery(undefined, { signature: 'x' }).headers,
            delivery().body,
          ),
        ),
        await answerOf(
          service.handleDelivery(
            TOKEN,
            delivery(undefined, { source: 'https://other.example.com' })
              .headers,
            delivery().body,
          ),
        ),
      ];

      expect(answers).toEqual([UNAUTHORIZED, UNAUTHORIZED]);
      const lines = logged.join('\n');
      expect(lines).toContain('woocommerce-webhook-refused');
      expect(lines).toContain('signature_mismatch');
      expect(lines).toContain('source_mismatch');
    });

    it('accepts the source with or without a trailing slash, in any letter case', async () => {
      for (const source of [
        'https://example.com',
        'https://example.com/',
        'HTTPS://EXAMPLE.COM/',
      ]) {
        const { service, producer } = createService();
        const { headers, body } = delivery(undefined, { source });

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toBe(200);
        expect(producer.ingest).toHaveBeenCalledTimes(1);
      }
    });

    it('binds a store in a subdirectory to its own path', async () => {
      const bound = connection({ storeUrl: 'https://example.com/shop' });
      const inside = createService({ connection: bound });
      const outside = createService({ connection: bound });

      await expect(
        answerOf(
          inside.service.handleDelivery(
            TOKEN,
            delivery(undefined, { source: 'https://example.com/shop/' })
              .headers,
            delivery().body,
          ),
        ),
      ).resolves.toBe(200);
      await expect(
        answerOf(
          outside.service.handleDelivery(
            TOKEN,
            delivery(undefined, { source: 'https://example.com/' }).headers,
            delivery().body,
          ),
        ),
      ).resolves.toEqual(UNAUTHORIZED);
    });
  });

  describe('routing an authenticated delivery', () => {
    it.each(['order.created', 'order.updated'])(
      'writes a placed cash-on-delivery order from %s to the create path',
      async (topic) => {
        const { service, connections, events, producer } = createService();
        const order = placedCodFixture().payload;
        const { headers, body } = delivery(order, { topic });

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toBe(200);
        expect(events.findBySourceAndIdempotency).toHaveBeenCalledWith(
          'woocommerce',
          SOURCE_IDENTITY,
          `order.create:${INTEGRATION_ID}:1001`,
        );
        expect(producer.ingest).toHaveBeenCalledWith({
          platform: 'woocommerce',
          // The tenant the token resolved to; nothing in the payload.
          storeDomain: SOURCE_IDENTITY,
          jobType: 'order.create',
          idempotencyKey: `order.create:${INTEGRATION_ID}:1001`,
          rawPayload: {
            topic,
            webhookId: '9001',
            deliveryId: 'synthetic-delivery-0002',
            order: projectWooCommerceOrder(order),
          },
        });
        expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
      },
    );

    it('records a delivery for an order Akeed already has on the update path', async () => {
      const { service, producer } = createService({ hasCreateEvent: true });
      const { headers, body } = delivery(orderUpdatedFixture().payload, {
        topic: 'order.updated',
      });

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, body)),
      ).resolves.toBe(200);
      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: 'order.update',
          idempotencyKey: `order.update:${INTEGRATION_ID}:1001:completed:2026-01-02T07:30:00`,
        }),
      );
    });

    it.each([
      ['no create event', {}],
      ['a create event that is waiting', { hasCreateEvent: true }],
    ])('does not look for an order with %s', async (_label, setup) => {
      const { service, orders } = createService(setup);
      const { headers, body } = delivery();

      await service.handleDelivery(TOKEN, headers, body);

      expect(orders.findBySourceExternalId).not.toHaveBeenCalled();
    });

    describe('after a create event that ended on the order itself', () => {
      const skipped = { status: 'skipped', lastError: 'invalid_phone' };
      const corrected = {
        ...placedCodFixture().payload,
        date_modified_gmt: '2026-01-01T10:20:00',
      };

      it('tries the next delivery of the order again as a create', async () => {
        const { service, orders, producer } = createService({
          createEvent: skipped,
        });
        const { headers, body } = delivery(corrected, {
          topic: 'order.updated',
        });

        await expect(
          answerOf(service.handleDelivery(TOKEN, headers, body)),
        ).resolves.toBe(200);
        // Under the integration the token resolved to, never the payload.
        expect(orders.findBySourceExternalId).toHaveBeenCalledWith({
          orgId: ORG_ID,
          integrationId: INTEGRATION_ID,
          externalOrderId: '1001',
        });
        expect(producer.ingest).toHaveBeenCalledWith(
          expect.objectContaining({
            jobType: 'order.create',
            idempotencyKey: `order.retry:${INTEGRATION_ID}:1001:processing:2026-01-01T10:20:00`,
          }),
        );
      });

      it('records later deliveries as updates once a retry has made the order', async () => {
        const { service, producer } = createService({
          createEvent: skipped,
          hasOrder: true,
        });
        const { headers, body } = delivery(corrected, {
          topic: 'order.updated',
        });

        await service.handleDelivery(TOKEN, headers, body);

        expect(producer.ingest).toHaveBeenCalledWith(
          expect.objectContaining({
            jobType: 'order.update',
            idempotencyKey: `order.update:${INTEGRATION_ID}:1001:processing:2026-01-01T10:20:00`,
          }),
        );
      });

      it('starts nothing when the order is no longer one to confirm', async () => {
        const { service, producer } = createService({ createEvent: skipped });
        const { headers, body } = delivery(
          { ...corrected, status: 'cancelled' },
          { topic: 'order.updated' },
        );

        await service.handleDelivery(TOKEN, headers, body);

        expect(producer.ingest).toHaveBeenCalledWith(
          expect.objectContaining({
            jobType: 'order.create',
            idempotencyKey: `order.skip:${INTEGRATION_ID}:1001:cancelled:2026-01-01T10:20:00`,
          }),
        );
      });

      it.each([
        ['skipped by the start rule', 'skipped', 'order_not_placed'],
        ['skipped for the source', 'skipped', 'integration_inactive'],
        ['skipped for the account', 'skipped', 'billing_not_active'],
        ['failed', 'failed', 'invalid_phone'],
      ])(
        'keeps the update path for a create event that was %s',
        async (_label, status, lastError) => {
          const { service, orders, producer } = createService({
            createEvent: { status, lastError },
          });
          const { headers, body } = delivery(corrected, {
            topic: 'order.updated',
          });

          await service.handleDelivery(TOKEN, headers, body);

          expect(orders.findBySourceExternalId).not.toHaveBeenCalled();
          expect(producer.ingest).toHaveBeenCalledWith(
            expect.objectContaining({ jobType: 'order.update' }),
          );
        },
      );

      it('does not acknowledge a delivery when the order could not be looked up', async () => {
        const { service, orders, producer } = createService({
          createEvent: skipped,
        });
        orders.findBySourceExternalId.mockRejectedValue(
          new Error('database unavailable'),
        );
        const { headers, body } = delivery(corrected);

        await expect(
          service.handleDelivery(TOKEN, headers, body),
        ).rejects.toThrow('database unavailable');
        expect(producer.ingest).not.toHaveBeenCalled();
      });
    });

    it('records a checkout draft as skipped, away from the create key', async () => {
      const { service, producer } = createService();
      const { headers, body } = delivery(checkoutDraftFixture().payload);

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, body)),
      ).resolves.toBe(200);
      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: 'order.create',
          idempotencyKey: `order.skip:${INTEGRATION_ID}:1001:checkout-draft:2026-01-01T10:00:00`,
        }),
      );
    });

    it('records an order older than the connection as skipped', async () => {
      const { service, producer } = createService({
        connection: connection({ connectedAt: '2026-06-01T00:00:00.000Z' }),
      });
      const { headers, body } = delivery();

      await service.handleDelivery(TOKEN, headers, body);

      expect(producer.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `order.skip:${INTEGRATION_ID}:1001:processing:2026-01-01T10:01:00`,
        }),
      );
    });

    it('parses the bytes as JSON whatever the content type said', async () => {
      // The service never sees a content type: only the bytes and headers.
      const { service, producer } = createService();
      const body = Buffer.from(
        `\n  ${JSON.stringify(placedCodFixture().payload)}  \n`,
        'utf8',
      );

      await expect(
        answerOf(
          service.handleDelivery(
            TOKEN,
            { ...delivery().headers, signature: sign(body) },
            body,
          ),
        ),
      ).resolves.toBe(200);
      expect(producer.ingest).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a body that is not JSON', Buffer.from('webhook_id=9001', 'utf8')],
      ['an empty body', Buffer.alloc(0)],
      ['a JSON array', Buffer.from('[{"id":1001}]', 'utf8')],
      [
        'an order without an id',
        Buffer.from('{"status":"processing"}', 'utf8'),
      ],
      ['an id sent as text', Buffer.from('{"id":"1001"}', 'utf8')],
      ['an id of zero', Buffer.from('{"id":0}', 'utf8')],
    ])(
      'answers 200 to a signed delivery with %s and stores nothing',
      async (_label, body) => {
        const { service, connections, events, producer } = createService();

        await expect(
          answerOf(
            service.handleDelivery(
              TOKEN,
              { ...delivery().headers, signature: sign(body) },
              body,
            ),
          ),
        ).resolves.toBe(200);
        expect(events.findBySourceAndIdempotency).not.toHaveBeenCalled();
        expect(producer.ingest).not.toHaveBeenCalled();
        expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
        expect(logged.join('\n')).toContain('no_order_id');
      },
    );
  });

  describe('acknowledgement', () => {
    it('answers only after the event was written', async () => {
      const { service, producer } = createService();
      let written = false;
      producer.ingest.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        written = true;
        return { enqueued: true };
      });
      const { headers, body } = delivery();

      await service.handleDelivery(TOKEN, headers, body);

      expect(written).toBe(true);
    });

    it.each([
      ['a repeat of a stored event', { enqueued: false, duplicate: true }],
      ['a queue outage', { enqueued: false }],
    ])('answers 200 for %s', async (_label, result) => {
      const { service, producer } = createService();
      producer.ingest.mockResolvedValue(result);
      const { headers, body } = delivery();

      await expect(
        answerOf(service.handleDelivery(TOKEN, headers, body)),
      ).resolves.toBe(200);
    });

    it('does not acknowledge an event it could not write, and logs it apart from a refusal', async () => {
      const { service, producer } = createService();
      const failure = new Error('connection terminated');
      producer.ingest.mockRejectedValue(failure);
      const { headers, body } = delivery();

      await expect(service.handleDelivery(TOKEN, headers, body)).rejects.toBe(
        failure,
      );
      const lines = logged.join('\n');
      expect(lines).toContain('woocommerce-webhook-not-persisted');
      expect(lines).not.toContain('woocommerce-webhook-refused');
    });

    it('treats a failed read of the create event the same way', async () => {
      const { service, events, producer } = createService();
      const failure = new Error('connection terminated');
      events.findBySourceAndIdempotency.mockRejectedValue(failure);
      const { headers, body } = delivery();

      await expect(service.handleDelivery(TOKEN, headers, body)).rejects.toBe(
        failure,
      );
      expect(producer.ingest).not.toHaveBeenCalled();
      expect(logged.join('\n')).toContain('woocommerce-webhook-not-persisted');
    });
  });

  it('never writes the token, the secret, a signature, the source or customer data into a log line', async () => {
    const accepted = createService();
    const refused = createService();
    const { headers, body } = delivery();

    await accepted.service.handleDelivery(TOKEN, headers, body);
    await answerOf(
      refused.service.handleDelivery(
        TOKEN,
        { ...headers, source: 'https://attacker.example.net/' },
        body,
      ),
    );
    await answerOf(
      refused.service.handleDelivery(
        TOKEN,
        { ...headers, signature: sign(Buffer.from('other')) },
        body,
      ),
    );

    const lines = logged.join('\n');
    expect(lines).toContain('woocommerce-webhook-accept');
    for (const secret of [
      TOKEN,
      hashInstallToken(TOKEN),
      SECRET,
      String(headers.signature),
      sign(Buffer.from('other')),
      'attacker.example.net',
      '01000000000',
      'test.customer@example.com',
      'Test',
    ])
      expect(lines).not.toContain(secret);
  });
});
