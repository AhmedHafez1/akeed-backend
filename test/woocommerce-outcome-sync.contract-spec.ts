import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { CommerceOutcomeSyncsRepository } from '../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { CreditAccountingRepository } from '../src/infrastructure/database/repositories/credit-accounting.repository';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { PeriodicPlanAccounting } from '../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../src/infrastructure/database/repositories/usage-accounting.router';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import { WooCommerceConnectionsRepository } from '../src/infrastructure/database/repositories/woocommerce-connections.repository';
import { EasyOrdersOrderEligibilityStrategy } from '../src/infrastructure/spokes/easyorders/easyorders-order-eligibility.strategy';
import { ShopifyOrderEligibilityStrategy } from '../src/infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { WooCommerceApiClient } from '../src/infrastructure/spokes/woocommerce/woocommerce-api.client';
import { WooCommerceAuthService } from '../src/infrastructure/spokes/woocommerce/woocommerce-auth.service';
import { WooCommerceConnectionHealthService } from '../src/infrastructure/spokes/woocommerce/woocommerce-connection-health.service';
import { WooCommerceOrderEligibilityStrategy } from '../src/infrastructure/spokes/woocommerce/woocommerce-order-eligibility.strategy';
import { WooCommerceOrderNormalizer } from '../src/infrastructure/spokes/woocommerce/woocommerce-order.normalizer';
import { WooCommerceOrderUpdateHandler } from '../src/infrastructure/spokes/woocommerce/woocommerce-order-update.handler';
import { WooCommerceOutcomeAdapter } from '../src/infrastructure/spokes/woocommerce/woocommerce-outcome.adapter';
import { WOOCOMMERCE_CONFIRMATION_NOTE } from '../src/infrastructure/spokes/woocommerce/woocommerce-outcome.mapping';
import { WooCommerceWebhookService } from '../src/infrastructure/spokes/woocommerce/woocommerce-webhook.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import type { CommerceOutcomeSyncJobPayload } from '../src/modules/commerce-outcomes/commerce-outcome-sync.constants';
import { CommerceOutcomeSyncProcessor } from '../src/modules/commerce-outcomes/commerce-outcome-sync.processor';
import type {
  CommerceOutcomeSyncProducer,
  OutcomeSyncRetry,
} from '../src/modules/commerce-outcomes/commerce-outcome-sync.producer';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapterRequest,
  CommerceOutcomeDispatchResult,
} from '../src/shared/commerce/commerce-outcome';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../src/shared/config/woocommerce.config';
import { createRestrictedHttp } from '../src/shared/http/restricted-http';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { PhoneService } from '../src/shared/services/phone.service';
import { encryptToken } from '../src/shared/utils/token-encryption.util';
import {
  selectOutcomeSync,
  toRemoteSync,
} from '../src/shared/verification/outcome-sync';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import {
  FakeWooCommerce,
  type FakeWooCommerceStore,
} from './contracts/woocommerce-provider-fake';
import { placedCodFixture } from './fixtures/woocommerce/load';

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value) {
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  }
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e01_test' ||
    url.username !== 'e01_test' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  }
  return value;
}

