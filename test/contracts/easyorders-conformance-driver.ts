import type { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EasyOrdersConnectionsRepository } from '../../src/infrastructure/database/repositories/easyorders-connections.repository';
import { EasyOrdersApiClient } from '../../src/infrastructure/spokes/easyorders/easyorders-api.client';
import { EasyOrdersAuthService } from '../../src/infrastructure/spokes/easyorders/easyorders-auth.service';
import { hashInstallToken } from '../../src/infrastructure/spokes/easyorders/easyorders-install-token';
import { EasyOrdersOrderEligibilityStrategy } from '../../src/infrastructure/spokes/easyorders/easyorders-order-eligibility.strategy';
import { EasyOrdersOrderNormalizer } from '../../src/infrastructure/spokes/easyorders/easyorders-order.normalizer';
import { EasyOrdersOutcomeAdapter } from '../../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { EasyOrdersRateLimiter } from '../../src/infrastructure/spokes/easyorders/easyorders-rate-limiter';
import { EasyOrdersStatusUpdateHandler } from '../../src/infrastructure/spokes/easyorders/easyorders-status-update.handler';
import { EasyOrdersWebhookService } from '../../src/infrastructure/spokes/easyorders/easyorders-webhook.service';
import type { AuthenticatedUser } from '../../src/modules/auth/guards/dual-auth.guard';
import type { CommerceOutcomeAction } from '../../src/shared/commerce/commerce-outcome';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../../src/shared/config/easyorders.config';
import {
  orderCreatedFixture,
  type EasyOrdersOrderFixture,
} from '../fixtures/easyorders/load';
import {
  easyOrdersProviderFake,
  type FakeEasyOrdersRequest,
} from './easyorders-provider-fake';
import type {
  ConformanceAnswer,
  ConformanceBase,
  ConformanceMerchant,
  ConformanceOrder,
  ConformanceSpoke,
  ConformanceWorld,
  SentOrder,
  SourceConformanceDriver,
} from './source-conformance-harness';

/**
 * EasyOrders for the source conformance harness: the spoke as the
 * application binds it, over the EasyOrders provider fake, and the driver
 * that says what only EasyOrders decides. The assertions here are the
 * provider-specific ones of the US-06-06 release gate, unchanged.
 */

/** The migrations the EasyOrders spoke runs on, after the shared ones. */
export const EASYORDERS_MIGRATIONS = [
  '0047_easyorders_connection.sql',
  '0048_easyorders_ingestion.sql',
  '0049_commerce_outcome_syncs.sql',
  '0050_easyorders_disconnect.sql',
];

export interface EasyOrdersMerchant extends ConformanceMerchant {
  storeId: string;
  apiKey: string;
  webhookToken: string;
  ordersSecret: string;
  statusSecret: string;
}

export interface EasyOrdersOrder extends ConformanceOrder {
  /** The storefront order, held by the fake, as its order-created payload. */
  payload: EasyOrdersOrderFixture;
}

/** An install link opened and accepted in EasyOrders, not yet called back. */
export interface EasyOrdersInstall {
  storeId: string;
  apiKey: string;
  callbackToken: string;
  webhookToken: string;
}

/** The status EasyOrders holds after each action Akeed may write. */
const STATUS_AFTER: Partial<Record<CommerceOutcomeAction, string>> = {
  customer_confirmation: 'confirmed',
  customer_cancellation: 'canceled',
  merchant_no_reply_cancellation: 'canceled',
};

export function installEasyOrders(base: ConformanceBase) {
  const settings: EasyOrdersConfig & { pilotOrgIds: string[] } = {
    enabled: true,
    ingestionEnabled: true,
    outcomeSyncEnabled: true,
    pilotOrgIds: [],
    publicApiBaseUrl: 'https://api.akeed.test',
    appBaseUrl: 'https://app.akeed.test',
  };
  const config = {
    get: (key: string) => (key === EASYORDERS_CONFIG ? settings : undefined),
    getOrThrow: (key: string) => {
      if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return base.encryptionKey;
      throw new Error(`Unexpected configuration key ${key}`);
    },
  } as unknown as ConfigService;

  const provider = easyOrdersProviderFake();
  const connections = new EasyOrdersConnectionsRepository(base.db);
  const limiter = new EasyOrdersRateLimiter();
  const api = new EasyOrdersApiClient(provider.http);
  const webhooks = new EasyOrdersWebhookService(
    connections,
    base.producer,
    config,
  );
  const auth = new EasyOrdersAuthService(
    connections,
    api,
    config,
    base.phones,
    base.syncs,
  );
  const newAdapter = () =>
    new EasyOrdersOutcomeAdapter(connections, api, limiter, config);

  // Every organization a suite creates is a pilot organization.
  base.organizationHooks.push((orgId) => settings.pilotOrgIds.push(orgId));

  const spoke: ConformanceSpoke = {
    outcomeAdapter: newAdapter(),
    eligibilityStrategy: new EasyOrdersOrderEligibilityStrategy(),
    normalizer: new EasyOrdersOrderNormalizer(
      connections,
      api,
      limiter,
      base.phones,
      config,
    ),
    updateHandlers: [
      new EasyOrdersStatusUpdateHandler(base.ordersRepo, base.syncs),
    ],
    reset() {
      settings.enabled = true;
      settings.ingestionEnabled = true;
      settings.outcomeSyncEnabled = true;
      provider.clear();
    },
  };

  return { settings, provider, webhooks, auth, newAdapter, spoke };
}

