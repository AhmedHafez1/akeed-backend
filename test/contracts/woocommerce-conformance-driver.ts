import type { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { WooCommerceConnectionsRepository } from '../../src/infrastructure/database/repositories/woocommerce-connections.repository';
import { WooCommerceApiClient } from '../../src/infrastructure/spokes/woocommerce/woocommerce-api.client';
import { WooCommerceAuthService } from '../../src/infrastructure/spokes/woocommerce/woocommerce-auth.service';
import { WooCommerceConnectionHealthService } from '../../src/infrastructure/spokes/woocommerce/woocommerce-connection-health.service';
import { hashInstallToken } from '../../src/infrastructure/spokes/woocommerce/woocommerce-install-token';
import { WooCommerceOrderEligibilityStrategy } from '../../src/infrastructure/spokes/woocommerce/woocommerce-order-eligibility.strategy';
import { WooCommerceOrderNormalizer } from '../../src/infrastructure/spokes/woocommerce/woocommerce-order.normalizer';
import { WooCommerceOrderUpdateHandler } from '../../src/infrastructure/spokes/woocommerce/woocommerce-order-update.handler';
import { WooCommerceOutcomeAdapter } from '../../src/infrastructure/spokes/woocommerce/woocommerce-outcome.adapter';
import { WOOCOMMERCE_CONFIRMATION_NOTE } from '../../src/infrastructure/spokes/woocommerce/woocommerce-outcome.mapping';
import { WooCommerceSetupContributor } from '../../src/infrastructure/spokes/woocommerce/woocommerce-setup.contributor';
import { WooCommerceWebhookService } from '../../src/infrastructure/spokes/woocommerce/woocommerce-webhook.service';
import type { AuthenticatedUser } from '../../src/modules/auth/guards/dual-auth.guard';
import type { CommerceOutcomeAction } from '../../src/shared/commerce/commerce-outcome';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../../src/shared/config/woocommerce.config';
import { createRestrictedHttp } from '../../src/shared/http/restricted-http';
import { pingFixture, placedCodFixture } from '../fixtures/woocommerce/load';
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
import {
  FakeWooCommerce,
  type FakeWooCommerceRequest,
  type FakeWooCommerceStore,
} from './woocommerce-provider-fake';

/**
 * WooCommerce for the source conformance harness (US-07-06): the spoke as the
 * application binds it, over the WooCommerce provider fake, and the driver
 * that says what only WooCommerce decides. Every provider behavior here comes
 * from the US-07-01 contract record, through the fake.
 */

/**
 * The migrations the WooCommerce spoke runs on, after the shared ones and
 * `0049_commerce_outcome_syncs.sql`. The connection migration is given twice,
 * as every suite that uses it applies it: it must be safe to run again.
 */
export const WOOCOMMERCE_MIGRATIONS = [
  '0051_woocommerce_connection.sql',
  '0051_woocommerce_connection.sql',
  '0052_woocommerce_disconnect.sql',
];

/**
 * The deadline of one order call. A request the fake leaves hanging ends as
 * a real timeout of the restricted client after this long.
 */
export const WOOCOMMERCE_ORDER_CALL_TIMEOUT_MS = 250;

export interface WooCommerceMerchant extends ConformanceMerchant {
  store: FakeWooCommerceStore;
  consumerKey: string;
  webhookToken: string;
  webhookSecret: string;
}

export interface WooCommerceOrder extends ConformanceOrder {
  /** The order's id in the store. */
  remoteId: number;
}

/** A store named, approved by its merchant, and not yet called back. */
export interface WooCommerceInstall {
  store: FakeWooCommerceStore;
  callbackToken: string;
  /** What the authorize link sent as `user_id`. */
  installReference: string | null;
  keys: { consumerKey: string; consumerSecret: string };
}

export type WooCommerceTopic = 'order.created' | 'order.updated';

export interface WooCommerceDeliveryOverrides {
  token?: string;
  /** Signs the bytes with this secret instead of the store's. */
  secret?: string;
  /** `X-WC-Webhook-Signature` as given; `null` sends none. */
  signature?: string | null;
  /** `X-WC-Webhook-Source` as given; `null` sends none. */
  source?: string | null;
}

/** The status WooCommerce holds after each action Akeed may write. */
const STATUS_AFTER: Partial<Record<CommerceOutcomeAction, string>> = {
  // A confirmation changes no status (contract record, finding 5.13).
  customer_confirmation: 'processing',
  customer_cancellation: 'cancelled',
  merchant_no_reply_cancellation: 'cancelled',
};

const OUTCOME_META_KEY = 'akeed_outcome';
const tokenOf = (deliveryUrl: string) => deliveryUrl.split('/').pop()!;

export function installWooCommerce(base: ConformanceBase) {
  const settings: WooCommerceConfig & { pilotOrgIds: string[] } = {
    enabled: true,
    ingestionEnabled: true,
    outcomeSyncEnabled: true,
    pilotOrgIds: [],
    publicApiBaseUrl: 'https://api.akeed.test',
    appBaseUrl: 'https://app.akeed.test',
  };
  const config = {
    get: (key: string) => (key === WOOCOMMERCE_CONFIG ? settings : undefined),
    getOrThrow: (key: string) => {
      if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return base.encryptionKey;
      throw new Error(`Unexpected configuration key ${key}`);
    },
  } as unknown as ConfigService;

  // The fake is the DNS and the transport of the real restricted client: no
  // request leaves the process, and every store call runs the production
  // address checks.
  const fake = new FakeWooCommerce();
  const api = new WooCommerceApiClient(
    createRestrictedHttp({ lookup: fake.lookup, transport: fake.transport }),
  );
  const orderApi = new WooCommerceApiClient(
    createRestrictedHttp({
      lookup: fake.lookup,
      transport: fake.transport,
      timeoutMs: WOOCOMMERCE_ORDER_CALL_TIMEOUT_MS,
    }),
  );
  const connections = new WooCommerceConnectionsRepository(base.db);
  const health = new WooCommerceConnectionHealthService(
    connections,
    api,
    config,
  );
  const auth = new WooCommerceAuthService(
    connections,
    api,
    config,
    base.syncs,
    health,
  );
  const webhooks = new WooCommerceWebhookService(
    connections,
    base.events,
    base.producer,
    config,
  );
  const contributor = new WooCommerceSetupContributor(connections, health);
  const newAdapter = () =>
    new WooCommerceOutcomeAdapter(connections, orderApi, config);

  // Every organization a suite creates is a pilot organization.
  base.organizationHooks.push((orgId) => settings.pilotOrgIds.push(orgId));

  const spoke: ConformanceSpoke = {
    outcomeAdapter: newAdapter(),
    eligibilityStrategy: new WooCommerceOrderEligibilityStrategy(),
    normalizer: new WooCommerceOrderNormalizer(connections, base.phones),
    updateHandlers: [
      new WooCommerceOrderUpdateHandler(base.ordersRepo, base.syncs),
    ],
    reset() {
      settings.enabled = true;
      settings.ingestionEnabled = true;
      settings.outcomeSyncEnabled = true;
      fake.requests.length = 0;
    },
  };

  return {
    settings,
    fake,
    auth,
    health,
    webhooks,
    contributor,
    newAdapter,
    spoke,
  };
}

export type InstalledWooCommerce = ReturnType<typeof installWooCommerce>;

export function wooCommerceConformanceDriver(
  world: ConformanceWorld,
  wooCommerce: InstalledWooCommerce,
) {
  const { client, track, answer } = world;
  const { settings, fake, auth, webhooks } = wooCommerce;

  /** The store calls of an install, kept apart from what a case asserts. */
  const installRequests = new WeakSet<FakeWooCommerceRequest>();
  /** Where the request log stood when a key stopped being the store's key. */
  const retiredAt = new Map<string, number>();
  /** What Akeed answered to each ping a store sent. */
  const pings = new Map<FakeWooCommerceStore, number[]>();

  /** Requests after the install: order reads, order writes and notes. */
  function storeRequests(
    merchant?: WooCommerceMerchant,
  ): FakeWooCommerceRequest[] {
    return (merchant ? fake.requestsTo(merchant.store) : fake.requests).filter(
      (request) => !installRequests.has(request),
    );
  }

  const orderWrites = (merchant?: WooCommerceMerchant) =>
    storeRequests(merchant).filter(
      (request) => request.route === 'order_write',
    );

  /** A store that pings its delivery URL as a real one does (finding 3.9). */
  function newStore(path = ''): FakeWooCommerceStore {
    const store = fake.addStore(path);
    pings.set(store, []);
    store.onPing = async (deliveryUrl) => {
      // The ping's headers and body are not documented (finding 3.10): no
      // topic, and the fixture's assumed body.
      const answered = await answer(
        webhooks.handleDelivery(
          tokenOf(deliveryUrl),
          {},
          Buffer.from(pingFixture(), 'utf8'),
        ),
      );
      pings.get(store)!.push(answered.status);
    };
    return store;
  }

  /** The webhooks a store holds now, with what must stay secret tracked. */
  function currentWebhook(store: FakeWooCommerceStore) {
    const [webhook] = [...store.webhooks.values()];
    return {
      webhookToken: track(tokenOf(webhook.delivery_url)),
      webhookSecret: track(webhook.secret),
    };
  }

  async function connectionOf(source: { integrationId: string }) {
    const [row] = await client<
      {
        health: string;
        store_url: string;
        store_verified_at: Date | null;
        disconnected_at: Date | null;
        consumer_key_encrypted: string | null;
        consumer_secret_encrypted: string | null;
        webhook_secret_encrypted: string | null;
        webhook_token_hash: string | null;
        order_created_webhook_id: number | null;
        order_updated_webhook_id: number | null;
        order_created_webhook_state: string | null;
        order_updated_webhook_state: string | null;
        rejected_deliveries: number;
      }[]
    >`SELECT * FROM woocommerce_connections WHERE integration_id = ${source.integrationId}`;
    return row;
  }

  /** Start, and the merchant approving in the store: the store issues keys. */
  async function beginInstall(
    owner: AuthenticatedUser,
    store: FakeWooCommerceStore = newStore(),
  ): Promise<WooCommerceInstall> {
    const started = await auth.startInstall(owner, {
      storeUrl: store.url,
      locale: 'ar',
    });
    const params = new URL(started.authorizeUrl).searchParams;
    const keys = store.issueKeys();
    track(keys.consumerKey);
    track(keys.consumerSecret);
    return {
      store,
      callbackToken: track(tokenOf(params.get('callback_url')!)),
      installReference: params.get('user_id'),
      keys,
    };
  }

  /** The store posting the keys to the callback (finding 1.5). */
  async function finishInstall(
    install: WooCommerceInstall,
    replay?: WooCommerceInstall,
  ): Promise<void> {
    const { keys } = replay ?? install;
    try {
      await auth.handleCallback(install.callbackToken, {
        key_id: 1,
        user_id: install.installReference,
        consumer_key: keys.consumerKey,
        consumer_secret: keys.consumerSecret,
        key_permissions: 'read_write',
      });
    } finally {
      // Whatever Akeed sent a store must stay secret, taken or not.
      for (const webhook of install.store.everCreated) {
        track(webhook.secret);
        track(tokenOf(webhook.delivery_url));
      }
      for (const request of fake.requestsTo(install.store))
        installRequests.add(request);
    }
  }

  /** Connects a store the way a merchant does: start, approve, callback. */
  async function connect(
    store: FakeWooCommerceStore = newStore(),
  ): Promise<WooCommerceMerchant> {
    const owner = await world.newOrganization();
    const install = await beginInstall(owner, store);
    await finishInstall(install);
    const [integration] = await client<{ id: string }[]>`
      UPDATE integrations SET onboarding_status = 'completed'
      WHERE org_id = ${owner.orgId}
      RETURNING id`;
    return {
      orgId: owner.orgId,
      integrationId: integration.id,
      owner,
      store: install.store,
      consumerKey: install.keys.consumerKey,
      ...currentWebhook(install.store),
    };
  }

  async function reconnect(
    merchant: WooCommerceMerchant,
  ): Promise<WooCommerceMerchant> {
    const install = await beginInstall(merchant.owner, merchant.store);
    await finishInstall(install);
    return {
      ...merchant,
      consumerKey: install.keys.consumerKey,
      ...currentWebhook(merchant.store),
    };
  }

  let nextRemoteOrderId = 7_000;
  let phoneSuffix = 1_000;

  /**
   * A cash-on-delivery order placed in the store just now, as the documented
   * fixture shapes it. Order ids are never shared between stores here; the
   * case of two stores holding the same id is its own.
   */
  function placeOrder(
    merchant: WooCommerceMerchant,
    overrides: Record<string, unknown> = {},
  ): WooCommerceOrder {
    const remoteId = nextRemoteOrderId++;
    phoneSuffix += 1;
    const phone = `0100000${phoneSuffix}`;
    const placedAt = new Date().toISOString().slice(0, 19);
    const fixture = placedCodFixture().payload;
    merchant.store.placeOrder({
      ...fixture,
      id: remoteId,
      number: String(remoteId),
      date_created_gmt: placedAt,
      date_modified_gmt: placedAt,
      billing: { ...fixture.billing, phone },
      ...overrides,
    });
    return {
      externalOrderId: String(remoteId),
      expectedPhone: `+20${phone.slice(1)}`,
      expectedTotal: fixture.total,
      remoteId,
    };
  }

  /** The signature a store computes over the bytes it sends (finding 2.12). */
  const signatureOf = (bytes: Buffer, secret: string) =>
    createHmac('sha256', secret).update(bytes).digest('base64');

  /**
   * A delivery as the store sends it: the bytes, their signature with the
   * secret Akeed gave the store, and the store's own address. An override
   * replaces one part; `null` leaves that header out.
   */
  function deliverBytes(
    merchant: WooCommerceMerchant,
    bytes: Buffer,
    topic: WooCommerceTopic,
    overrides: WooCommerceDeliveryOverrides = {},
  ): Promise<ConformanceAnswer> {
    const signature =
      overrides.signature === undefined
        ? signatureOf(bytes, overrides.secret ?? merchant.webhookSecret)
        : overrides.signature;
    const source =
      overrides.source === undefined
        ? `${merchant.store.url}/`
        : overrides.source;
    return answer(
      webhooks.handleDelivery(
        overrides.token ?? merchant.webhookToken,
        {
          topic,
          ...(signature === null ? {} : { signature }),
          ...(source === null ? {} : { source }),
          webhookId: '9001',
          deliveryId: `synthetic-delivery-${randomUUID().slice(0, 8)}`,
        },
        bytes,
      ),
    );
  }

  /** The same, for an order object: sent as the JSON it serializes to. */
  function deliverBody(
    merchant: WooCommerceMerchant,
    body: unknown,
    topic: WooCommerceTopic,
    overrides: WooCommerceDeliveryOverrides = {},
  ): Promise<ConformanceAnswer> {
    return deliverBytes(
      merchant,
      Buffer.from(JSON.stringify(body), 'utf8'),
      topic,
      overrides,
    );
  }

  const markersOf = (merchant: WooCommerceMerchant, order: WooCommerceOrder) =>
    merchant.store.orders
      .get(order.remoteId)!
      .meta_data.filter((entry) => entry.key === OUTCOME_META_KEY)
      .map((entry) => String(entry.value));

  const driver: SourceConformanceDriver<
    WooCommerceMerchant,
    WooCommerceOrder,
    WooCommerceInstall
  > = {
    label: 'WooCommerce',
    codes: {
      installContextInvalid: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      connectUnavailable: 'WOOCOMMERCE_CONNECT_UNAVAILABLE',
      storeMismatch: 'store_unverified',
    },
    // The delivery route answers 200 with an empty body.
    accepted: { status: 200, body: undefined },
    // The first repeat of a placed order is an update of it (contract record,
    // section 4 routing): one create event and one update event.
    repeatedDeliveryEvents: 2,
    minimums: { secrets: 150, logs: 300, storedRows: 100 },
    secretTables: ['woocommerce_connections', 'woocommerce_pending_installs'],
    connectionTable: 'woocommerce_connections',
    fixtures: {
      directory: resolve(__dirname, '../fixtures/woocommerce'),
      files: [
        'order-checkout-draft.json',
        'order-placed-cod.json',
        'order-placed-non-cod.json',
        'order-updated.json',
      ],
      // A key as WooCommerce issues one, a signature header, or a credential
      // field. The word "secret" alone is in the fixtures' own notes.
      forbidden:
        /\bc[ks]_[0-9a-f]{8,}|"x-wc-webhook-signature"|"(consumer_key|consumer_secret|secret|delivery_url)"\s*:/i,
    },
    installFaults: [
      {
        name: 'store unreachable while the keys are proven',
        inject: (install) =>
          install.store.loseNext('system_status', {
            when: 'before',
            how: 'reset',
          }),
        refusal: { status: 503, code: 'WOOCOMMERCE_REST_UNREACHABLE' },
        expectNothingLeft: (install) => {
          expect(install.store.webhooks.size).toBe(0);
        },
      },
      {
        name: 'webhook creation fails at the store',
        // The first webhook is created, the second is refused.
        inject: (install) => install.store.failNext('create', 500, 1),
        refusal: { status: 503, code: 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED' },
        // The one that was created is deleted again: nothing half-connected.
        expectNothingLeft: (install) => {
          expect(install.store.everCreated).toHaveLength(1);
          expect(install.store.webhooks.size).toBe(0);
        },
      },
    ],
    traces: {
      // A confirmation: read, the lost write, the read-back that shows no
      // marker; then the retry reads, writes and adds the one note.
      timeoutBeforeApply: [
        'GET 200',
        'PUT timeout',
        'GET 200',
        'GET 200',
        'PUT 200',
        'POST 201',
      ],
      // A cancellation: the read-back shows `cancelled`, so nothing follows.
      timeoutAfterApply: ['GET 200', 'PUT timeout', 'GET 200'],
    },
    titles: {
      throttledWithoutHint:
        'a 429 without Retry-After waits on the standard backoff, and delays neither that store’s other orders nor another store',
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
    newAdapter: wooCommerce.newAdapter,
    providerStatusAfter: (action) => STATUS_AFTER[action] ?? '',

    // The store's identity is proven at connect, so nothing is left unproven.
    connect: () => connect(),
    startInstall: (owner) =>
      auth.startInstall(owner, { storeUrl: newStore().url, locale: 'ar' }),
    beginInstall: (owner) => beginInstall(owner),
    finishInstall,
    foreignInstall: (install) => {
      const keys = newStore().issueKeys();
      track(keys.consumerKey);
      track(keys.consumerSecret);
      return { ...install, keys };
    },
    requestsWithInstallKeys: (install) =>
      fake.requestsWithKey(install.keys.consumerKey),
    async disconnect(merchant) {
      await auth.disconnect(merchant.owner);
      // The disconnect itself used the key, to delete the webhooks.
      retiredAt.set(merchant.consumerKey, fake.requests.length);
    },
    reconnect,
    async connectionRow(orgId) {
      const rows = await client<Record<string, unknown>[]>`
        SELECT * FROM woocommerce_connections WHERE org_id = ${orgId}`;
      if (rows.length > 1)
        throw new Error('An organization holds more than one connection');
      return rows[0];
    },
    healthOf: async (merchant) => (await connectionOf(merchant)).health,

    placeOrder: (merchant) => placeOrder(merchant),
    deliverOrder: (merchant, order, options) => {
      const body = merchant.store.orderBody(order.remoteId);
      return deliverBody(
        merchant,
        options?.changed ? { ...body, total: '9999.00' } : body,
        'order.created',
      );
    },
    // Whether a write comes back as a delivery is not documented (finding
    // 5.12); the worst case is that every one does, as `order.updated`.
    deliverOutcomeEcho: (merchant, order) =>
      deliverBody(
        merchant,
        merchant.store.orderBody(order.remoteId),
        'order.updated',
      ),

    remoteStateOf(merchant, order) {
      const held = merchant.store.orders.get(order.remoteId)!;
      const markers = markersOf(merchant, order);
      if (
        held.status === 'processing' &&
        markers.length === 0 &&
        held.notes.length === 0
      )
        return 'untouched';
      // Confirmed: the marker and one internal note, and the status as it was.
      if (
        held.status === 'processing' &&
        markers.length === 1 &&
        markers[0].startsWith('customer_confirmation:') &&
        held.notes.length === 1 &&
        held.notes[0].note === WOOCOMMERCE_CONFIRMATION_NOTE &&
        !held.notes[0].customer_note
      )
        return 'confirmed';
      // Cancelled: the status and the marker together, and no note of Akeed's.
      if (
        held.status === 'cancelled' &&
        markers.length === 1 &&
        /^(customer_cancellation|merchant_no_reply_cancellation):/.test(
          markers[0],
        ) &&
        held.notes.length === 0
      )
        return 'cancelled';
      return `unexpected:${held.status}/${markers.length} marker(s)/${held.notes.length} note(s)`;
    },
    requestsOf: (merchant) => storeRequests(merchant),
    requestCount: () => fake.requests.length,
    writesOf: (merchant) => orderWrites(merchant),
    appliedWrites: (merchant) =>
      orderWrites(merchant).filter((request) => request.answered === 200)
        .length,
    trace: (merchant) =>
      storeRequests(merchant).map(
        (request) =>
          `${request.method} ${request.answered === 'error' ? 'timeout' : request.answered}`,
      ),
    retiredKeyRequests: (merchant) =>
      fake
        .requestsWithKey(merchant.consumerKey)
        .filter(
          (request) =>
            fake.requests.indexOf(request) >=
            (retiredAt.get(merchant.consumerKey) ?? 0),
        ),
    revokeKey: (merchant) => merchant.store.revokeKey(merchant.consumerKey),
    failNext(merchant, channel, fault) {
      const route = channel === 'read' ? 'order_read' : 'order_write';
      if (fault.kind === 'rate_limited')
        merchant.store.failNext(
          route,
          429,
          0,
          fault.retryAfterSeconds === undefined
            ? {}
            : { 'retry-after': String(fault.retryAfterSeconds) },
        );
      else if (fault.kind === 'unavailable')
        merchant.store.failNext(route, 503);
      else
        merchant.store.loseNext(route, {
          when: fault.kind === 'timeout_before_apply' ? 'before' : 'after',
          how: 'timeout',
        });
    },
    // The order the store returns links to another site (record, section 5,
    // step 1): it is not this store's order.
    makeStoreAnswerAsAnother(merchant) {
      merchant.store.orderLinkBase = 'https://elsewhere.example.com';
      return Promise.resolve();
    },

    expects: {
      async justConnected(merchant) {
        expect(await connectionOf(merchant)).toMatchObject({
          health: 'ok',
          store_url: merchant.store.url,
        });
        expect((await connectionOf(merchant)).store_verified_at).not.toBeNull();
        // Akeed created its two webhooks, and answered each ping with 200.
        expect(
          [...merchant.store.webhooks.values()].map((webhook) => [
            webhook.topic,
            webhook.status,
          ]),
        ).toEqual([
          ['order.created', 'active'],
          ['order.updated', 'active'],
        ]);
        expect(pings.get(merchant.store)).toEqual([200, 200]);
      },
      // Nothing is looked up at the store on the ingest path (section 4).
      firstOrderProcessed(merchant) {
        expect(storeRequests(merchant)).toHaveLength(0);
        return Promise.resolve();
      },
      outcomeWritten(merchant, order, action, verificationId) {
        const marker = {
          key: OUTCOME_META_KEY,
          value: `${action}:${verificationId}`,
        };
        const expected: unknown[] = [
          expect.objectContaining({
            method: 'GET',
            route: 'order_read',
            authenticated: true,
            answered: 200,
          }),
          expect.objectContaining({
            method: 'PUT',
            route: 'order_write',
            authenticated: true,
            answered: 200,
            body:
              action === 'customer_confirmation'
                ? { meta_data: [marker] }
                : { status: 'cancelled', meta_data: [marker] },
          }),
        ];
        if (action === 'customer_confirmation')
          expected.push(
            expect.objectContaining({
              method: 'POST',
              route: 'note_create',
              authenticated: true,
              answered: 201,
              body: {
                note: WOOCOMMERCE_CONFIRMATION_NOTE,
                customer_note: false,
              },
            }),
          );
        expect(storeRequests(merchant)).toEqual(expected);
        expect(markersOf(merchant, order)).toEqual([marker.value]);
      },
      // 2xx whatever the routing: a non-2xx counts toward disabling (3.11).
      repeatedDelivery(repeat) {
        expect(repeat.status).toBe(200);
      },
      repeatedEcho(repeat) {
        expect(repeat.status).toBe(200);
      },
      // No per-store budget (finding 8.2): the store's other order is written.
      async throttledWithoutHint({ merchant, second }) {
        expect(driver.remoteStateOf(merchant, second.order)).toBe('confirmed');
        expect(
          await world.syncsOf(merchant, second.verificationId),
        ).toMatchObject([{ state: 'succeeded' }]);
      },
      async disconnected(merchant) {
        expect(await connectionOf(merchant)).toMatchObject({
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          webhook_secret_encrypted: null,
          webhook_token_hash: null,
          order_created_webhook_id: null,
          order_updated_webhook_id: null,
        });
        // Akeed deleted its own webhooks at the store while it could.
        expect(merchant.store.webhooks.size).toBe(0);
      },
    },

    async attemptCrossTenantDeliveries(
      merchant: WooCommerceMerchant,
      bystander: WooCommerceMerchant,
      bystanderOrder: SentOrder<WooCommerceOrder>,
    ) {
      const foreign = bystander.store.orderBody(bystanderOrder.order.remoteId);
      const own = merchant.store.orderBody(placeOrder(merchant).remoteId);
      const rejectedBefore = {
        merchant: (await connectionOf(merchant)).rejected_deliveries,
        bystander: (await connectionOf(bystander)).rejected_deliveries,
      };

      // Tenant B's secret on tenant A's address, and the reverse.
      expect(
        await deliverBody(merchant, own, 'order.created', {
          secret: bystander.webhookSecret,
        }),
      ).toMatchObject({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      expect(
        (
          await deliverBody(bystander, foreign, 'order.created', {
            secret: merchant.webhookSecret,
          })
        ).status,
      ).toBe(401);
      // Tenant A's address and secret, from tenant B's store.
      expect(
        (
          await deliverBody(merchant, own, 'order.created', {
            source: `${bystander.store.url}/`,
          })
        ).status,
      ).toBe(401);
      // Tenant B's delivery, exactly as B's store signed it, on A's address.
      expect(
        (
          await deliverBody(bystander, foreign, 'order.updated', {
            token: merchant.webhookToken,
          })
        ).status,
      ).toBe(401);
      // Each refusal is counted on the address it reached, and nowhere else.
      expect((await connectionOf(merchant)).rejected_deliveries).toBe(
        rejectedBefore.merchant + 3,
      );
      expect((await connectionOf(bystander)).rejected_deliveries).toBe(
        rejectedBefore.bystander + 1,
      );

      // Tenant A's own store reporting a change to an order id only tenant B
      // holds in Akeed: recorded for tenant A, and skipped. An id means
      // nothing outside its own integration.
      expect(
        (
          await deliverBody(
            merchant,
            { ...foreign, status: 'cancelled' },
            'order.updated',
          )
        ).status,
      ).toBe(200);
      return { recorded: 1 };
    },
  };

  return {
    driver,
    connect,
    connectionOf,
    storeRequests,
    deliverBytes,
    deliverBody,
    signatureOf,
    placeOrder,
    newStore,
    beginInstall,
    finishInstall,
    markersOf,
    pings,
  };
}