const namespace = `e07_outcome_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 12,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
let created = false;

/** Synthetic, generated per run: never a real key. */
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

/** Before every fixture order was created (they are dated 2026-01-01). */
const BEFORE_FIXTURES = '2025-12-31T00:00:00.000Z';

/**
 * The deadline of one store call in this suite. A request the fake leaves
 * hanging ends as a real timeout of the restricted client after this long.
 */
const STORE_CALL_TIMEOUT_MS = 250;

const settings: WooCommerceConfig & { pilotOrgIds: string[] } = {
  enabled: true,
  ingestionEnabled: true,
  outcomeSyncEnabled: true,
  pilotOrgIds: [],
  publicApiBaseUrl: 'https://api.akeed.test',
  appBaseUrl: 'https://app.akeed.test',
};

const wooCommerceConfig = {
  get: (key: string) => (key === WOOCOMMERCE_CONFIG ? settings : undefined),
  getOrThrow: (key: string) => {
    if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return ENCRYPTION_KEY;
    throw new Error(`Unexpected configuration key ${key}`);
  },
} as unknown as ConfigService;
const coreConfig = standaloneCreditBillingConfigService();

/** Every value that must never be logged, returned or stored in clear. */
const secrets = new Set<string>();
const logs: string[] = [];
const answers: unknown[] = [];

// --- Real repositories and services; only the edges are fakes. ---

const connections = new WooCommerceConnectionsRepository(db);
const events = new WebhookEventsRepository(db);
const integrations = new IntegrationsRepository(db as never, coreConfig);
const ordersRepo = new OrdersRepository(db);
const verificationsRepo = new VerificationsRepository(db);
const syncs = new CommerceOutcomeSyncsRepository(db);
const credits = new CreditAccountingRepository(db);
const router = new UsageAccountingRouter(
  new PrepaidCreditAccounting(credits),
  new PeriodicPlanAccounting(),
  coreConfig,
);
const dispatches = new VerificationMessageDispatchesRepository(db, router);
const billing = new BillingEntitlementService(
  new IntegrationMonthlyUsageRepository(db),
  router,
);
const creditEligibility = new CreditEligibilityService(credits, coreConfig);

// The fake is the DNS and the transport of the real restricted client: no
// request leaves the process, and every store call runs the production
// address checks.
const fake = new FakeWooCommerce();
const connectApi = new WooCommerceApiClient(
  createRestrictedHttp({ lookup: fake.lookup, transport: fake.transport }),
);
const auth = new WooCommerceAuthService(
  connections,
  connectApi,
  wooCommerceConfig,
  syncs,
  new WooCommerceConnectionHealthService(
    connections,
    connectApi,
    wooCommerceConfig,
  ),
);

/** Retries BullMQ would have been given; `runRetries` runs them. */
const scheduled: OutcomeSyncRetry[] = [];
const retryQueue = { down: false };
const retryProducer = {
  scheduleRetry: (retry: OutcomeSyncRetry) => {
    if (retryQueue.down) return Promise.reject(new Error('redis unavailable'));
    scheduled.push(retry);
    return Promise.resolve();
  },
} as unknown as CommerceOutcomeSyncProducer;

const adapter = new WooCommerceOutcomeAdapter(
  connections,
  new WooCommerceApiClient(
    createRestrictedHttp({
      lookup: fake.lookup,
      transport: fake.transport,
      timeoutMs: STORE_CALL_TIMEOUT_MS,
    }),
  ),
  wooCommerceConfig,
);
const registry = new CommerceOutcomeRegistryService(
  ordersRepo,
  [adapter],
  new CommerceOutcomeSyncTracker(syncs, retryProducer),
);
const retryWorker = new CommerceOutcomeSyncProcessor(syncs, registry);

async function runRetries(limit = 20): Promise<number> {
  let ran = 0;
  while (scheduled.length > 0 && ran < limit) {
    const retry = scheduled.shift()!;
    await retryWorker.process({
      id: `retry-${ran}`,
      data: { syncId: retry.syncId, orgId: retry.orgId },
    } as Job<CommerceOutcomeSyncJobPayload>);
    ran += 1;
  }
  return ran;
}

interface RecordedSend {
  to: string;
  verificationId: string;
}
const sends: RecordedSend[] = [];
const messaging: MessagingPort = {
  sendVerificationTemplate(params) {
    sends.push({ to: params.to, verificationId: params.verificationId });
    return Promise.resolve({ messages: [{ id: `wamid-e07-${sends.length}` }] });
  },
};

const send = new VerificationSendService(
  verificationsRepo,
  ordersRepo,
  billing,
  creditEligibility,
  dispatches,
  messaging,
);
const automation = {
  enqueueInitialSend: () => Promise.resolve(),
  enqueueFollowUp: () => Promise.resolve(),
  enqueueNoReplyEscalation: () => Promise.resolve(),
};
// The real hub, so an update that started a verification would show as one.
const hub = new VerificationHubService(
  ordersRepo,
  verificationsRepo,
  registry,
  new OrderEligibilityService([
    new ShopifyOrderEligibilityStrategy(),
    new StandaloneOrderEligibilityStrategy(),
    new EasyOrdersOrderEligibilityStrategy(),
    new WooCommerceOrderEligibilityStrategy(),
  ]),
  send,
  billing,
  creditEligibility,
  automation as never,
);

const processor = new WebhookQueueProcessor(
  [new WooCommerceOrderNormalizer(connections, new PhoneService())],
  events,
  integrations,
  hub,
  [new WooCommerceOrderUpdateHandler(ordersRepo, syncs)],
);

/** Jobs BullMQ would have received; `drain` runs them in order. */
const queued: WebhookJobPayload[] = [];
const dispatcher = new WebhookDispatchService(
  {
    add: (_name: string, payload: WebhookJobPayload) => {
      queued.push(payload);
      return Promise.resolve();
    },
  } as never,
  events,
  { get: () => undefined } as never,
);
const webhooks = new WooCommerceWebhookService(
  connections,
  events,
  new WebhookQueueProducer(events, integrations, dispatcher),
  wooCommerceConfig,
);

async function drain(): Promise<void> {
  while (queued.length > 0) {
    const data = queued.shift()!;
    await processor.process(
      {
        id: `job-${data.webhookEventId}`,
        data,
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as unknown as Job<WebhookJobPayload>,
      'lock-token',
    );
  }
}

// --- Tenants ---

interface Merchant {
  orgId: string;
  integrationId: string;
  store: FakeWooCommerceStore;
  consumerKey: string;
  webhookToken: string;
  webhookSecret: string;
}

function track(value: string): string {
  secrets.add(value);
  return value;
}

/** Connects a store the way a merchant does: start, approve, callback. */
async function connectMerchant(
  options: { onboarding?: 'completed' | 'pending' } = {},
): Promise<Merchant> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${`Store ${randomUUID().slice(0, 8)}`}, ${`org-${randomUUID()}`})
    RETURNING id`;
  const orgId = organization.id;
  settings.pilotOrgIds.push(orgId);
  const owner: AuthenticatedUser = {
    userId: randomUUID(),
    orgId,
    role: 'owner',
    source: 'supabase',
  };
  const store = fake.addStore();
  const started = await auth.startInstall(owner, {
    storeUrl: store.url,
    locale: 'ar',
  });
  const params = new URL(started.authorizeUrl).searchParams;
  const callbackToken = track(params.get('callback_url')!.split('/').pop()!);
  const keys = store.issueKeys();
  track(keys.consumerKey);
  track(keys.consumerSecret);
  await auth.handleCallback(callbackToken, {
    key_id: 1,
    user_id: params.get('user_id'),
    consumer_key: keys.consumerKey,
    consumer_secret: keys.consumerSecret,
    key_permissions: 'read_write',
  });

  const [webhook] = [...store.webhooks.values()];
  const [integration] = await client<{ id: string }[]>`
    UPDATE integrations
    SET onboarding_status = ${options.onboarding ?? 'completed'}
    WHERE org_id = ${orgId}
    RETURNING id`;
  await client`
    UPDATE woocommerce_connections
    SET connected_at = ${BEFORE_FIXTURES}
    WHERE integration_id = ${integration.id}`;
  return {
    orgId,
    integrationId: integration.id,
    store,
    consumerKey: keys.consumerKey,
    webhookToken: track(webhook.delivery_url.split('/').pop()!),
    webhookSecret: track(webhook.secret),
  };
}

/**
 * A delivery as the store sends it: the order as JSON bytes, their signature
 * with the secret Akeed gave the store, and the store's own address.
 */
async function deliver(
  merchant: Merchant,
  order: unknown,
  topic: 'order.created' | 'order.updated',
): Promise<number> {
  const body = Buffer.from(JSON.stringify(order), 'utf8');
  try {
    answers.push(
      await webhooks.handleDelivery(
        merchant.webhookToken,
        {
          topic,
          signature: createHmac('sha256', merchant.webhookSecret)
            .update(body)
            .digest('base64'),
          source: `${merchant.store.url}/`,
          webhookId: '9001',
          deliveryId: `synthetic-delivery-${randomUUID().slice(0, 8)}`,
        },
        body,
      ),
    );
    return 200;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    answers.push(error.getResponse());
    return error.getStatus();
  }
}

interface LocalOrder {
  /** The order's id in the store. */
  remoteId: number;
  externalOrderId: string;
  orderId: string;
  verificationId: string;
}

let nextRemoteOrderId = 7000;

/**
 * A cash-on-delivery order placed in the store and taken by ingestion as it
 * really is (delivery, queue, hub), with its verification then moved to a
 * local result, and the store's own status changed afterwards if asked.
 */
async function orderWith(
  merchant: Merchant,
  local: {
    status: 'confirmed' | 'canceled' | 'no_reply' | 'pending';
    remoteStatus?: string;
  },
): Promise<LocalOrder> {
  const remoteId = nextRemoteOrderId++;
  merchant.store.placeOrder({
    ...placedCodFixture().payload,
    id: remoteId,
    number: String(remoteId),
  });
  expect(
    await deliver(
      merchant,
      merchant.store.orderBody(remoteId),
      'order.created',
    ),
  ).toBe(200);
  await drain();
  const [order] = await client<{ id: string }[]>`
    SELECT id FROM orders
    WHERE integration_id = ${merchant.integrationId}
      AND external_order_id = ${String(remoteId)}`;
  const [verification] = await client<{ id: string }[]>`
    UPDATE verifications SET status = ${local.status}
    WHERE order_id = ${order.id}
    RETURNING id`;
  if (local.remoteStatus)
    merchant.store.setOrderStatus(remoteId, local.remoteStatus);
  return {
    remoteId,
    externalOrderId: String(remoteId),
    orderId: order.id,
    verificationId: verification.id,
  };
}

