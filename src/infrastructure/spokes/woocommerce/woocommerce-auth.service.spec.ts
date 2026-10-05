import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
  WooCommercePendingInstall,
} from '../../database/repositories/woocommerce-connections.repository';
import type { AuthenticatedUser } from '../../../modules/auth/guards/dual-auth.guard';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../../../shared/config/woocommerce.config';
import {
  decryptToken,
  encryptToken,
} from '../../../shared/utils/token-encryption.util';
import type {
  WooCommerceApiClient,
  WooCommerceCallFailure,
} from './woocommerce-api.client';
import {
  parseInstallCallbackBody,
  WOOCOMMERCE_INSTALL_TTL_MS,
  WOOCOMMERCE_WEBHOOK_LIST_MAX_PAGES,
  WooCommerceAuthService,
} from './woocommerce-auth.service';
import type { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';
import { hashInstallToken } from './woocommerce-install-token';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const STORE = 'https://example.com/private-shop';
const REFERENCE = '482910573629104';
const CALLBACK_TOKEN = 'c'.repeat(43);
const CONSUMER_KEY = 'ck_synthetic_consumer_key';
const CONSUMER_SECRET = 'cs_synthetic_consumer_secret';
const ENCRYPTION_KEY = 'a'.repeat(64);
const REPORTED_HOME = 'https://reported-by-store.example.org';

const owner: AuthenticatedUser = {
  userId: USER,
  orgId: ORG,
  role: 'owner',
  source: 'supabase',
};

const body = (overrides: Record<string, unknown> = {}) => ({
  key_id: 1,
  user_id: REFERENCE,
  consumer_key: CONSUMER_KEY,
  consumer_secret: CONSUMER_SECRET,
  key_permissions: 'read_write',
  ...overrides,
});

function pendingInstall(
  overrides: Partial<WooCommercePendingInstall> = {},
): WooCommercePendingInstall {
  return {
    id: 'pending-1',
    orgId: ORG,
    createdBy: USER,
    storeUrl: STORE,
    callbackTokenHash: hashInstallToken(CALLBACK_TOKEN),
    installReference: REFERENCE,
    webhookTokenHash: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumedAt: null,
    supersededAt: null,
    claimedUntil: null,
    attempts: 0,
    lastErrorCode: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const INTEGRATION = '44444444-4444-4444-8444-444444444444';
const CONNECTED_AT = '2026-10-04T10:00:00.000Z';
const DISCONNECTED_AT = '2026-10-05T09:00:00.000Z';

function storedConnection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: INTEGRATION,
    orgId: ORG,
    storeUrl: STORE,
    storeVerifiedAt: CONNECTED_AT,
    consumerKeyEncrypted: encryptToken(CONSUMER_KEY, ENCRYPTION_KEY),
    consumerSecretEncrypted: encryptToken(CONSUMER_SECRET, ENCRYPTION_KEY),
    webhookSecretEncrypted: encryptToken('whsec-synthetic', ENCRYPTION_KEY),
    webhookTokenHash: 'h'.repeat(64),
    orderCreatedWebhookId: 101,
    orderUpdatedWebhookId: 102,
    orderCreatedWebhookState: 'active',
    orderUpdatedWebhookState: 'active',
    webhooksCheckedAt: CONNECTED_AT,
    wooVersion: '9.8.1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: USER,
    connectedAt: CONNECTED_AT,
    disconnectedAt: null,
    disconnectedBy: null,
    createdAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
    ...overrides,
  };
}

/** The row as a disconnect leaves it: the store URL and nothing to use it with. */
function disconnectedConnection(): WooCommerceConnection {
  return storedConnection({
    storeVerifiedAt: null,
    consumerKeyEncrypted: null,
    consumerSecretEncrypted: null,
    webhookSecretEncrypted: null,
    webhookTokenHash: null,
    orderCreatedWebhookId: null,
    orderUpdatedWebhookId: null,
    orderCreatedWebhookState: null,
    orderUpdatedWebhookState: null,
    disconnectedAt: DISCONNECTED_AT,
    disconnectedBy: USER,
  });
}

const failed = (reason: WooCommerceCallFailure) => ({
  kind: 'failed' as const,
  reason,
});

function createService(settingsOverrides: Partial<WooCommerceConfig> = {}) {
  const settings: WooCommerceConfig = {
    enabled: true,
    ingestionEnabled: false,
    outcomeSyncEnabled: false,
    pilotOrgIds: [ORG],
    publicApiBaseUrl: 'https://api.akeed.test',
    appBaseUrl: 'https://app.akeed.test',
    ...settingsOverrides,
  };
  const calls: string[] = [];
  // Typed loosely on purpose: each test swaps in the answer it is about.
  const track = (name: string, result: unknown) => (): Promise<unknown> => {
    calls.push(name);
    return Promise.resolve(result);
  };
  let nextWebhookId = 500;
  const connections = {
    getOverview: jest.fn().mockResolvedValue({
      organizationName: 'Noor',
      sourcePlatforms: [],
      connection: undefined,
      latestPending: undefined,
    }),
    readSourceSlot: jest.fn().mockResolvedValue({ kind: 'fresh' }),
    disconnect: jest.fn(),
    createPendingInstall: jest.fn((input: { expiresAt: string }) =>
      Promise.resolve({
        kind: 'created',
        pending: pendingInstall({ expiresAt: input.expiresAt }),
      }),
    ),
    findPendingByCallbackTokenHash: jest
      .fn()
      .mockResolvedValue(pendingInstall()),
    findPendingById: jest.fn().mockResolvedValue(pendingInstall()),
    claimPendingInstall: jest.fn(track('claim', true)),
    releasePendingInstall: jest.fn(track('release', undefined)),
    recordFailedAttempt: jest.fn(track('record-attempt', undefined)),
    setPendingWebhookTokenHash: jest.fn(track('store-token-hash', undefined)),
    isStoreVerifiedForAnotherOrganization: jest.fn(
      track('store-slot-check', false),
    ),
    connect: jest.fn(
      track('connect', {
        kind: 'connected',
        orgId: ORG,
        integrationId: 'integration-1',
        reconnected: false,
      }),
    ),
  };
  const outcomeSyncs = {
    failPendingForIntegration: jest.fn().mockResolvedValue(0),
  };
  const health = {
    check: jest.fn(),
    enableWebhooks: jest.fn().mockResolvedValue([]),
  };
  const api = {
    probeRestApi: jest.fn(track('probe', { kind: 'ok' })),
    readSystemStatus: jest.fn(
      track('system-status', { kind: 'ok', homeUrl: STORE, version: '9.8.1' }),
    ),
    listWebhooks: jest.fn(
      track('list', { kind: 'ok', webhooks: [], totalPages: 1 }),
    ),
    createWebhook: jest.fn((): Promise<unknown> => {
      calls.push('create');
      return Promise.resolve({ kind: 'ok', id: nextWebhookId++ });
    }),
    deleteWebhook: jest.fn(track('delete', { kind: 'ok' })),
  };
  const config = {
    get: (key: string) => (key === WOOCOMMERCE_CONFIG ? settings : undefined),
    getOrThrow: () => ENCRYPTION_KEY,
  };
  const service = new WooCommerceAuthService(
    connections as unknown as WooCommerceConnectionsRepository,
    api as unknown as WooCommerceApiClient,
    config as unknown as ConfigService,
    outcomeSyncs as unknown as CommerceOutcomeSyncsRepository,
    health as unknown as WooCommerceConnectionHealthService,
  );
  return {
    service,
    connections,
    api,
    calls,
    settings,
    outcomeSyncs,
    health,
  };
}

async function answerOf(promise: Promise<unknown>) {
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

describe('WooCommerceAuthService', () => {
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

  describe('startInstall', () => {
    it('binds a 15-minute context to the caller and the canonical store, storing only a hash of the token', async () => {
      const { service, connections } = createService();
      const before = Date.now();

      const started = await service.startInstall(owner, {
        storeUrl: ' HTTPS://Example.com/private-shop/ ',
        locale: 'ar',
      });

      const params = new URL(started.authorizeUrl).searchParams;
      const token = params.get('callback_url')!.split('/').pop()!;
      const [stored] = connections.createPendingInstall.mock.calls[0] as [
        Record<string, string>,
      ];
      expect(stored).toEqual({
        orgId: ORG,
        createdBy: USER,
        storeUrl: STORE,
        callbackTokenHash: hashInstallToken(token),
        installReference: params.get('user_id'),
        expiresAt: started.expiresAt,
      });
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(started.storeUrl).toBe(STORE);
      const ttl = new Date(started.expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(WOOCOMMERCE_INSTALL_TTL_MS);
      expect(ttl).toBeLessThan(WOOCOMMERCE_INSTALL_TTL_MS + 5_000);
    });

    it.each([
      ['http://example.com', 'WOOCOMMERCE_STORE_HTTPS_REQUIRED'],
      ['https://10.0.0.1', 'WOOCOMMERCE_STORE_URL_INVALID'],
    ])(
      'refuses %s before reading anything or calling anywhere',
      async (storeUrl, code) => {
        const { service, connections, api } = createService();

        await expect(
          answerOf(service.startInstall(owner, { storeUrl, locale: 'ar' })),
        ).resolves.toEqual({ status: 400, code });
        expect(connections.readSourceSlot).not.toHaveBeenCalled();
        expect(api.probeRestApi).not.toHaveBeenCalled();
      },
    );

    it('does not call the store for an organization that already has a source', async () => {
      const { service, connections, api } = createService();
      connections.readSourceSlot.mockResolvedValue({ kind: 'taken' });

      await expect(
        answerOf(
          service.startInstall(owner, { storeUrl: STORE, locale: 'ar' }),
        ),
      ).resolves.toEqual({ status: 409, code: 'WOOCOMMERCE_SOURCE_EXISTS' });
      expect(api.probeRestApi).not.toHaveBeenCalled();
      expect(connections.createPendingInstall).not.toHaveBeenCalled();
    });

    it.each([
      ['address_not_public', 422, 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC'],
      ['redirects', 422, 'WOOCOMMERCE_STORE_REDIRECTS'],
      ['tls_failed', 422, 'WOOCOMMERCE_STORE_TLS_FAILED'],
      ['rest_not_found', 422, 'WOOCOMMERCE_REST_NOT_FOUND'],
      ['unreachable', 503, 'WOOCOMMERCE_REST_UNREACHABLE'],
    ] as const)(
      'refuses a store whose probe fails with %s, creating no context',
      async (reason, status, code) => {
        const { service, connections, api } = createService();
        api.probeRestApi.mockResolvedValue(failed(reason));

        await expect(
          answerOf(
            service.startInstall(owner, { storeUrl: STORE, locale: 'ar' }),
          ),
        ).resolves.toEqual({ status, code });
        expect(connections.createPendingInstall).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        { ...owner, role: 'viewer' as const },
        {},
        403,
        'WOOCOMMERCE_ROLE_REQUIRED',
      ],
      [
        { ...owner, source: 'shopify' as const },
        {},
        403,
        'WOOCOMMERCE_SESSION_REQUIRED',
      ],
      [owner, { enabled: false }, 404, 'WOOCOMMERCE_CONNECT_UNAVAILABLE'],
      [owner, { pilotOrgIds: [] }, 403, 'WOOCOMMERCE_PILOT_REQUIRED'],
    ])(
      'refuses who may not connect (%#)',
      async (user, settings, status, code) => {
        const { service, connections, api } = createService(settings);

        await expect(
          answerOf(
            service.startInstall(user, { storeUrl: STORE, locale: 'ar' }),
          ),
        ).resolves.toEqual({ status, code });
        expect(connections.readSourceSlot).not.toHaveBeenCalled();
        expect(api.probeRestApi).not.toHaveBeenCalled();
      },
    );

    describe('reconnect', () => {
      it('opens a context for the store that was connected, after probing it', async () => {
        const { service, connections, api } = createService();
        connections.readSourceSlot.mockResolvedValue({
          kind: 'reconnect',
          connection: disconnectedConnection(),
        });

        const started = await service.startInstall(owner, {
          storeUrl: `${STORE}/`,
          locale: 'en',
        });

        expect(started.storeUrl).toBe(STORE);
        expect(api.probeRestApi).toHaveBeenCalledWith(STORE);
        expect(connections.createPendingInstall).toHaveBeenCalledTimes(1);
      });

      it.each([
        'https://other.example.com',
        'https://www.example.com/private-shop',
      ])(
        'refuses %s without calling it: only the same canonical store',
        async (storeUrl) => {
          const { service, connections, api } = createService();
          connections.readSourceSlot.mockResolvedValue({
            kind: 'reconnect',
            connection: disconnectedConnection(),
          });

          await expect(
            answerOf(service.startInstall(owner, { storeUrl, locale: 'ar' })),
          ).resolves.toEqual({
            status: 409,
            code: 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH',
          });
          expect(api.probeRestApi).not.toHaveBeenCalled();
          expect(connections.createPendingInstall).not.toHaveBeenCalled();
        },
      );

      it('refuses when the store changed between the read and the transaction', async () => {
        const { service, connections } = createService();
        connections.createPendingInstall.mockResolvedValue({
          kind: 'store_mismatch',
        } as never);

        await expect(
          answerOf(
            service.startInstall(owner, { storeUrl: STORE, locale: 'ar' }),
          ),
        ).resolves.toEqual({
          status: 409,
          code: 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH',
        });
      });
    });
  });

  describe('handleCallback', () => {
    it('claims the install, checks the store slot and proves the keys before it touches a webhook, and stores last', async () => {
      const { service, calls } = createService();

      await expect(
        answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
      ).resolves.toEqual({ status: 200 });

      expect(calls).toEqual([
        'claim',
        'store-slot-check',
        'system-status',
        // The token's hash is known before the store can ping its address.
        'store-token-hash',
        'list',
        'create',
        'create',
        'connect',
      ]);
    });

    it('proves the keys against the store of the context and stores only ciphertext and hashes', async () => {
      const { service, connections, api } = createService();

      await service.handleCallback(CALLBACK_TOKEN, body());

      const credentials = {
        consumerKey: CONSUMER_KEY,
        consumerSecret: CONSUMER_SECRET,
      };
      expect(api.readSystemStatus).toHaveBeenCalledWith(
        STORE,
        credentials,
        expect.any(AbortSignal),
      );
      const created = api.createWebhook.mock.calls as unknown as [
        string,
        unknown,
        { name: string; topic: string; deliveryUrl: string; secret: string },
        AbortSignal,
      ][];
      expect(created.map(([, , webhook]) => webhook.topic)).toEqual([
        'order.created',
        'order.updated',
      ]);
      const [[, , first], [, , second]] = created;
      expect(first.deliveryUrl).toMatch(
        /^https:\/\/api\.akeed\.test\/api\/woocommerce\/webhooks\/[A-Za-z0-9_-]{43}$/,
      );
      expect(second.deliveryUrl).toBe(first.deliveryUrl);
      expect(second.secret).toBe(first.secret);
      const webhookToken = first.deliveryUrl.split('/').pop()!;
      expect(webhookToken).not.toBe(CALLBACK_TOKEN);

      expect(connections.setPendingWebhookTokenHash).toHaveBeenCalledWith(
        'pending-1',
        hashInstallToken(webhookToken),
      );
      const [stored] = connections.connect.mock.calls[0] as unknown as [
        Record<string, string | number>,
      ];
      expect(stored).toMatchObject({
        pendingInstallId: 'pending-1',
        webhookTokenHash: hashInstallToken(webhookToken),
        orderCreatedWebhookId: 500,
        orderUpdatedWebhookId: 501,
        wooVersion: '9.8.1',
      });
      const text = JSON.stringify(stored);
      for (const secret of [
        CONSUMER_KEY,
        CONSUMER_SECRET,
        first.secret,
        webhookToken,
      ])
        expect(text).not.toContain(secret);
      expect(
        decryptToken(String(stored.consumerKeyEncrypted), ENCRYPTION_KEY),
      ).toBe(CONSUMER_KEY);
      expect(
        decryptToken(String(stored.consumerSecretEncrypted), ENCRYPTION_KEY),
      ).toBe(CONSUMER_SECRET);
      expect(
        decryptToken(String(stored.webhookSecretEncrypted), ENCRYPTION_KEY),
      ).toBe(first.secret);
    });

    it('never writes a key, a token, the store path or what the store reported into a log line', async () => {
      const { service, api } = createService();
      await service.handleCallback(CALLBACK_TOKEN, body());
      const tokens = (
        api.createWebhook.mock.calls as unknown as [
          string,
          unknown,
          { deliveryUrl: string; secret: string },
        ][]
      ).flatMap(([, , webhook]) => [
        webhook.secret,
        webhook.deliveryUrl.split('/').pop()!,
      ]);

      // And a refused one, which logs on a different path.
      const refusing = createService();
      refusing.api.readSystemStatus.mockResolvedValue({
        kind: 'ok',
        homeUrl: REPORTED_HOME,
        version: null,
      });
      await answerOf(refusing.service.handleCallback(CALLBACK_TOKEN, body()));

      const text = logged.join('\n');
      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(text).toContain('example.com');
      for (const secret of [
        CALLBACK_TOKEN,
        CONSUMER_KEY,
        CONSUMER_SECRET,
        'private-shop',
        'reported-by-store',
        REFERENCE,
        ...tokens,
      ])
        expect(text).not.toContain(secret);
    });

    it.each([
      ['a malformed token', 'not-a-token', {}],
      ['an unknown token', CALLBACK_TOKEN, { pending: undefined }],
      [
        'a used context',
        CALLBACK_TOKEN,
        { pending: { consumedAt: new Date().toISOString() } },
      ],
      [
        'a replaced context',
        CALLBACK_TOKEN,
        { pending: { supersededAt: new Date().toISOString() } },
      ],
      [
        'an expired context',
        CALLBACK_TOKEN,
        { pending: { expiresAt: new Date(Date.now() - 1).toISOString() } },
      ],
      ['an exhausted context', CALLBACK_TOKEN, { pending: { attempts: 5 } }],
      [
        'an organization off the list',
        CALLBACK_TOKEN,
        { pending: { orgId: '33333333-3333-4333-8333-333333333333' } },
      ],
      ['a context another callback holds', CALLBACK_TOKEN, { claimed: false }],
    ] as const)(
      'answers %s the same way, counting nothing and calling nothing',
      async (_label, token, setup) => {
        const { service, connections, api } = createService();
        if ('pending' in setup)
          connections.findPendingByCallbackTokenHash.mockResolvedValue(
            setup.pending ? pendingInstall(setup.pending) : undefined,
          );
        if ('claimed' in setup)
          connections.claimPendingInstall.mockResolvedValue(setup.claimed);

        await expect(
          answerOf(service.handleCallback(token, body())),
        ).resolves.toEqual({
          status: 401,
          code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
        });
        expect(connections.recordFailedAttempt).not.toHaveBeenCalled();
        expect(api.readSystemStatus).not.toHaveBeenCalled();
        expect(connections.connect).not.toHaveBeenCalled();
      },
    );

    it('answers 404 while the switch is off, before reading the context', async () => {
      const { service, connections } = createService({ enabled: false });

      await expect(
        answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
      ).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_CONNECT_UNAVAILABLE',
      });
      expect(connections.findPendingByCallbackTokenHash).not.toHaveBeenCalled();
    });

    it.each([
      ['credentials_rejected', 422, 'WOOCOMMERCE_CREDENTIALS_REJECTED'],
      ['permission_denied', 422, 'WOOCOMMERCE_PERMISSION_DENIED'],
      ['rest_not_found', 422, 'WOOCOMMERCE_REST_NOT_FOUND'],
      ['address_not_public', 422, 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC'],
      ['redirects', 422, 'WOOCOMMERCE_STORE_REDIRECTS'],
      ['tls_failed', 422, 'WOOCOMMERCE_STORE_TLS_FAILED'],
      ['unreachable', 503, 'WOOCOMMERCE_REST_UNREACHABLE'],
      ['budget_exceeded', 503, 'WOOCOMMERCE_PROVIDER_UNAVAILABLE'],
    ] as const)(
      'refuses when the key proof fails with %s, counts the attempt and touches no webhook',
      async (reason, status, code) => {
        const { service, connections, api } = createService();
        api.readSystemStatus.mockResolvedValue(failed(reason));

        await expect(
          answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
        ).resolves.toEqual({ status, code });
        expect(connections.recordFailedAttempt).toHaveBeenCalledWith(
          'pending-1',
          code,
        );
        expect(api.listWebhooks).not.toHaveBeenCalled();
        expect(connections.connect).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['credentials_rejected', 422, 'WOOCOMMERCE_CREDENTIALS_REJECTED'],
      ['permission_denied', 422, 'WOOCOMMERCE_PERMISSION_DENIED'],
      ['rest_not_found', 503, 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED'],
      ['unreachable', 503, 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED'],
      ['budget_exceeded', 503, 'WOOCOMMERCE_PROVIDER_UNAVAILABLE'],
    ] as const)(
      'refuses when the second webhook fails with %s and removes the first',
      async (reason, status, code) => {
        const { service, connections, api } = createService();
        api.createWebhook
          .mockResolvedValueOnce({ kind: 'ok', id: 900 })
          .mockResolvedValueOnce(failed(reason));

        await expect(
          answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
        ).resolves.toEqual({ status, code });
        expect(api.deleteWebhook).toHaveBeenCalledTimes(1);
        // Without the budget: it may be the budget that ran out.
        expect(api.deleteWebhook).toHaveBeenCalledWith(
          STORE,
          expect.anything(),
          900,
        );
        expect(connections.connect).not.toHaveBeenCalled();
      },
    );

    it('does not delete at the store once a newer install has retired this one', async () => {
      const { service, connections, api } = createService();
      connections.findPendingById.mockResolvedValue(
        pendingInstall({ supersededAt: new Date().toISOString() }),
      );

      await expect(
        answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
      ).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
      expect(api.listWebhooks).not.toHaveBeenCalled();
      expect(connections.recordFailedAttempt).not.toHaveBeenCalled();
      expect(connections.releasePendingInstall).toHaveBeenCalledWith(
        'pending-1',
      );
    });

    it('gives up after ten pages of webhooks instead of leaving one unread', async () => {
      const { service, api } = createService();
      api.listWebhooks.mockResolvedValue({
        kind: 'ok',
        webhooks: [],
        totalPages: 99,
      });

      await expect(
        answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
      ).resolves.toEqual({
        status: 503,
        code: 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED',
      });
      expect(api.listWebhooks).toHaveBeenCalledTimes(
        WOOCOMMERCE_WEBHOOK_LIST_MAX_PAGES,
      );
      expect(api.createWebhook).not.toHaveBeenCalled();
    });

    it.each([
      ['context_invalid', 401, 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID', false],
      ['source_exists', 409, 'WOOCOMMERCE_SOURCE_EXISTS', true],
      ['store_unavailable', 409, 'WOOCOMMERCE_STORE_UNAVAILABLE', true],
      ['store_mismatch', 409, 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH', true],
    ] as const)(
      'removes its two webhooks when the final transaction answers %s',
      async (kind, status, code, counted) => {
        const { service, connections, api } = createService();
        connections.connect.mockResolvedValue({ kind, orgId: ORG });

        await expect(
          answerOf(service.handleCallback(CALLBACK_TOKEN, body())),
        ).resolves.toEqual({ status, code });
        expect(
          api.deleteWebhook.mock.calls.map((call: unknown[]) => call[2]),
        ).toEqual([500, 501]);
        expect(connections.recordFailedAttempt).toHaveBeenCalledTimes(
          counted ? 1 : 0,
        );
        expect(connections.releasePendingInstall).toHaveBeenCalledTimes(
          counted ? 0 : 1,
        );
      },
    );

    it('removes its webhooks and frees the link when the final transaction faults', async () => {
      const { service, connections, api } = createService();
      connections.connect.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.handleCallback(CALLBACK_TOKEN, body()),
      ).rejects.toThrow('connection lost');
      expect(
        api.deleteWebhook.mock.calls.map((call: unknown[]) => call[2]),
      ).toEqual([500, 501]);
      expect(connections.releasePendingInstall).toHaveBeenCalledWith(
        'pending-1',
      );
      expect(connections.recordFailedAttempt).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    const overview = (
      latestPending: WooCommercePendingInstall | undefined,
      sourcePlatforms: string[] = [],
    ) => ({
      organizationName: 'Noor',
      sourcePlatforms,
      connection: undefined,
      latestPending,
    });

    it.each([
      ['nothing started', overview(undefined), {}, 'ready', null],
      ['an open context', overview(pendingInstall()), {}, 'pending', STORE],
      [
        'a refused callback',
        overview(
          pendingInstall({
            lastErrorCode: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
            attempts: 1,
          }),
        ),
        {},
        'failed',
        STORE,
      ],
      [
        'an expired context',
        overview(
          pendingInstall({ expiresAt: new Date(Date.now() - 1).toISOString() }),
        ),
        {},
        'expired',
        STORE,
      ],
      [
        'a replaced context',
        overview(pendingInstall({ supersededAt: new Date().toISOString() })),
        {},
        'ready',
        null,
      ],
      [
        'another source',
        overview(undefined, ['shopify']),
        {},
        'source_exists',
        null,
      ],
      [
        'the switch off',
        overview(pendingInstall()),
        { enabled: false },
        'unavailable',
        null,
      ],
      [
        'not on the list',
        overview(pendingInstall()),
        { pilotOrgIds: [] },
        'pilot_required',
        null,
      ],
    ] as const)(
      'reports %s',
      async (_label, read, settings, state, storeUrl) => {
        const { service, connections } = createService(settings);
        connections.getOverview.mockResolvedValue(read);

        const status = await service.getStatus(owner);

        expect(status).toMatchObject({ state, storeUrl, connection: null });
        expect(JSON.stringify(status)).not.toContain(REFERENCE);
      },
    );

    it('lets a viewer read and not manage', async () => {
      const { service } = createService();

      await expect(
        service.getStatus({ ...owner, role: 'viewer' }),
      ).resolves.toMatchObject({ state: 'ready', canManage: false });
    });

    it('describes a connection with the last webhook states read, and no credential', async () => {
      const { service, connections } = createService();
      connections.getOverview.mockResolvedValue({
        ...overview(undefined, ['woocommerce']),
        connection: storedConnection({
          health: 'permission_denied',
          rejectedDeliveries: 3,
          orderUpdatedWebhookState: 'disabled',
        }),
      });

      const status = await service.getStatus(owner);

      expect(status).toMatchObject({
        state: 'connected',
        storeUrl: STORE,
        connection: {
          storeUrl: STORE,
          health: 'permission_denied',
          rejectedDeliveries: 3,
          webhooks: [
            { kind: 'order_created', state: 'active' },
            { kind: 'order_updated', state: 'disabled' },
          ],
          webhooksCheckedAt: CONNECTED_AT,
          disconnectedAt: null,
        },
      });
      expect(JSON.stringify(status)).not.toMatch(/v1:|ck_|cs_|whsec|h{64}/);
    });

    it('reports a webhook nobody has read yet as unknown', async () => {
      const { service, connections } = createService();
      connections.getOverview.mockResolvedValue({
        ...overview(undefined, ['woocommerce']),
        connection: storedConnection({
          orderCreatedWebhookState: null,
          orderUpdatedWebhookState: null,
          webhooksCheckedAt: null,
        }),
      });

      expect((await service.getStatus(owner)).connection?.webhooks).toEqual([
        { kind: 'order_created', state: 'unknown' },
        { kind: 'order_updated', state: 'unknown' },
      ]);
    });

    it.each([
      ['with the switch on', {}],
      ['with the switch off', { enabled: false }],
      ['off the pilot list', { pilotOrgIds: [] }],
    ])('shows a disconnected source %s', async (_label, settings) => {
      const { service, connections } = createService(settings);
      connections.getOverview.mockResolvedValue({
        ...overview(pendingInstall({ supersededAt: DISCONNECTED_AT }), [
          'woocommerce',
        ]),
        connection: disconnectedConnection(),
      });

      await expect(service.getStatus(owner)).resolves.toMatchObject({
        state: 'disconnected',
        storeUrl: STORE,
        connection: {
          storeUrl: STORE,
          webhooks: [],
          disconnectedAt: DISCONNECTED_AT,
        },
      });
    });

    it.each([
      [pendingInstall(), 'pending', null],
      [
        pendingInstall({
          lastErrorCode: 'WOOCOMMERCE_STORE_UNAVAILABLE',
          attempts: 1,
        }),
        'failed',
        'WOOCOMMERCE_STORE_UNAVAILABLE',
      ],
      [
        pendingInstall({ expiresAt: new Date(Date.now() - 1).toISOString() }),
        'expired',
        null,
      ],
    ] as const)(
      'shows a reconnect under way with the connection still described (%#)',
      async (latestPending, state, lastErrorCode) => {
        const { service, connections } = createService();
        connections.getOverview.mockResolvedValue({
          ...overview(latestPending, ['woocommerce']),
          connection: disconnectedConnection(),
        });

        await expect(service.getStatus(owner)).resolves.toMatchObject({
          state,
          lastErrorCode,
          storeUrl: STORE,
          connection: { disconnectedAt: DISCONNECTED_AT },
        });
      },
    );
  });

  describe('disconnect', () => {
    function disconnecting() {
      const setup = createService({ enabled: false, pilotOrgIds: [] });
      const previous = storedConnection();
      setup.connections.disconnect.mockResolvedValue({
        kind: 'disconnected',
        integrationId: INTEGRATION,
        previous,
      });
      setup.connections.getOverview.mockResolvedValue({
        organizationName: 'Noor',
        sourcePlatforms: ['woocommerce'],
        connection: disconnectedConnection(),
        latestPending: undefined,
      });
      return setup;
    }

    it('stops the source first, closes waiting store updates, then deletes both webhooks at the bound store with the keys it read', async () => {
      const { service, connections, api, outcomeSyncs, calls } =
        disconnecting();
      connections.disconnect.mockImplementation(() => {
        calls.push('disconnect');
        return Promise.resolve({
          kind: 'disconnected',
          integrationId: INTEGRATION,
          previous: storedConnection(),
        });
      });
      outcomeSyncs.failPendingForIntegration.mockImplementation(() => {
        calls.push('close-syncs');
        return Promise.resolve(0);
      });

      const result = await service.disconnect(owner);

      // Not gated: the switch is off and the organization is off the list.
      expect(result).toMatchObject({
        state: 'disconnected',
        webhookCleanup: 'removed',
      });
      // The local half is finished before Akeed waits on the store.
      expect(calls).toEqual(['disconnect', 'close-syncs', 'delete', 'delete']);
      expect(connections.disconnect).toHaveBeenCalledWith(ORG, USER);
      expect(
        api.deleteWebhook.mock.calls.map((call: unknown[]) => call.slice(0, 3)),
      ).toEqual([
        [
          STORE,
          { consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
          101,
        ],
        [
          STORE,
          { consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
          102,
        ],
      ]);
      expect(outcomeSyncs.failPendingForIntegration).toHaveBeenCalledWith(
        ORG,
        INTEGRATION,
        'integration_inactive',
      );
    });

    it.each(['unreachable', 'credentials_rejected', 'tls_failed'] as const)(
      'still disconnects when the store answers %s, and says the webhooks are left',
      async (reason) => {
        const { service, api, outcomeSyncs } = disconnecting();
        api.deleteWebhook.mockResolvedValue(failed(reason));

        await expect(service.disconnect(owner)).resolves.toMatchObject({
          state: 'disconnected',
          webhookCleanup: 'failed',
        });
        expect(outcomeSyncs.failPendingForIntegration).toHaveBeenCalled();
      },
    );

    it('reports the cleanup as failed, without a store call, when the stored keys cannot be read', async () => {
      const { service, connections, api } = disconnecting();
      connections.disconnect.mockResolvedValue({
        kind: 'disconnected',
        integrationId: INTEGRATION,
        previous: storedConnection({ consumerKeyEncrypted: 'v1:not-a-key' }),
      });

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        webhookCleanup: 'failed',
      });
      expect(api.deleteWebhook).not.toHaveBeenCalled();
    });

    it('still answers disconnected when the cleanup throws or the waiting updates cannot be closed', async () => {
      const { service, api, outcomeSyncs } = disconnecting();
      api.deleteWebhook.mockRejectedValue(new Error('socket'));
      outcomeSyncs.failPendingForIntegration.mockRejectedValue(
        new Error('database'),
      );

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        state: 'disconnected',
        webhookCleanup: 'failed',
      });
    });

    it('calls no store on a second disconnect, and closes a store update the first one left waiting', async () => {
      const { service, connections, api, outcomeSyncs } = disconnecting();
      connections.disconnect.mockResolvedValue({
        kind: 'already_disconnected',
        integrationId: INTEGRATION,
      });

      await expect(service.disconnect(owner)).resolves.toMatchObject({
        state: 'disconnected',
        webhookCleanup: 'not_attempted',
      });
      expect(api.deleteWebhook).not.toHaveBeenCalled();
      // The first request may have died while it waited on the store.
      expect(outcomeSyncs.failPendingForIntegration).toHaveBeenCalledWith(
        ORG,
        INTEGRATION,
        'integration_inactive',
      );
    });

    it('answers an organization with no connection as not connected', async () => {
      const { service, connections } = disconnecting();
      connections.disconnect.mockResolvedValue({ kind: 'not_connected' });

      await expect(answerOf(service.disconnect(owner))).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_NOT_CONNECTED',
      });
    });

    it('never writes a key, a secret or the store path into a log line or the answer', async () => {
      const { service, api } = disconnecting();
      api.deleteWebhook.mockResolvedValue(failed('unreachable'));

      const result = await service.disconnect(owner);

      const text = `${logged.join('\n')}${JSON.stringify(result)}`;
      expect(logged.join('\n')).toContain('example.com');
      for (const secret of [CONSUMER_KEY, CONSUMER_SECRET, 'whsec', 'v1:'])
        expect(text).not.toContain(secret);
      expect(logged.join('\n')).not.toContain('private-shop');
    });
  });

  describe('owner or admin only', () => {
    it.each(['disconnect', 'checkConnection', 'enableWebhooks'] as const)(
      'refuses a viewer on %s before anything is read or called',
      async (method) => {
        const { service, connections, api, health } = createService();

        await expect(
          answerOf(service[method]({ ...owner, role: 'viewer' })),
        ).resolves.toEqual({ status: 403, code: 'WOOCOMMERCE_ROLE_REQUIRED' });
        expect(connections.disconnect).not.toHaveBeenCalled();
        expect(health.check).not.toHaveBeenCalled();
        expect(health.enableWebhooks).not.toHaveBeenCalled();
        expect(api.deleteWebhook).not.toHaveBeenCalled();
      },
    );

    it('lets an admin check and re-enable, for their own organization only', async () => {
      const { service, connections, health } = createService();
      const admin = { ...owner, role: 'admin' as const };
      connections.getOverview.mockResolvedValue({
        organizationName: 'Noor',
        sourcePlatforms: ['woocommerce'],
        connection: storedConnection(),
        latestPending: undefined,
      });
      health.check.mockResolvedValue({
        checkedAt: CONNECTED_AT,
        problems: ['WOOCOMMERCE_WEBHOOK_DISABLED'],
        webhooks: [],
      });

      await expect(service.checkConnection(admin)).resolves.toMatchObject({
        problems: ['WOOCOMMERCE_WEBHOOK_DISABLED'],
        status: { state: 'connected' },
      });
      await expect(service.enableWebhooks(admin)).resolves.toMatchObject({
        state: 'connected',
      });
      expect(health.check).toHaveBeenCalledWith(ORG);
      expect(health.enableWebhooks).toHaveBeenCalledWith(ORG);
    });
  });
});

describe('parseInstallCallbackBody', () => {
  it('reads the documented fields and ignores the rest', () => {
    expect(
      parseInstallCallbackBody({
        key_id: 9,
        user_id: 123,
        consumer_key: 'ck_x',
        consumer_secret: 'cs_y',
        key_permissions: 'read_write',
        store_url: 'https://attacker.example.com',
      }),
    ).toEqual({
      consumerKey: 'ck_x',
      consumerSecret: 'cs_y',
      userId: 123,
      keyPermissions: 'read_write',
    });
  });

  it.each([
    undefined,
    null,
    'text',
    [],
    {},
    { consumer_key: 'ck_x' },
    { consumer_key: '', consumer_secret: 'cs_y' },
    { consumer_key: 'ck x', consumer_secret: 'cs_y' },
    { consumer_key: 'ck_x', consumer_secret: ['cs_y'] },
    { consumer_key: 'k'.repeat(513), consumer_secret: 'cs_y' },
    {
      consumer_key: `ck_${String.fromCharCode(0x645)}`,
      consumer_secret: 'cs_y',
    },
  ])('refuses %p', (value) => {
    expect(parseInstallCallbackBody(value)).toBeNull();
  });
});
