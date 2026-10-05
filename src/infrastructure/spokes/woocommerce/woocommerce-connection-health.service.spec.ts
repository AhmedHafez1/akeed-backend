import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../../../shared/config/woocommerce.config';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import type {
  WooCommerceApiClient,
  WooCommerceCallFailure,
  WooCommerceWebhookRead,
} from './woocommerce-api.client';
import { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';
const STORE = 'https://example.com/private-shop';
const CONSUMER_KEY = 'ck_synthetic_consumer_key';
const CONSUMER_SECRET = 'cs_synthetic_consumer_secret';
const ENCRYPTION_KEY = 'a'.repeat(64);
const NOW = '2026-10-05T10:00:00.000Z';
const CREDENTIALS = {
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
};

function connection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: INTEGRATION,
    orgId: ORG,
    storeUrl: STORE,
    storeVerifiedAt: NOW,
    consumerKeyEncrypted: encryptToken(CONSUMER_KEY, ENCRYPTION_KEY),
    consumerSecretEncrypted: encryptToken(CONSUMER_SECRET, ENCRYPTION_KEY),
    webhookSecretEncrypted: encryptToken('whsec-synthetic', ENCRYPTION_KEY),
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

const found = (
  status: 'active' | 'paused' | 'disabled' | null,
): WooCommerceWebhookRead => ({ kind: 'found', status });
const missing: WooCommerceWebhookRead = { kind: 'missing' };
const failed = (reason: WooCommerceCallFailure) => ({
  kind: 'failed' as const,
  reason,
});

interface Setup {
  connection?: WooCommerceConnection | null;
  ingestionEnabled?: boolean;
}

function createService(setup: Setup = {}) {
  const bound =
    setup.connection === undefined ? connection() : setup.connection;
  const settings: WooCommerceConfig = {
    enabled: false,
    ingestionEnabled: setup.ingestionEnabled ?? true,
    outcomeSyncEnabled: false,
    pilotOrgIds: [],
    publicApiBaseUrl: '',
    appBaseUrl: '',
  };
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(bound ?? undefined),
    findByOrganization: jest.fn().mockResolvedValue(bound ?? undefined),
    setHealth: jest.fn().mockResolvedValue(undefined),
    recordWebhookStates: jest.fn().mockResolvedValue(undefined),
  };
  /** What the store answers for each webhook id, in order of asking. */
  const answers = new Map<number, WooCommerceWebhookRead[]>([
    [101, [found('active')]],
    [102, [found('active')]],
  ]);
  const api = {
    getWebhook: jest.fn(
      (_store: string, _keys: unknown, id: number): Promise<unknown> => {
        const queue = answers.get(id) ?? [];
        return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
      },
    ),
    enableWebhook: jest.fn().mockResolvedValue({ kind: 'ok' }),
    readSystemStatus: jest
      .fn()
      .mockResolvedValue({ kind: 'ok', homeUrl: STORE, version: '9.8.1' }),
  };
  const config = {
    get: (key: string) => (key === WOOCOMMERCE_CONFIG ? settings : undefined),
    getOrThrow: () => ENCRYPTION_KEY,
  };
  const service = new WooCommerceConnectionHealthService(
    connections as unknown as WooCommerceConnectionsRepository,
    api as unknown as WooCommerceApiClient,
    config as unknown as ConfigService,
  );
  return { service, connections, api, answers };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { status: 200 };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { code: string }).code,
    };
  }
}