/** What the hub does once a customer has answered. */
function dispatch(
  merchant: Merchant,
  order: LocalOrder,
  action: CommerceOutcomeAction,
  overrides: Partial<{
    orgId: string;
    integrationId: string;
    retryInBackground: boolean;
  }> = {},
): Promise<CommerceOutcomeDispatchResult> {
  return registry.dispatch({
    orgId: merchant.orgId,
    integrationId: merchant.integrationId,
    externalOrderId: order.externalOrderId,
    action,
    correlationId: order.verificationId,
    retryInBackground: true,
    ...overrides,
  });
}

const ORDER_ROUTES = new Set(['order_read', 'order_write', 'note_create']);

/** The order calls a store received, apart from the ones that connected it. */
function orderCalls(merchant: Merchant) {
  return fake
    .requestsTo(merchant.store)
    .filter((request) => ORDER_ROUTES.has(request.route));
}

const routesOf = (merchant: Merchant) =>
  orderCalls(merchant).map((request) => request.route);
const writesOf = (merchant: Merchant) =>
  orderCalls(merchant).filter((request) => request.route === 'order_write');
const remote = (merchant: Merchant, order: LocalOrder) =>
  merchant.store.orders.get(order.remoteId)!;
const markerOf = (action: CommerceOutcomeAction, order: LocalOrder) =>
  `${action}:${order.verificationId}`;

function syncsOf(order: LocalOrder) {
  return client<
    {
      id: string;
      org_id: string;
      integration_id: string;
      order_id: string;
      external_order_id: string;
      correlation_id: string;
      action: string;
      state: string;
      attempts: number;
      deferrals: number;
      error_code: string | null;
      provider_status: string | null;
      requires_assistance: boolean;
    }[]
  >`SELECT * FROM commerce_outcome_syncs WHERE order_id = ${order.orderId} ORDER BY created_at`;
}

async function localStatus(order: LocalOrder): Promise<string> {
  const [row] = await client<{ status: string }[]>`
    SELECT status FROM verifications WHERE id = ${order.verificationId}`;
  return row.status;
}

async function verificationCount(merchant: Merchant): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM verifications WHERE org_id = ${merchant.orgId}`;
  return row.count;
}

async function healthOf(merchant: Merchant): Promise<string> {
  const [row] = await client<{ health: string }[]>`
    SELECT health FROM woocommerce_connections WHERE integration_id = ${merchant.integrationId}`;
  return row.health;
}

/** The update events recorded for one order, oldest first. */
function updateEventsOf(merchant: Merchant, order: { remoteId: number }) {
  return client<{ status: string; last_error: string | null }[]>`
    SELECT status, last_error FROM webhook_events
    WHERE integration_id = ${merchant.integrationId}
      AND job_type = 'order.update'
      AND idempotency_key LIKE ${`order.update:${merchant.integrationId}:${order.remoteId}:%`}
    ORDER BY received_at, created_at, id`;
}

/** The store sends the order as it now is, as `order.updated`. */
async function deliverUpdate(
  merchant: Merchant,
  order: LocalOrder,
): Promise<void> {
  expect(
    await deliver(
      merchant,
      merchant.store.orderBody(order.remoteId),
      'order.updated',
    ),
  ).toBe(200);
  await drain();
}

// --- Schema: the Drizzle tables, then the real migrations. ---

async function scaffold(table: PgTable) {
  const definition = getTableConfig(table);
  const dialect = new PgDialect();
  const columns = definition.columns.map((column) => {
    let result = `"${column.name}" ${column.getSQLType()}`;
    if (column.notNull) result += ' NOT NULL';
    if (column.primary) result += ' PRIMARY KEY';
    if (column.default !== undefined) {
      const value = column.default;
      result +=
        ' DEFAULT ' +
        (value instanceof SQL
          ? dialect.sqlToQuery(value).sql
          : typeof value === 'boolean' || typeof value === 'number'
            ? String(value)
            : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`);
    }
    return result;
  });
  for (const unique of definition.uniqueConstraints)
    columns.push(
      `CONSTRAINT "${unique.name}" UNIQUE (${unique.columns.map((column) => `"${column.name}"`).join(', ')})`,
    );
  await client.unsafe(
    `CREATE TABLE "${definition.name}" (${columns.join(', ')})`,
  );
}

function migrationStatements(name: string): string[] {
  return readFileSync(resolve(__dirname, '../drizzle', name), 'utf8')
    .replaceAll('"public"', `"${namespace}"`)
    .replaceAll("'public.", `'${namespace}.`)
    .replaceAll("'public'", `'${namespace}'`)
    .split('--> statement-breakpoint')
    .filter((part) => part.trim());
}

async function migrate(name: string) {
  for (const statement of migrationStatements(name))
    await client.unsafe(statement);
}