export type InstalledEasyOrders = ReturnType<typeof installEasyOrders>;

export function easyOrdersConformanceDriver(
  world: ConformanceWorld,
  easyOrders: InstalledEasyOrders,
) {
  const { client, track, answer, retryQueue } = world;
  const { settings, provider, webhooks, auth } = easyOrders;

  /** The key probe each install makes, kept apart from what a case asserts. */
  const installProbes = new WeakSet<FakeEasyOrdersRequest>();
  /** Requests to EasyOrders after the install: lookups and status writes. */
  function storeRequests(key?: string): FakeEasyOrdersRequest[] {
    return (key ? provider.requestsWith(key) : provider.requests).filter(
      (request) => !installProbes.has(request),
    );
  }

  function secret(): string {
    return track(randomBytes(12).toString('base64'));
  }

  async function connectionOf(merchant: { integrationId: string }) {
    const [row] = await client<
      {
        health: string;
        store_verified_at: Date | null;
        disconnected_at: Date | null;
        api_key_encrypted: string | null;
        webhook_token_hash: string | null;
      }[]
    >`SELECT * FROM easyorders_connections WHERE integration_id = ${merchant.integrationId}`;
    return row;
  }

  /** The install link's two tokens, as the seller's browser carries them. */
  async function openInstallLink(owner: AuthenticatedUser) {
    const started = await auth.startInstall(owner, { locale: 'ar' });
    const params = new URLSearchParams(started.installUrl.split('?')[1]);
    return {
      callbackToken: track(params.get('callback_url')!.split('/').pop()!),
      webhookToken: track(params.get('orders_webhook')!.split('/').pop()!),
    };
  }

  /** Accept in EasyOrders: a new key for the store, not yet posted to Akeed. */
  async function beginInstall(
    owner: AuthenticatedUser,
    storeId: string = randomUUID(),
  ): Promise<EasyOrdersInstall> {
    const tokens = await openInstallLink(owner);
    return { storeId, apiKey: track(provider.issueKey(storeId)), ...tokens };
  }

  async function finishInstall(
    install: EasyOrdersInstall,
    replay?: EasyOrdersInstall,
  ): Promise<void> {
    const apiKey = (replay ?? install).apiKey;
    await auth.handleCallback(install.callbackToken, {
      api_key: apiKey,
      store_id: install.storeId,
    });
    for (const probe of provider.requestsWith(apiKey)) installProbes.add(probe);
  }

  async function install(owner: AuthenticatedUser, storeId: string) {
    const begun = await beginInstall(owner, storeId);
    await finishInstall(begun);
    return { apiKey: begun.apiKey, webhookToken: begun.webhookToken };
  }

  /**
   * Connects a store the way a seller does: install, callback, the two
   * webhook secrets, currency and phone country. With `unproven` the store
   * claim is left unverified: it is verified by the first order read with the
   * stored key.
   */
  async function connect(
    options: { unproven?: boolean } = {},
  ): Promise<EasyOrdersMerchant> {
    const owner = await world.newOrganization();
    const storeId = randomUUID();
    const { apiKey, webhookToken } = await install(owner, storeId);
    const ordersSecret = secret();
    const statusSecret = secret();
    await auth.saveWebhookSecrets(owner, { ordersSecret, statusSecret });
    await auth.saveOrderSettings(owner, {
      currency: 'EGP',
      phoneCountry: 'EG',
    });
    const [integration] = await client<{ id: string }[]>`
      UPDATE integrations SET onboarding_status = 'completed'
      WHERE org_id = ${owner.orgId}
      RETURNING id`;
    if (!options.unproven)
      await client`
        UPDATE easyorders_connections SET store_verified_at = now()
        WHERE integration_id = ${integration.id}`;
    return {
      orgId: owner.orgId,
      integrationId: integration.id,
      storeId,
      apiKey,
      webhookToken,
      ordersSecret,
      statusSecret,
      owner,
    };
  }

  async function reconnect(
    merchant: EasyOrdersMerchant,
  ): Promise<EasyOrdersMerchant> {
    const next = await install(merchant.owner, merchant.storeId);
    const ordersSecret = secret();
    const statusSecret = secret();
    await auth.saveWebhookSecrets(merchant.owner, {
      ordersSecret,
      statusSecret,
    });
    return { ...merchant, ...next, ordersSecret, statusSecret };
  }

  let phoneSuffix = 1_000;

  /** A storefront order: held by EasyOrders, and its order-created payload. */
  function placeOrder(merchant: EasyOrdersMerchant): EasyOrdersOrder {
    phoneSuffix += 1;
    const payload = {
      ...orderCreatedFixture(),
      id: randomUUID(),
      store_id: merchant.storeId,
      phone: `0100000${phoneSuffix}`,
    } as EasyOrdersOrderFixture;
    provider.placeOrder(merchant.storeId, payload.id, payload);
    return {
      externalOrderId: payload.id,
      expectedPhone: `+20${payload.phone.slice(1)}`,
      // The fixture's `total_cost`, as Akeed stores it.
      expectedTotal: '750.00',
      payload,
    };
  }

  /** An order-created webhook with any payload, token and secret. */
  function deliverPayload(
    merchant: EasyOrdersMerchant,
    payload: unknown,
    overrides: { token?: string; secret?: string } = {},
  ): Promise<ConformanceAnswer> {
    return answer(
      webhooks.handleOrderCreated(
        overrides.token ?? merchant.webhookToken,
        overrides.secret ?? merchant.ordersSecret,
        payload,
      ),
    );
  }

  function deliverStatus(
    merchant: EasyOrdersMerchant,
    payload: Record<string, unknown>,
    overrides: { token?: string; secret?: string } = {},
  ): Promise<ConformanceAnswer> {
    return answer(
      webhooks.handleStatusUpdate(
        overrides.token ?? merchant.webhookToken,
        overrides.secret ?? merchant.statusSecret,
        { event_type: 'order-status-update', payment_ref_id: null, ...payload },
      ),
    );
  }

  const driver: SourceConformanceDriver<
    EasyOrdersMerchant,
    EasyOrdersOrder,
    EasyOrdersInstall
  > = {
    label: 'EasyOrders',
    codes: {
      installContextInvalid: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      connectUnavailable: 'EASYORDERS_CONNECT_UNAVAILABLE',
      storeMismatch: 'store_mismatch',
    },
    accepted: { status: 200, body: { received: true } },
    // A repeat is a duplicate of the one event: EasyOrders has no update
    // route for an order payload.
    repeatedDeliveryEvents: 1,
    minimums: { secrets: 40, logs: 100, storedRows: 50 },
    secretTables: ['easyorders_connections', 'easyorders_pending_installs'],
    connectionTable: 'easyorders_connections',
    fixtures: {
      directory: resolve(__dirname, '../fixtures/easyorders'),
      files: ['order-created.json', 'order-status-update.json'],
      forbidden: /api[_-]?key|secret|token/i,
    },
    installFaults: [
      {
        name: 'provider unreachable',
        inject: (begun) =>
          provider.failNext(
            'read',
            { kind: 'timeout_before_apply' },
            begun.apiKey,
          ),
        refusal: { status: 503, code: 'EASYORDERS_PROVIDER_UNAVAILABLE' },
      },
    ],
    traces: {
      timeoutBeforeApply: [
        'GET 200',
        'PATCH timeout',
        'GET 200',
        'GET 200',
        'PATCH 200',
      ],
      timeoutAfterApply: ['GET 200', 'PATCH timeout', 'GET 200'],
    },
    titles: {
      throttledWithoutHint:
        'a 429 without Retry-After pauses that store until the next minute and no other store',
    },
    hashToken: hashInstallToken,
    switches: {
      connect: (on) => {
        settings.enabled = on;
      },
      ingestion: (on) => {
        settings.ingestionEnabled = on;
      },
      outcomeSync: (on) => {
        settings.outcomeSyncEnabled = on;
      },
    },
    newAdapter: easyOrders.newAdapter,
    providerStatusAfter: (action) => STATUS_AFTER[action] ?? '',

    connect,
    startInstall: (owner) => auth.startInstall(owner, { locale: 'ar' }),
    beginInstall: (owner) => beginInstall(owner),
    finishInstall,
    foreignInstall: (begun) => ({
      ...begun,
      apiKey: track(provider.issueKey(randomUUID())),
    }),
    requestsWithInstallKeys: (begun) => provider.requestsWith(begun.apiKey),
    disconnect: async (merchant) => {
      await auth.disconnect(merchant.owner);
    },
    reconnect,
    async connectionRow(orgId) {
      const rows = await client<Record<string, unknown>[]>`
        SELECT * FROM easyorders_connections WHERE org_id = ${orgId}`;
      if (rows.length > 1)
        throw new Error('An organization holds more than one connection');
      return rows[0];
    },
    healthOf: async (merchant) => (await connectionOf(merchant)).health,

    placeOrder,
    deliverOrder: (merchant, order, options) =>
      deliverPayload(
        merchant,
        options?.changed
          ? { ...order.payload, total_cost: 9_999 }
          : order.payload,
      ),
    deliverOutcomeEcho: (merchant, order, action) =>
      deliverStatus(merchant, {
        order_id: order.payload.id,
        old_status: 'pending',
        new_status: STATUS_AFTER[action],
      }),

    remoteStateOf(_merchant, order) {
      const status = provider.statusOf(order.payload.id);
      if (status === 'pending') return 'untouched';
      if (status === 'confirmed') return 'confirmed';
      if (status === 'canceled') return 'cancelled';
      return `unexpected:${String(status)}`;
    },
    requestsOf: (merchant) => storeRequests(merchant?.apiKey),
    requestCount: () => provider.requests.length,
    writesOf: (merchant) => provider.writes(merchant?.apiKey),
    appliedWrites: (merchant) =>
      provider
        .writes(merchant.apiKey)
        .filter((request) => request.answered === 200).length,
    trace: (merchant) =>
      storeRequests(merchant.apiKey).map(
        (request) => `${request.method} ${request.answered}`,
      ),
    // A disconnect makes no request, so every request with the old key counts.
    retiredKeyRequests: (merchant) => storeRequests(merchant.apiKey),
    revokeKey: (merchant) => provider.revokeKey(merchant.apiKey),
    failNext: (merchant, channel, fault) =>
      provider.failNext(channel, fault, merchant.apiKey),
    // The connection claims a store its key does not belong to.
    async makeStoreAnswerAsAnother(merchant) {
      await client`
        UPDATE easyorders_connections SET store_id = ${randomUUID()}
        WHERE integration_id = ${merchant.integrationId}`;
    },

    expects: {
      async justConnected(merchant) {
        expect(await connectionOf(merchant)).toMatchObject({
          health: 'ok',
          store_verified_at: null,
        });
      },
      // The first order proves the store: one read, with the store's key.
      async firstOrderProcessed(merchant, order) {
        expect((await connectionOf(merchant)).store_verified_at).not.toBeNull();
        expect(storeRequests(merchant.apiKey)).toEqual([
          {
            method: 'GET',
            key: merchant.apiKey,
            orderId: order.payload.id,
            answered: 200,
          },
        ]);
      },
      outcomeWritten(merchant, order, action) {
        expect(provider.writes(merchant.apiKey)).toEqual([
          {
            method: 'PATCH',
            key: merchant.apiKey,
            orderId: order.payload.id,
            status: STATUS_AFTER[action],
            answered: 200,
          },
        ]);
      },
      repeatedDelivery(repeat) {
        expect(repeat.body).toEqual({ received: true, duplicate: true });
      },
      repeatedEcho(repeat) {
        expect(repeat.body).toEqual({ received: true, duplicate: true });
      },
      async throttledWithoutHint({ merchant, second, requestsWhenLimited }) {
        // Section 8: wait for the next clock minute, plus up to 10 s of jitter.
        expect(retryQueue.delays[0]).toBeLessThanOrEqual(70_000);
        // The paused store makes no further request, for any of its orders.
        expect(storeRequests(merchant.apiKey)).toHaveLength(
          requestsWhenLimited,
        );
        expect(
          await world.syncsOf(merchant, second.verificationId),
        ).toMatchObject([
          { state: 'pending', error_code: 'source_rate_budget_exhausted' },
        ]);
      },
      async disconnected(merchant) {
        expect(await connectionOf(merchant)).toMatchObject({
          api_key_encrypted: null,
          webhook_token_hash: null,
        });
      },
    },

    async attemptCrossTenantDeliveries(
      merchant: EasyOrdersMerchant,
      bystander: EasyOrdersMerchant,
      bystanderOrder: SentOrder<EasyOrdersOrder>,
    ) {
      const foreign = placeOrder(bystander).payload;

      // Tenant A's address and secret, carrying tenant B's order.
      expect((await deliverPayload(merchant, foreign)).status).toBe(403);
      // Tenant B's secret on tenant A's address, and the reverse.
      expect(
        (
          await deliverPayload(merchant, placeOrder(merchant).payload, {
            secret: bystander.ordersSecret,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await deliverPayload(bystander, foreign, {
            secret: merchant.ordersSecret,
          })
        ).status,
      ).toBe(401);
      // A status event for tenant B's order on tenant A's address: recorded
      // for tenant A, and skipped.
      await deliverStatus(merchant, {
        order_id: bystanderOrder.order.payload.id,
        old_status: 'pending',
        new_status: 'canceled',
      });
      return { recorded: 1 };
    },
  };

  return { driver, connectionOf, storeRequests, deliverPayload };
}