describe('WooCommerceConnectionHealthService', () => {
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

  describe('inspectWebhooks', () => {
    it('reads both webhooks at the bound store with the connection’s own keys', async () => {
      const { service, connections, api } = createService();

      const health = await service.inspectWebhooks(INTEGRATION, ORG);

      expect(health?.items).toEqual([
        { kind: 'order_created', state: 'active' },
        { kind: 'order_updated', state: 'active' },
      ]);
      expect(typeof health?.checkedAt).toBe('string');
      expect(connections.findByIntegration).toHaveBeenCalledWith(
        INTEGRATION,
        ORG,
      );
      expect(
        api.getWebhook.mock.calls.map((call: unknown[]) => call.slice(0, 3)),
      ).toEqual([
        [STORE, CREDENTIALS, 101],
        [STORE, CREDENTIALS, 102],
      ]);
      // Bounded: every read carries the same budget.
      for (const call of api.getWebhook.mock.calls as unknown[][])
        expect(call[3]).toBeInstanceOf(AbortSignal);
    });

    it.each([
      ['disabled', found('disabled'), 'disabled'],
      ['paused', found('paused'), 'paused'],
      ['deleted at the store', missing, 'missing'],
    ] as const)(
      'reports a webhook that is %s and stores it as the last state read',
      async (_label, answer, state) => {
        const { service, connections, answers } = createService();
        answers.set(102, [answer]);

        const health = await service.inspectWebhooks(INTEGRATION, ORG);

        expect(health?.items).toEqual([
          { kind: 'order_created', state: 'active' },
          { kind: 'order_updated', state },
        ]);
        expect(connections.recordWebhookStates).toHaveBeenCalledWith(
          INTEGRATION,
          ORG,
          { orderCreated: 'active', orderUpdated: state },
          health?.checkedAt,
        );
      },
    );

    it('reports a state the store does not document as unknown and keeps the last one stored', async () => {
      const { service, connections, answers } = createService();
      answers.set(101, [found(null)]);

      const health = await service.inspectWebhooks(INTEGRATION, ORG);

      expect(health?.items[0]).toEqual({
        kind: 'order_created',
        state: 'unknown',
      });
      expect(connections.recordWebhookStates).toHaveBeenCalledWith(
        INTEGRATION,
        ORG,
        { orderCreated: undefined, orderUpdated: 'active' },
        expect.any(String),
      );
    });

    it.each([
      ['credentials_rejected', 'credentials_rejected'],
      ['permission_denied', 'permission_denied'],
    ] as const)(
      'records a %s answer as the connection health and the webhooks as unknown',
      async (reason, health) => {
        const { service, connections, answers } = createService();
        answers.set(101, [failed(reason)]);
        answers.set(102, [failed(reason)]);

        const read = await service.inspectWebhooks(INTEGRATION, ORG);

        expect(read?.items.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        expect(connections.setHealth).toHaveBeenCalledWith(
          INTEGRATION,
          ORG,
          health,
        );
      },
    );

    it.each([
      'unreachable',
      'tls_failed',
      'address_not_public',
      'redirects',
      'budget_exceeded',
    ] as const)(
      'says nothing about the keys when the store answers %s',
      async (reason) => {
        const { service, connections, answers } = createService({
          connection: connection({ health: 'credentials_rejected' }),
        });
        answers.set(101, [failed(reason)]);
        answers.set(102, [failed(reason)]);

        const read = await service.inspectWebhooks(INTEGRATION, ORG);

        expect(read?.items.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        expect(connections.setHealth).not.toHaveBeenCalled();
      },
    );

    it('clears a rejected health once the store answers with the keys again', async () => {
      const { service, connections } = createService({
        connection: connection({ health: 'credentials_rejected' }),
      });

      await service.inspectWebhooks(INTEGRATION, ORG);

      expect(connections.setHealth).toHaveBeenCalledWith(
        INTEGRATION,
        ORG,
        'ok',
      );
    });

    it('does not write the health when it has not changed', async () => {
      const { service, connections } = createService();

      await service.inspectWebhooks(INTEGRATION, ORG);

      expect(connections.setHealth).not.toHaveBeenCalled();
    });

    it.each([
      ['no connection', null],
      [
        'a disconnected one',
        connection({
          consumerKeyEncrypted: null,
          consumerSecretEncrypted: null,
          disconnectedAt: NOW,
        }),
      ],
    ])('asks nothing for %s', async (_label, bound) => {
      const { service, api } = createService({ connection: bound });

      await expect(
        service.inspectWebhooks(INTEGRATION, ORG),
      ).resolves.toBeNull();
      expect(api.getWebhook).not.toHaveBeenCalled();
    });

    it('never sends a stored value that is not a key', async () => {
      const { service, api } = createService({
        connection: connection({ consumerKeyEncrypted: 'v1:not-a-key' }),
      });

      const read = await service.inspectWebhooks(INTEGRATION, ORG);

      expect(read?.items.map((item) => item.state)).toEqual([
        'unknown',
        'unknown',
      ]);
      expect(api.getWebhook).not.toHaveBeenCalled();
    });
  });

  describe('check', () => {
    it('finds nothing wrong with a store that answers, accepts the keys and has both webhooks active', async () => {
      const { service, api, connections } = createService();

      const check = await service.check(ORG);

      expect(check.problems).toEqual([]);
      expect(check.webhooks).toEqual([
        { kind: 'order_created', state: 'active' },
        { kind: 'order_updated', state: 'active' },
      ]);
      expect(connections.findByOrganization).toHaveBeenCalledWith(ORG);
      expect(api.readSystemStatus).toHaveBeenCalledWith(
        STORE,
        CREDENTIALS,
        expect.any(AbortSignal),
      );
    });

    it.each([
      ['address_not_public', 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC'],
      ['redirects', 'WOOCOMMERCE_STORE_REDIRECTS'],
      ['tls_failed', 'WOOCOMMERCE_STORE_TLS_FAILED'],
      ['rest_not_found', 'WOOCOMMERCE_REST_NOT_FOUND'],
      ['unreachable', 'WOOCOMMERCE_REST_UNREACHABLE'],
      ['budget_exceeded', 'WOOCOMMERCE_PROVIDER_UNAVAILABLE'],
      ['credentials_rejected', 'WOOCOMMERCE_CREDENTIALS_REJECTED'],
      ['permission_denied', 'WOOCOMMERCE_PERMISSION_DENIED'],
    ] as const)(
      'tells a store that answers %s apart as %s, and asks for no webhook',
      async (reason, code) => {
        const { service, api } = createService();
        api.readSystemStatus.mockResolvedValue(failed(reason));

        const check = await service.check(ORG);

        expect(check.problems).toEqual([code]);
        expect(check.webhooks.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        expect(api.getWebhook).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['credentials_rejected', 'credentials_rejected'],
      ['permission_denied', 'permission_denied'],
    ] as const)(
      'records %s as the connection health',
      async (reason, health) => {
        const { service, api, connections } = createService();
        api.readSystemStatus.mockResolvedValue(failed(reason));

        await service.check(ORG);

        expect(connections.setHealth).toHaveBeenCalledWith(
          INTEGRATION,
          ORG,
          health,
        );
      },
    );

    it.each([
      [missing, 'WOOCOMMERCE_WEBHOOK_MISSING'],
      [found('disabled'), 'WOOCOMMERCE_WEBHOOK_DISABLED'],
      [found('paused'), 'WOOCOMMERCE_WEBHOOK_PAUSED'],
    ] as const)('names a webhook problem (%#)', async (answer, code) => {
      const { service, answers } = createService();
      answers.set(101, [answer]);

      await expect(service.check(ORG)).resolves.toMatchObject({
        problems: [code],
      });
    });

    it('lists one webhook problem once, and each kind it found', async () => {
      const { service, answers } = createService();
      answers.set(101, [found('disabled')]);
      answers.set(102, [missing]);

      const check = await service.check(ORG);

      expect(check.problems).toEqual([
        'WOOCOMMERCE_WEBHOOK_DISABLED',
        'WOOCOMMERCE_WEBHOOK_MISSING',
      ]);
    });

    it('says so when the store now calls itself by another address, without repeating that address', async () => {
      const { service, api } = createService();
      api.readSystemStatus.mockResolvedValue({
        kind: 'ok',
        homeUrl: 'https://reported-by-store.example.org',
        version: null,
      });

      const check = await service.check(ORG);

      expect(check.problems).toEqual(['WOOCOMMERCE_STORE_URL_MISMATCH']);
      expect(`${JSON.stringify(check)}${logged.join('\n')}`).not.toContain(
        'reported-by-store',
      );
    });

    it('treats stored keys it cannot read as rejected, without calling the store', async () => {
      const { service, api } = createService({
        connection: connection({ consumerSecretEncrypted: 'v1:not-a-key' }),
      });

      await expect(service.check(ORG)).resolves.toMatchObject({
        problems: ['WOOCOMMERCE_CREDENTIALS_REJECTED'],
      });
      expect(api.readSystemStatus).not.toHaveBeenCalled();
    });

    it.each([
      ['no connection', null],
      ['a disconnected one', connection({ disconnectedAt: NOW })],
    ])('answers not connected for %s', async (_label, bound) => {
      const { service, api } = createService({ connection: bound });

      await expect(codeOf(service.check(ORG))).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_NOT_CONNECTED',
      });
      expect(api.readSystemStatus).not.toHaveBeenCalled();
    });

    it('logs the host and the codes, never a key or the store path', async () => {
      const { service, answers } = createService();
      answers.set(101, [found('disabled')]);

      await service.check(ORG);

      const text = logged.join('\n');
      expect(text).toContain('example.com');
      expect(text).toContain('WOOCOMMERCE_WEBHOOK_DISABLED');
      for (const secret of [CONSUMER_KEY, CONSUMER_SECRET, 'private-shop'])
        expect(text).not.toContain(secret);
    });
  });

  describe('enableWebhooks', () => {
    it('re-enables the disabled webhook, reads it again and reports what the store shows', async () => {
      const { service, api, answers, connections } = createService();
      answers.set(102, [found('disabled'), found('active')]);

      const states = await service.enableWebhooks(ORG);

      expect(states).toEqual([
        { kind: 'order_created', state: 'active' },
        { kind: 'order_updated', state: 'active' },
      ]);
      expect(
        api.enableWebhook.mock.calls.map((call: unknown[]) => call.slice(0, 3)),
      ).toEqual([[STORE, CREDENTIALS, 102]]);
      // Read before the write and after it.
      expect(api.getWebhook).toHaveBeenCalledTimes(4);
      expect(connections.recordWebhookStates).toHaveBeenLastCalledWith(
        INTEGRATION,
        ORG,
        { orderCreated: 'active', orderUpdated: 'active' },
        expect.any(String),
      );
    });

    it('re-enables both when both are disabled', async () => {
      const { service, api, answers } = createService();
      answers.set(101, [found('disabled'), found('active')]);
      answers.set(102, [found('disabled'), found('active')]);

      await service.enableWebhooks(ORG);

      expect(
        api.enableWebhook.mock.calls.map((call: unknown[]) => call[2]),
      ).toEqual([101, 102]);
    });

    it('writes nothing when no webhook is disabled', async () => {
      const { service, api } = createService();

      await expect(service.enableWebhooks(ORG)).resolves.toHaveLength(2);
      expect(api.enableWebhook).not.toHaveBeenCalled();
    });

    it('leaves a webhook the merchant paused as it is', async () => {
      const { service, api, answers } = createService();
      answers.set(101, [found('paused')]);

      const states = await service.enableWebhooks(ORG);

      expect(states[0]).toEqual({ kind: 'order_created', state: 'paused' });
      expect(api.enableWebhook).not.toHaveBeenCalled();
    });

    it('refuses while ingestion is off, before reading or calling anything', async () => {
      const { service, api, connections } = createService({
        ingestionEnabled: false,
      });

      await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
        status: 503,
        code: 'WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE',
      });
      expect(connections.findByOrganization).not.toHaveBeenCalled();
      expect(api.getWebhook).not.toHaveBeenCalled();
    });

    it('refuses when a webhook was deleted at the store, and changes the other one not at all', async () => {
      const { service, api, answers } = createService();
      answers.set(101, [missing]);
      answers.set(102, [found('disabled')]);

      await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
        status: 409,
        code: 'WOOCOMMERCE_WEBHOOK_MISSING',
      });
      expect(api.enableWebhook).not.toHaveBeenCalled();
    });

    it.each([
      ['credentials_rejected', 422, 'WOOCOMMERCE_CREDENTIALS_REJECTED'],
      ['permission_denied', 422, 'WOOCOMMERCE_PERMISSION_DENIED'],
      ['tls_failed', 422, 'WOOCOMMERCE_STORE_TLS_FAILED'],
      ['unreachable', 503, 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED'],
    ] as const)(
      'refuses with its own code when the store cannot be read (%s)',
      async (reason, status, code) => {
        const { service, api, answers } = createService();
        answers.set(101, [failed(reason)]);
        answers.set(102, [failed(reason)]);

        await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
          status,
          code,
        });
        expect(api.enableWebhook).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['unreachable', 503, 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED'],
      ['permission_denied', 422, 'WOOCOMMERCE_PERMISSION_DENIED'],
    ] as const)(
      'refuses when the store does not take the change (%s)',
      async (reason, status, code) => {
        const { service, api, answers } = createService();
        answers.set(102, [found('disabled')]);
        api.enableWebhook.mockResolvedValue(failed(reason));

        await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
          status,
          code,
        });
      },
    );

    it('does not report success for a webhook the store still shows as disabled', async () => {
      const { service, answers } = createService();
      // The store answered 2xx to the change and did not make it.
      answers.set(102, [found('disabled')]);

      await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
        status: 503,
        code: 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED',
      });
    });

    it.each([
      ['no connection', null],
      ['a disconnected one', connection({ disconnectedAt: NOW })],
    ])('answers not connected for %s', async (_label, bound) => {
      const { service, api } = createService({ connection: bound });

      await expect(codeOf(service.enableWebhooks(ORG))).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_NOT_CONNECTED',
      });
      expect(api.getWebhook).not.toHaveBeenCalled();
    });
  });
});