describe('WooCommerce outcome synchronization PostgreSQL contract (US-07-04)', () => {
  let merchant: Merchant;

  beforeAll(async () => {
    const capture: LoggerService = {
      log: (message: unknown) => logs.push(String(message)),
      warn: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(String(message)),
    };
    Logger.overrideLogger(capture);

    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE FUNCTION get_user_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.org_id', true), '')::uuid $$;`);
    for (const candidate of Object.values(tables)) {
      if (
        typeof candidate === 'function' &&
        'enumName' in candidate &&
        'enumValues' in candidate &&
        !String(candidate.enumName).startsWith('credit_') &&
        !String(candidate.enumName).startsWith('payment_')
      ) {
        const values = candidate.enumValues as string[];
        await client.unsafe(
          `CREATE TYPE "${String(candidate.enumName)}" AS ENUM (${values.map((item) => `'${item}'`).join(', ')})`,
        );
      }
    }
    for (const table of [
      tables.organizations,
      tables.integrations,
      tables.orders,
      tables.verifications,
      tables.integrationMonthlyUsage,
      tables.webhookEvents,
      tables.memberships,
      tables.billingFreePlanClaims,
    ])
      await scaffold(table);
    // What the scaffold cannot derive from the Drizzle tables: the partial
    // indexes the source and event rules rest on.
    await client.unsafe(`
      CREATE UNIQUE INDEX integrations_one_active_source_per_org_idx ON integrations (org_id) WHERE is_active = true;
      CREATE UNIQUE INDEX webhook_events_order_id_key ON webhook_events (order_id) WHERE order_id IS NOT NULL;
      ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_source_identity_pair_check CHECK ((org_id IS NULL) = (integration_id IS NULL));
    `);
    const dispatchDdl = migrationStatements(
      '0028_manual_order_lifecycle_dispatch_ledger.sql',
    ).find((part) =>
      part.includes(
        `CREATE TABLE IF NOT EXISTS "${namespace}"."verification_message_dispatches"`,
      ),
    )!;
    await client.unsafe(dispatchDdl);
    for (const name of [
      '0032_credit_and_payment_domain_foundation.sql',
      '0033_dispatch_accounting_mode.sql',
      '0045_provider_message_receipts.sql',
      // The sync table E06 added. This story reuses it unchanged.
      '0049_commerce_outcome_syncs.sql',
    ])
      await migrate(name);
    // This story adds no migration: it runs on the US-07-02 tables as they
    // are. Applied twice, as every suite that uses it does.
    for (let pass = 0; pass < 2; pass++)
      await migrate('0051_woocommerce_connection.sql');
    await migrate('0052_woocommerce_disconnect.sql');
  });

  afterAll(async () => {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    settings.outcomeSyncEnabled = true;
    retryQueue.down = false;
    scheduled.length = 0;
    queued.length = 0;
    sends.length = 0;
    // A merchant per test: its own store, its own keys.
    merchant = await connectMerchant();
  });

  describe('approved mapping', () => {
    it('a confirmation writes the marker and one internal note, and changes no status', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'applied',
        providerStatus: 'processing',
      });
      expect(remote(merchant, order)).toMatchObject({
        status: 'processing',
        meta_data: [
          {
            key: 'akeed_outcome',
            value: markerOf('customer_confirmation', order),
          },
        ],
        notes: [{ note: WOOCOMMERCE_CONFIRMATION_NOTE, customer_note: false }],
      });
      expect(orderCalls(merchant)).toEqual([
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
          body: {
            meta_data: [
              {
                key: 'akeed_outcome',
                value: markerOf('customer_confirmation', order),
              },
            ],
          },
        }),
        expect.objectContaining({
          method: 'POST',
          route: 'note_create',
          authenticated: true,
          answered: 201,
          body: { note: WOOCOMMERCE_CONFIRMATION_NOTE, customer_note: false },
        }),
      ]);
      expect(await syncsOf(order)).toEqual([
        expect.objectContaining({
          org_id: merchant.orgId,
          integration_id: merchant.integrationId,
          order_id: order.orderId,
          external_order_id: order.externalOrderId,
          correlation_id: order.verificationId,
          action: 'customer_confirmation',
          state: 'succeeded',
          attempts: 1,
          error_code: null,
          provider_status: 'processing',
        }),
      ]);
      expect(await localStatus(order)).toBe('confirmed');
    });

    it.each<[CommerceOutcomeAction, string]>([
      ['customer_cancellation', 'processing'],
      ['customer_cancellation', 'on-hold'],
      ['merchant_no_reply_cancellation', 'processing'],
      ['merchant_no_reply_cancellation', 'on-hold'],
    ])(
      '%s writes cancelled and the marker in one update from %s',
      async (action, remoteStatus) => {
        const order = await orderWith(merchant, {
          status: 'canceled',
          remoteStatus,
        });

        const result = await dispatch(merchant, order, action);

        expect(result).toMatchObject({
          status: 'applied',
          providerStatus: 'cancelled',
        });
        expect(remote(merchant, order)).toMatchObject({
          status: 'cancelled',
          meta_data: [{ key: 'akeed_outcome', value: markerOf(action, order) }],
          notes: [],
        });
        expect(
          orderCalls(merchant).map((request) => [request.route, request.body]),
        ).toEqual([
          ['order_read', undefined],
          [
            'order_write',
            {
              status: 'cancelled',
              meta_data: [
                { key: 'akeed_outcome', value: markerOf(action, order) },
              ],
            },
          ],
        ]);
        expect((await syncsOf(order))[0]).toMatchObject({
          action,
          state: 'succeeded',
          provider_status: 'cancelled',
        });
      },
    );

    it('a confirmation is written from on-hold too', async () => {
      const order = await orderWith(merchant, {
        status: 'confirmed',
        remoteStatus: 'on-hold',
      });

      await expect(
        dispatch(merchant, order, 'customer_confirmation'),
      ).resolves.toMatchObject({
        status: 'applied',
        providerStatus: 'on-hold',
      });
      expect(remote(merchant, order).status).toBe('on-hold');
      expect(remote(merchant, order).notes).toHaveLength(1);
    });

    it('never sends processing, completed or a paid flag to the store', async () => {
      const confirmed = await orderWith(merchant, { status: 'confirmed' });
      const canceled = await orderWith(merchant, { status: 'canceled' });

      await dispatch(merchant, confirmed, 'customer_confirmation');
      await dispatch(merchant, canceled, 'merchant_no_reply_cancellation');

      for (const request of orderCalls(merchant))
        expect(JSON.stringify(request.body ?? {})).not.toMatch(
          /set_paid|"processing"|"completed"|"refunded"|_method/,
        );
    });

    it.each<CommerceOutcomeAction>([
      'automatic_no_reply_tagging',
      'merchant_cancellation_tagging',
    ])('keeps %s local: unsupported, and nothing is sent', async (action) => {
      const order = await orderWith(merchant, { status: 'no_reply' });

      const result = await dispatch(merchant, order, action);

      expect(result).toMatchObject({
        status: 'unsupported',
        reason: 'capability_not_supported',
      });
      expect(orderCalls(merchant)).toHaveLength(0);
      expect(remote(merchant, order)).toMatchObject({
        status: 'processing',
        meta_data: [],
        notes: [],
      });
      expect(scheduled).toHaveLength(0);
      expect(await syncsOf(order)).toEqual([
        expect.objectContaining({
          action,
          state: 'unsupported',
          error_code: 'capability_not_supported',
        }),
      ]);
      expect(await localStatus(order)).toBe('no_reply');
    });

    it('shows automatic no-reply to the merchant as local only, never as a cancellation', async () => {
      const order = await orderWith(merchant, { status: 'no_reply' });
      await dispatch(merchant, order, 'automatic_no_reply_tagging');

      const [row] = await syncs.findByCorrelationIds(merchant.orgId, [
        order.verificationId,
      ]);

      expect(
        toRemoteSync(
          selectOutcomeSync(
            {
              id: order.verificationId,
              status: 'no_reply',
              cancellationSource: null,
            },
            [row],
          )!,
        ),
      ).toMatchObject({ state: 'unsupported', retryable: false });
    });

    it('sends nothing at all while remote writes are switched off', async () => {
      settings.outcomeSyncEnabled = false;
      const order = await orderWith(merchant, { status: 'confirmed' });

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({ status: 'unsupported' });
      for (const action of [
        'customer_confirmation',
        'customer_cancellation',
        'merchant_no_reply_cancellation',
      ] as const)
        expect(registry.supports('woocommerce', action)).toBe(false);
      expect(orderCalls(merchant)).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'unsupported' });
      expect(await localStatus(order)).toBe('confirmed');
    });
  });

  describe('remote state', () => {
    it.each([
      'pending',
      'completed',
      'cancelled',
      'refunded',
      'failed',
      'wc-awaiting-pickup',
    ])(
      'does not overwrite an order that is %s with a confirmation',
      async (remoteStatus) => {
        const order = await orderWith(merchant, {
          status: 'confirmed',
          remoteStatus,
        });

        const result = await dispatch(merchant, order, 'customer_confirmation');

        expect(result).toMatchObject({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus: remoteStatus,
        });
        expect(routesOf(merchant)).toEqual(['order_read']);
        expect(remote(merchant, order)).toMatchObject({
          status: remoteStatus,
          meta_data: [],
          notes: [],
        });
        expect(scheduled).toHaveLength(0);
        expect((await syncsOf(order))[0]).toMatchObject({
          state: 'failed',
          error_code: 'remote_state_conflict',
          provider_status: remoteStatus,
          requires_assistance: false,
        });
        expect(await localStatus(order)).toBe('confirmed');
      },
    );

    it.each(['completed', 'refunded', 'wc-awaiting-pickup'])(
      'does not cancel an order that is %s',
      async (remoteStatus) => {
        const order = await orderWith(merchant, {
          status: 'canceled',
          remoteStatus,
        });

        const result = await dispatch(
          merchant,
          order,
          'merchant_no_reply_cancellation',
        );

        expect(result).toMatchObject({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus: remoteStatus,
        });
        expect(routesOf(merchant)).toEqual(['order_read']);
        expect(remote(merchant, order).status).toBe(remoteStatus);
        expect(await localStatus(order)).toBe('canceled');
      },
    );

    it('reports a cancellation of an order already cancelled in the store without writing', async () => {
      const order = await orderWith(merchant, {
        status: 'canceled',
        remoteStatus: 'cancelled',
      });

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'applied',
        providerStatus: 'cancelled',
      });
      expect(routesOf(merchant)).toEqual(['order_read']);
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });

    it('does not write again for a repeated outcome: one update, one marker, one note', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });

      await dispatch(merchant, order, 'customer_confirmation');
      await dispatch(merchant, order, 'customer_confirmation');
      await dispatch(merchant, order, 'customer_confirmation');

      expect(writesOf(merchant)).toHaveLength(1);
      expect(remote(merchant, order).meta_data).toHaveLength(1);
      expect(remote(merchant, order).notes).toHaveLength(1);
      const rows = await syncsOf(order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'succeeded' });
    });

    it('does not cancel a second time an order the merchant reopened', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      await dispatch(merchant, order, 'customer_cancellation');
      merchant.store.setOrderStatus(order.remoteId, 'processing');

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: 'processing',
      });
      expect(writesOf(merchant)).toHaveLength(1);
      expect(remote(merchant, order).status).toBe('processing');
    });

    it('reports an order the store no longer has', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.orders.delete(order.remoteId);

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'order_not_found',
      });
      expect(scheduled).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('refuses a dispatch that names another tenant’s order, before any request', async () => {
      const other = await connectMerchant();
      const theirs = await orderWith(other, { status: 'confirmed' });

      for (const overrides of [
        // Tenant A's identity with tenant B's order id.
        {},
        // Tenant A's organization with tenant B's integration.
        { integrationId: other.integrationId },
        // Tenant B's organization with tenant A's integration.
        { orgId: other.orgId },
      ]) {
        const result = await dispatch(
          merchant,
          theirs,
          'customer_confirmation',
          overrides,
        );
        expect(result).toMatchObject({
          status: 'permanent_failure',
          errorCode: 'source_identity_mismatch',
        });
      }

      expect(orderCalls(merchant)).toHaveLength(0);
      expect(orderCalls(other)).toHaveLength(0);
      expect(remote(other, theirs).meta_data).toHaveLength(0);
      expect(await syncsOf(theirs)).toHaveLength(0);
    });

    it('sends each order to its own store with its own key, even when two stores use one order id', async () => {
      const other = await connectMerchant();
      const mine = await orderWith(merchant, { status: 'confirmed' });
      // The same id in the other store.
      other.store.placeOrder({
        ...placedCodFixture().payload,
        id: mine.remoteId,
        number: String(mine.remoteId),
      });
      await deliver(
        other,
        other.store.orderBody(mine.remoteId),
        'order.created',
      );
      await drain();
      const [theirOrder] = await client<{ id: string }[]>`
        SELECT id FROM orders WHERE integration_id = ${other.integrationId}`;
      const [theirVerification] = await client<{ id: string }[]>`
        UPDATE verifications SET status = 'canceled'
        WHERE order_id = ${theirOrder.id} RETURNING id`;
      const theirs: LocalOrder = {
        remoteId: mine.remoteId,
        externalOrderId: mine.externalOrderId,
        orderId: theirOrder.id,
        verificationId: theirVerification.id,
      };

      await dispatch(merchant, mine, 'customer_confirmation');
      await dispatch(other, theirs, 'customer_cancellation');

      expect(remote(merchant, mine)).toMatchObject({
        status: 'processing',
        meta_data: [{ value: markerOf('customer_confirmation', mine) }],
      });
      expect(remote(other, theirs)).toMatchObject({
        status: 'cancelled',
        meta_data: [{ value: markerOf('customer_cancellation', theirs) }],
      });
      // A key sent to the wrong store would have been answered 401.
      for (const request of [...orderCalls(merchant), ...orderCalls(other)])
        expect(request).toMatchObject({ authenticated: true });
      expect(
        await syncs.findByCorrelationIds(merchant.orgId, [
          mine.verificationId,
          theirs.verificationId,
        ]),
      ).toEqual([
        expect.objectContaining({
          integrationId: merchant.integrationId,
          correlationId: mine.verificationId,
        }),
      ]);
    });

    it('fails closed when the store answers with another store’s order', async () => {
      const other = await connectMerchant();
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.orderLinkBase = other.store.url;

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_unverified',
      });
      expect(routesOf(merchant)).toEqual(['order_read']);
      expect(remote(merchant, order).meta_data).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it('fails closed when the store answers with another order', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.answerOrderIdAs = order.remoteId + 1;

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_unverified',
      });
      expect(routesOf(merchant)).toEqual(['order_read']);
      expect(remote(merchant, order).status).toBe('processing');
    });

    it('does not let another organization reopen a failed sync', async () => {
      const other = await connectMerchant();
      const order = await orderWith(merchant, {
        status: 'confirmed',
        remoteStatus: 'completed',
      });
      await dispatch(merchant, order, 'customer_confirmation');
      const [row] = await syncsOf(order);

      expect(await syncs.resetForRetry(row.id, other.orgId)).toBeUndefined();
      expect(await syncs.findByIdForOrg(row.id, other.orgId)).toBeUndefined();
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'failed' });
    });
  });

  describe('a timeout before the write was taken', () => {
    it('on the read: nothing was written, and the retry does the whole write', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.loseNext('order_read', {
        when: 'before',
        how: 'timeout',
      });

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_unavailable',
      });
      expect(remote(merchant, order).meta_data).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'pending',
        error_code: 'source_unavailable',
        attempts: 1,
      });
      expect(await localStatus(order)).toBe('confirmed');
      expect(scheduled).toHaveLength(1);

      await runRetries();

      expect(routesOf(merchant)).toEqual([
        'order_read',
        'order_read',
        'order_write',
        'note_create',
      ]);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 2,
        error_code: null,
      });
    });

    it('on the write: writes again only after reading that the first was not taken', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.loseNext('order_write', {
        when: 'before',
        how: 'timeout',
      });

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
      expect(remote(merchant, order).status).toBe('processing');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });

      await runRetries();

      expect(routesOf(merchant)).toEqual([
        'order_read',
        'order_write',
        'order_read',
        'order_read',
        'order_write',
      ]);
      expect(remote(merchant, order)).toMatchObject({
        status: 'cancelled',
        meta_data: [{ value: markerOf('customer_cancellation', order) }],
      });
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });
  });

  describe('a timeout after the write was taken', () => {
    it('reads the order back and reports success without writing twice', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.loseNext('order_write', { when: 'after', how: 'timeout' });

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'applied',
        providerStatus: 'cancelled',
      });
      expect(routesOf(merchant)).toEqual([
        'order_read',
        'order_write',
        'order_read',
      ]);
      expect(remote(merchant, order).meta_data).toHaveLength(1);
      expect(scheduled).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 1,
      });
    });

    it('adds the confirmation note once the read-back shows the marker', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.loseNext('order_write', { when: 'after', how: 'timeout' });

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({ status: 'applied' });
      expect(routesOf(merchant)).toEqual([
        'order_read',
        'order_write',
        'order_read',
        'note_create',
      ]);
      expect(remote(merchant, order).meta_data).toHaveLength(1);
      expect(remote(merchant, order).notes).toHaveLength(1);
    });

    it('stays pending when the read-back is lost too, keeps the local result, and reconciles on the retry', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.loseNext('order_write', { when: 'after', how: 'timeout' });
      // The first read goes through; the read-back does not.
      merchant.store.loseNext(
        'order_read',
        { when: 'before', how: 'reset' },
        1,
      );

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'pending',
        error_code: 'write_unconfirmed',
        attempts: 1,
      });
      expect(await localStatus(order)).toBe('confirmed');
      expect(scheduled).toHaveLength(1);

      await runRetries();

      // The retry read the order first, found the marker, and wrote nothing.
      expect(writesOf(merchant)).toHaveLength(1);
      expect(remote(merchant, order).meta_data).toHaveLength(1);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 2,
        error_code: null,
      });
      // The known limit of "at most once": the marker without the note. A
      // retry never adds a note it cannot prove is missing.
      expect(remote(merchant, order).notes).toHaveLength(0);
    });

    it('treats a broken connection the same as a timeout', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.loseNext('order_write', { when: 'after', how: 'reset' });

      await expect(
        dispatch(merchant, order, 'merchant_no_reply_cancellation'),
      ).resolves.toMatchObject({ status: 'applied' });
      expect(writesOf(merchant)).toHaveLength(1);
    });
  });

  describe('throttling and transient failures', () => {
    it('waits for a 429 that names a delay, without spending an attempt, then succeeds', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.failNext('order_read', 429, 0, { 'retry-after': '30' });

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_rate_limited',
        retryAfterMs: 30_000,
      });
      expect(scheduled[0]).toMatchObject({ delayMs: 30_000, attempts: 0 });
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'pending',
        attempts: 0,
        deferrals: 1,
      });

      await runRetries();

      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 1,
        deferrals: 1,
      });
      expect(remote(merchant, order).meta_data).toHaveLength(1);
    });

    it('honors Retry-After on a 503 from the host as well', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.failNext('order_write', 503, 0, { 'retry-after': '12' });

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_unavailable',
        retryAfterMs: 12_000,
      });
      expect(scheduled[0]).toMatchObject({ delayMs: 12_000, attempts: 0 });

      await runRetries();

      expect(remote(merchant, order).status).toBe('cancelled');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });

    it('uses the existing backoff for a 429 that names no delay', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.failNext('order_read', 429);

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_rate_limited',
      });
      expect(result).not.toHaveProperty('retryAfterMs');
      expect(scheduled[0]).toMatchObject({ delayMs: 30_000, attempts: 1 });
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'pending',
        attempts: 1,
        deferrals: 0,
      });
    });

    it('gives up after bounded attempts and leaves a failure the merchant can retry', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.down = true;

      await dispatch(merchant, order, 'customer_confirmation');
      const ran = await runRetries();

      expect(ran).toBe(4);
      const [row] = await syncsOf(order);
      expect(row).toMatchObject({
        state: 'failed',
        error_code: 'source_unavailable',
        attempts: 5,
        requires_assistance: false,
      });
      expect(await localStatus(order)).toBe('confirmed');
      const [stored] = await syncs.findByCorrelationIds(merchant.orgId, [
        order.verificationId,
      ]);
      expect(toRemoteSync(stored)).toMatchObject({
        state: 'failed',
        retryable: true,
        requires_assistance: false,
      });

      // The manual retry: a fresh set of tries, through the same registry.
      merchant.store.down = false;
      expect(await syncs.resetForRetry(row.id, merchant.orgId)).toMatchObject({
        state: 'pending',
        attempts: 0,
      });
      await dispatch(merchant, order, 'customer_confirmation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
      expect(remote(merchant, order).notes).toHaveLength(1);
    });

    it('shows a failure instead of waiting forever when the retry cannot be queued', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.down = true;
      retryQueue.down = true;

      await dispatch(merchant, order, 'customer_confirmation');

      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'retry_not_scheduled',
      });
    });

    it('does not retry a merchant’s own action behind the merchant', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.down = true;

      const result = await dispatch(
        merchant,
        order,
        'merchant_no_reply_cancellation',
        { retryInBackground: false },
      );

      expect(result).toMatchObject({ status: 'retryable_failure' });
      expect(scheduled).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'failed' });
    });
  });

  describe('credentials, permission and hosting', () => {
    it('a revoked key stops at once, flags assisted action and marks the connection', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.revokeKey(merchant.consumerKey);

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'source_credentials_rejected',
        requiresAssistance: true,
      });
      expect(routesOf(merchant)).toEqual(['order_read']);
      expect(scheduled).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'source_credentials_rejected',
        requires_assistance: true,
        attempts: 1,
      });
      expect(await healthOf(merchant)).toBe('credentials_rejected');
      expect(await localStatus(order)).toBe('confirmed');
    });

    it('a key revoked between the read and the write stops there too', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.failNext('order_write', 401);

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'source_credentials_rejected',
        requiresAssistance: true,
      });
      expect(scheduled).toHaveLength(0);
      expect(await healthOf(merchant)).toBe('credentials_rejected');
      expect(remote(merchant, order).status).toBe('processing');
    });

    it('a key whose user lost the permission is flagged apart from a rejected key', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      const weak = merchant.store.issueKeys({ canManage: false });
      track(weak.consumerKey);
      track(weak.consumerSecret);
      await client`
        UPDATE woocommerce_connections
        SET consumer_key_encrypted = ${encryptToken(weak.consumerKey, ENCRYPTION_KEY)},
            consumer_secret_encrypted = ${encryptToken(weak.consumerSecret, ENCRYPTION_KEY)}
        WHERE integration_id = ${merchant.integrationId}`;

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'source_permission_denied',
        requiresAssistance: true,
      });
      expect(scheduled).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        requires_assistance: true,
      });
      expect(await healthOf(merchant)).toBe('permission_denied');
    });

    it('clears the health state once the store accepts the keys again', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.failNext('order_read', 401);
      await dispatch(merchant, order, 'customer_confirmation');
      expect(await healthOf(merchant)).toBe('credentials_rejected');
      const [row] = await syncsOf(order);

      await syncs.resetForRetry(row.id, merchant.orgId);
      await dispatch(merchant, order, 'customer_confirmation');

      expect(await healthOf(merchant)).toBe('ok');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });

    it('a host that refuses PUT needs assistance and is not retried', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.failNext('order_write', 405);

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_write_method_refused',
        requiresAssistance: true,
      });
      expect(routesOf(merchant)).toEqual(['order_read', 'order_write']);
      expect(scheduled).toHaveLength(0);
      expect(await healthOf(merchant)).toBe('ok');
    });

    it('a change the store refuses is permanent and is not retried', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.failNext('order_write', 400);

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'remote_rejected',
      });
      expect(scheduled).toHaveLength(0);
      expect(remote(merchant, order).status).toBe('processing');
    });

    it('never sends a key to a store that no longer resolves to a public address', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.addresses = ['169.254.169.254'];

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_unreachable',
        requiresAssistance: true,
      });
      expect(orderCalls(merchant)).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it('does not follow a redirect with the key', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      const before = fake.requestsTo(merchant.store).length;
      merchant.store.redirectTo = 'https://elsewhere.example.com/';

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_unreachable',
      });
      expect(fake.requestsTo(merchant.store).slice(before)).toEqual([
        expect.objectContaining({ answered: 301 }),
      ]);
    });
  });

  describe('a source that is not connected', () => {
    it('an inactive source gets no request, and the local result is kept', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      await client`
        UPDATE integrations SET is_active = false WHERE id = ${merchant.integrationId}`;

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      });
      expect(orderCalls(merchant)).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
      expect(remote(merchant, order).status).toBe('processing');
      expect(await localStatus(order)).toBe('canceled');
    });

    it('a retry queued before the source went inactive makes no request and ends failed', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.failNext('order_read', 500);
      await dispatch(merchant, order, 'customer_confirmation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });
      expect(scheduled).toHaveLength(1);
      const callsBefore = orderCalls(merchant).length;
      await client`
        UPDATE integrations SET is_active = false WHERE id = ${merchant.integrationId}`;

      await runRetries();

      expect(orderCalls(merchant)).toHaveLength(callsBefore);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'integration_inactive',
      });
      expect(remote(merchant, order).meta_data).toHaveLength(0);
      expect(await localStatus(order)).toBe('confirmed');
    });

    it('a source whose connection row is gone gets no request', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await client`
        DELETE FROM woocommerce_connections WHERE integration_id = ${merchant.integrationId}`;

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'connection_missing',
      });
      expect(orderCalls(merchant)).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });
  });

  describe('a disconnected source (US-07-05)', () => {
    const disconnect = (target: Merchant) =>
      auth.disconnect({
        userId: randomUUID(),
        orgId: target.orgId,
        role: 'owner',
        source: 'supabase',
      });

    it('closes a store update that was waiting to retry, at the disconnect, without a request', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      merchant.store.failNext('order_read', 500);
      await dispatch(merchant, order, 'customer_confirmation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });
      expect(scheduled).toHaveLength(1);
      const callsBefore = orderCalls(merchant).length;

      await disconnect(merchant);

      // Closed now, not when its job runs: a lost job cannot leave it waiting.
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'integration_inactive',
      });
      await runRetries();
      expect(orderCalls(merchant)).toHaveLength(callsBefore);
      expect(remote(merchant, order).meta_data).toHaveLength(0);
      // The local decision is history and is kept.
      expect(await localStatus(order)).toBe('confirmed');
    });

    it('records a reply that arrives afterwards and writes nothing to the store', async () => {
      const order = await orderWith(merchant, { status: 'pending' });
      await disconnect(merchant);
      await client`
        UPDATE verifications SET status = 'canceled' WHERE id = ${order.verificationId}`;
      const callsBefore = orderCalls(merchant).length;

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      });
      expect(orderCalls(merchant)).toHaveLength(callsBefore);
      expect(scheduled).toHaveLength(0);
      expect(remote(merchant, order).status).toBe('processing');
      expect(await localStatus(order)).toBe('canceled');
    });

    it('the adapter itself refuses a disconnected connection, whatever the registry was told', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await disconnect(merchant);
      const callsBefore = orderCalls(merchant).length;

      // A disconnect landing between the registry's check and the adapter.
      const result = await adapter.execute({
        orgId: merchant.orgId,
        integrationId: merchant.integrationId,
        externalOrderId: order.externalOrderId,
        action: 'customer_confirmation',
        correlationId: order.verificationId,
        connection: {} as CommerceOutcomeAdapterRequest['connection'],
      });

      expect(result).toEqual({
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      });
      expect(orderCalls(merchant)).toHaveLength(callsBefore);
    });

    it('closes only its own waiting rows', async () => {
      const other = await connectMerchant();
      const theirs = await orderWith(other, { status: 'confirmed' });
      other.store.failNext('order_read', 500);
      await dispatch(other, theirs, 'customer_confirmation');
      expect((await syncsOf(theirs))[0]).toMatchObject({ state: 'pending' });

      await disconnect(merchant);

      expect((await syncsOf(theirs))[0]).toMatchObject({ state: 'pending' });
      await runRetries();
      expect((await syncsOf(theirs))[0]).toMatchObject({ state: 'succeeded' });
      expect(remote(other, theirs).meta_data).toHaveLength(1);
    });

    it('keeps what was already written and recorded', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');
      const [before] = await syncsOf(order);
      expect(before).toMatchObject({ state: 'succeeded' });

      await disconnect(merchant);

      expect(await syncsOf(order)).toEqual([before]);
      expect(await localStatus(order)).toBe('confirmed');
      expect(await verificationCount(merchant)).toBe(1);
    });
  });

  describe('order.updated feedback loop', () => {
    it('recognizes its own confirmation coming back and does nothing', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');
      const callsAfterWrite = orderCalls(merchant).length;
      const [before] = await syncsOf(order);

      // The store reflects the change, and reflects it a second time.
      await deliverUpdate(merchant, order);
      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
      ]);
      expect(orderCalls(merchant)).toHaveLength(callsAfterWrite);
      expect(scheduled).toHaveLength(0);
      expect(await syncsOf(order)).toEqual([before]);
      expect(await localStatus(order)).toBe('confirmed');
      expect(await verificationCount(merchant)).toBe(1);
      expect(sends).toHaveLength(1);
      expect(remote(merchant, order).notes).toHaveLength(1);
    });

    it.each<CommerceOutcomeAction>([
      'customer_cancellation',
      'merchant_no_reply_cancellation',
    ])('recognizes its own %s coming back and does nothing', async (action) => {
      const order = await orderWith(merchant, { status: 'canceled' });
      await dispatch(merchant, order, action);
      const callsAfterWrite = orderCalls(merchant).length;

      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
      ]);
      expect(orderCalls(merchant)).toHaveLength(callsAfterWrite);
      expect(await localStatus(order)).toBe('canceled');
      expect(await verificationCount(merchant)).toBe(1);
      expect(sends).toHaveLength(1);
      expect(remote(merchant, order).status).toBe('cancelled');
    });

    it('recognizes the echo of a write whose answer never arrived', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      merchant.store.loseNext('order_write', { when: 'after', how: 'timeout' });
      merchant.store.loseNext(
        'order_read',
        { when: 'before', how: 'reset' },
        1,
      );
      await dispatch(merchant, order, 'customer_cancellation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });

      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
      ]);
      expect(writesOf(merchant)).toHaveLength(1);
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });
    });

    it('only records the merchant completing an order Akeed confirmed', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');
      const callsAfterWrite = orderCalls(merchant).length;
      // The marker is still on the order when the merchant moves it on.
      merchant.store.setOrderStatus(order.remoteId, 'completed');

      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'remote_status_observed' },
      ]);
      expect(orderCalls(merchant)).toHaveLength(callsAfterWrite);
      expect(await localStatus(order)).toBe('confirmed');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
      expect(await verificationCount(merchant)).toBe(1);
    });

    it('only records the merchant reopening an order Akeed cancelled', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      await dispatch(merchant, order, 'customer_cancellation');
      await deliverUpdate(merchant, order);
      merchant.store.setOrderStatus(order.remoteId, 'processing');

      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
        { status: 'skipped', last_error: 'remote_status_observed' },
      ]);
      expect(writesOf(merchant)).toHaveLength(1);
      expect(await localStatus(order)).toBe('canceled');
      // A placed order coming back does not start a second verification.
      expect(await verificationCount(merchant)).toBe(1);
      expect(sends).toHaveLength(1);
    });

    it('only records a cancellation the merchant made before any reply', async () => {
      const order = await orderWith(merchant, { status: 'pending' });
      merchant.store.setOrderStatus(order.remoteId, 'cancelled');

      await deliverUpdate(merchant, order);

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'remote_status_observed' },
      ]);
      expect(orderCalls(merchant)).toHaveLength(0);
      expect(await localStatus(order)).toBe('pending');
      expect(await syncsOf(order)).toHaveLength(0);
      expect(await verificationCount(merchant)).toBe(1);
    });

    it('takes no marker a store invents as an outcome of its own', async () => {
      const order = await orderWith(merchant, { status: 'pending' });
      const forged = {
        ...merchant.store.orderBody(order.remoteId),
        status: 'cancelled',
        meta_data: [
          {
            id: 1,
            key: 'akeed_outcome',
            value: markerOf('customer_cancellation', order),
          },
        ],
      };

      expect(await deliver(merchant, forged, 'order.updated')).toBe(200);
      await drain();

      expect(await updateEventsOf(merchant, order)).toEqual([
        { status: 'skipped', last_error: 'remote_status_observed' },
      ]);
      expect(await localStatus(order)).toBe('pending');
    });

    it('changes nothing for another tenant’s order on this tenant’s token', async () => {
      const other = await connectMerchant();
      const theirs = await orderWith(other, { status: 'canceled' });
      await dispatch(other, theirs, 'customer_cancellation');
      const [before] = await syncsOf(theirs);
      // This tenant has an event for the same order id, and no order: its
      // source was not ready when the order arrived.
      const unready = await connectMerchant({ onboarding: 'pending' });
      expect(
        await deliver(
          unready,
          { ...other.store.orderBody(theirs.remoteId), status: 'processing' },
          'order.created',
        ),
      ).toBe(200);
      await drain();

      // Tenant B's cancelled order, marker and all, on this tenant's token.
      expect(
        await deliver(
          unready,
          other.store.orderBody(theirs.remoteId),
          'order.updated',
        ),
      ).toBe(200);
      await drain();

      expect(await updateEventsOf(unready, theirs)).toEqual([
        { status: 'skipped', last_error: 'order_not_owned' },
      ]);
      expect(await updateEventsOf(other, theirs)).toHaveLength(0);
      expect(await syncsOf(theirs)).toEqual([before]);
      expect(await localStatus(theirs)).toBe('canceled');
      expect(await verificationCount(unready)).toBe(0);
      expect(
        fake
          .requestsTo(unready.store)
          .filter((request) => ORDER_ROUTES.has(request.route)),
      ).toHaveLength(0);
    });
  });

  describe('secrets and customer data', () => {
    it('puts no customer data in what it writes to the store', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');

      const written = JSON.stringify(
        orderCalls(merchant).map((request) => request.body ?? null),
      );
      const { billing: customer } = placedCodFixture().payload;

      for (const value of [
        customer.phone,
        customer.first_name,
        customer.last_name,
        '+201000000000',
      ])
        expect(written).not.toContain(value);
    });

    it('never logs, returns or stores a key, a token or a secret', async () => {
      const rows = await client<Record<string, unknown>[]>`
        SELECT * FROM commerce_outcome_syncs`;
      const stored = await client<Record<string, unknown>[]>`
        SELECT raw_payload, last_error FROM webhook_events`;
      const haystack = [
        ...logs,
        JSON.stringify(answers),
        JSON.stringify(rows),
        JSON.stringify(stored),
      ].join('\n');

      expect(rows.length).toBeGreaterThan(0);
      expect(logs.length).toBeGreaterThan(0);
      expect(secrets.size).toBeGreaterThan(0);
      for (const value of secrets) expect(haystack).not.toContain(value);
    });
  });
});
