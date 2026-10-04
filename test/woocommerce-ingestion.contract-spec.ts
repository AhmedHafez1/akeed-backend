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
import { StandaloneOutcomeAdapter } from '../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import { WooCommerceApiClient } from '../src/infrastructure/spokes/woocommerce/woocommerce-api.client';
import { WooCommerceAuthService } from '../src/infrastructure/spokes/woocommerce/woocommerce-auth.service';
import { hashInstallToken } from '../src/infrastructure/spokes/woocommerce/woocommerce-install-token';
import { WooCommerceOrderEligibilityStrategy } from '../src/infrastructure/spokes/woocommerce/woocommerce-order-eligibility.strategy';
import { WooCommerceOrderNormalizer } from '../src/infrastructure/spokes/woocommerce/woocommerce-order.normalizer';
import {
  WooCommerceWebhookService,
  type WooCommerceDeliveryHeaders,
} from '../src/infrastructure/spokes/woocommerce/woocommerce-webhook.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { ShopifyOrderNormalizer } from '../src/modules/webhook-queue/normalizers/shopify-order.normalizer';
import { StandaloneManualOrderNormalizer } from '../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../src/shared/config/woocommerce.config';
import { createRestrictedHttp } from '../src/shared/http/restricted-http';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { PhoneService } from '../src/shared/services/phone.service';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import {
  FakeWooCommerce,
  type FakeWooCommerceStore,
} from './contracts/woocommerce-provider-fake';
import {
  checkoutDraftFixture,
  orderUpdatedFixture,
  pingFixture,
  placedCodFixture,
  placedNonCodFixture,
  type WooCommerceOrderFixture,
} from './fixtures/woocommerce/load';

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

const namespace = `e07_ingestion_${randomUUID().replaceAll('-', '')}`;
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

const settings: WooCommerceConfig & { pilotOrgIds: string[] } = {
  enabled: true,
  ingestionEnabled: true,
  outcomeSyncEnabled: false,
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
const responses: unknown[] = [];
/** Errors answered as 500, kept so a test can say which one it expected. */
const failures: Error[] = [];

// --- Real repositories and services; only the edges are fakes. ---

const connections = new WooCommerceConnectionsRepository(db);
const events = new WebhookEventsRepository(db);
const integrations = new IntegrationsRepository(db as never, coreConfig);
const ordersRepo = new OrdersRepository(db);
const verificationsRepo = new VerificationsRepository(db);
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

interface RecordedSend {
  to: string;
  verificationId: string;
  orderNumber: string;
  totalPrice: string;
}
const sends: RecordedSend[] = [];
const messaging: MessagingPort = {
  sendVerificationTemplate(params) {
    sends.push({
      to: params.to,
      verificationId: params.verificationId,
      orderNumber: params.orderNumber,
      totalPrice: params.totalPrice,
    });
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
const hub = new VerificationHubService(
  ordersRepo,
  verificationsRepo,
  new CommerceOutcomeRegistryService(ordersRepo, [
    new StandaloneOutcomeAdapter(),
  ]),
  // The registry as the application binds it: every strategy, by platform.
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

const phones = new PhoneService();
// No WooCommerce order-update handler yet: handling an update is US-07-04.
const processor = new WebhookQueueProcessor(
  [
    new ShopifyOrderNormalizer(phones),
    new StandaloneManualOrderNormalizer(),
    new WooCommerceOrderNormalizer(connections, phones),
  ],
  events,
  integrations,
  hub,
);

/** Jobs BullMQ would have received; `drain` runs them in order. */
const queued: WebhookJobPayload[] = [];
const queue = { down: false };
const dispatcher = new WebhookDispatchService(
  {
    add: (_name: string, payload: WebhookJobPayload) => {
      if (queue.down) return Promise.reject(new Error('redis unavailable'));
      queued.push(payload);
      return Promise.resolve();
    },
  } as never,
  events,
  { get: () => undefined } as never,
);
const producer = new WebhookQueueProducer(events, integrations, dispatcher);
const webhooks = new WooCommerceWebhookService(
  connections,
  events,
  producer,
  wooCommerceConfig,
);

// The fake is the DNS and the transport of the real restricted client: no
// request leaves the process, and ingestion itself never calls a store.
const fake = new FakeWooCommerce();
const auth = new WooCommerceAuthService(
  connections,
  new WooCommerceApiClient(
    createRestrictedHttp({ lookup: fake.lookup, transport: fake.transport }),
  ),
  wooCommerceConfig,
);

async function runJob(payload: WebhookJobPayload): Promise<'done' | 'failed'> {
  const job = {
    id: `job-${payload.webhookEventId}`,
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as unknown as Job<WebhookJobPayload>;
  try {
    await processor.process(job, 'lock-token');
    return 'done';
  } catch (error) {
    // What the worker's `failed` event does before BullMQ backs off.
    await processor.onFailed(
      { ...job, attemptsMade: 1 } as Job<WebhookJobPayload>,
      error as Error,
    );
    return 'failed';
  }
}

async function drain(): Promise<string[]> {
  const ends: string[] = [];
  while (queued.length > 0) ends.push(await runJob(queued.shift()!));
  return ends;
}

// --- Tenants ---

interface Merchant {
  orgId: string;
  integrationId: string;
  store: FakeWooCommerceStore;
  webhookToken: string;
  webhookSecret: string;
}

interface MerchantOptions {
  /** A store in a subdirectory, as `/shop`. */
  path?: string;
  /**
   * When the source connected. The fixtures are dated 2026-01-01, so by
   * default the connection is moved before them; `as-connected` leaves the
   * moment the callback stored.
   */
  connectedAt?: string;
  onboarding?: 'completed' | 'pending';
}

function track(value: string): string {
  secrets.add(value);
  return value;
}

async function createOrganization(): Promise<{
  orgId: string;
  owner: AuthenticatedUser;
}> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${`Store ${randomUUID().slice(0, 8)}`}, ${`org-${randomUUID()}`})
    RETURNING id`;
  settings.pilotOrgIds.push(organization.id);
  return {
    orgId: organization.id,
    owner: {
      userId: randomUUID(),
      orgId: organization.id,
      role: 'owner',
      source: 'supabase',
    },
  };
}

/** Connects a store the way a merchant does: start, approve, callback. */
async function connectMerchant(
  options: MerchantOptions = {},
): Promise<Merchant> {
  const { orgId, owner } = await createOrganization();
  const store = fake.addStore(options.path ?? '');
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

  // The store holds what Akeed registered: the delivery URL and the secret.
  const [webhook] = [...store.webhooks.values()];
  const [integration] = await client<{ id: string }[]>`
    UPDATE integrations
    SET onboarding_status = ${options.onboarding ?? 'completed'}
    WHERE org_id = ${orgId}
    RETURNING id`;
  if (options.connectedAt !== 'as-connected')
    await client`
      UPDATE woocommerce_connections
      SET connected_at = ${options.connectedAt ?? BEFORE_FIXTURES}
      WHERE integration_id = ${integration.id}`;
  return {
    orgId,
    integrationId: integration.id,
    store,
    webhookToken: track(webhook.delivery_url.split('/').pop()!),
    webhookSecret: track(webhook.secret),
  };
}

interface Answer {
  status: number;
  code?: string;
}

async function answer(promise: Promise<unknown>): Promise<Answer> {
  try {
    responses.push(await promise);
    return { status: 200 };
  } catch (error) {
    // What the global exception filter answers for anything else.
    if (!(error instanceof HttpException)) {
      failures.push(error as Error);
      return { status: 500 };
    }
    const body = error.getResponse() as { code?: string };
    responses.push(body);
    return { status: error.getStatus(), code: body.code };
  }
}

function sign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

interface DeliveryOptions {
  topic?: string;
  token?: string;
  /** The secret the body is signed with. */
  secret?: string;
  /** Header overrides; `undefined` removes one. */
  headers?: WooCommerceDeliveryHeaders;
  /** Sent instead of the signed bytes. */
  sentBody?: Buffer;
}

/**
 * A delivery as the store sends it: the order as JSON bytes, their signature
 * with the secret Akeed gave the store, and the store's own address.
 */
function deliver(
  merchant: Merchant,
  order: unknown,
  options: DeliveryOptions = {},
): Promise<Answer> {
  const body = Buffer.isBuffer(order)
    ? order
    : Buffer.from(JSON.stringify(order), 'utf8');
  const fixture = placedCodFixture().headers;
  return answer(
    webhooks.handleDelivery(
      options.token ?? merchant.webhookToken,
      {
        topic: options.topic ?? 'order.created',
        signature: sign(body, options.secret ?? merchant.webhookSecret),
        source: `${merchant.store.url}/`,
        webhookId: fixture['X-WC-Webhook-ID'],
        deliveryId: `synthetic-delivery-${randomUUID().slice(0, 8)}`,
        ...options.headers,
      },
      options.sentBody ?? body,
    ),
  );
}

/** The placed cash-on-delivery fixture, with a test's own changes. */
function placed(
  overrides: Record<string, unknown> = {},
  billing: Record<string, unknown> = {},
): WooCommerceOrderFixture {
  const order = placedCodFixture().payload;
  return { ...order, ...overrides, billing: { ...order.billing, ...billing } };
}

interface EventRow {
  id: string;
  platform: string;
  job_type: string;
  status: string;
  last_error: string | null;
  org_id: string | null;
  integration_id: string | null;
  order_id: string | null;
  store_domain: string;
  idempotency_key: string;
  raw_payload: Record<string, unknown>;
  dispatch_required: boolean;
  dispatched_at: Date | null;
  last_dispatch_error: string | null;
}

function eventsOf(merchant: Merchant) {
  return client<EventRow[]>`
    SELECT * FROM webhook_events
    WHERE integration_id = ${merchant.integrationId}
    ORDER BY received_at, created_at, id`;
}

function ordersOf(merchant: Merchant) {
  return client<
    {
      id: string;
      org_id: string;
      external_order_id: string;
      order_number: string | null;
      customer_phone: string;
      customer_name: string | null;
      total_price: string;
      currency: string;
      payment_method: string | null;
      raw_payload: Record<string, unknown> | null;
    }[]
  >`SELECT * FROM orders WHERE integration_id = ${merchant.integrationId} ORDER BY created_at`;
}

function verificationsOf(merchant: Merchant) {
  return client<{ id: string; order_id: string; status: string }[]>`
    SELECT * FROM verifications WHERE org_id = ${merchant.orgId} ORDER BY created_at`;
}

async function rejectedDeliveriesOf(merchant: Merchant): Promise<number> {
  const [row] = await client<{ rejected_deliveries: number }[]>`
    SELECT rejected_deliveries FROM woocommerce_connections
    WHERE integration_id = ${merchant.integrationId}`;
  return row.rejected_deliveries;
}

async function totalEvents(): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM webhook_events`;
  return row.count;
}

async function expectNothingStored(before: number) {
  expect(await totalEvents()).toBe(before);
  expect(queued).toHaveLength(0);
}

// --- Schema: the Drizzle tables, then the real WooCommerce migration. ---

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

describe('WooCommerce webhook ingestion PostgreSQL contract (US-07-03)', () => {
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
    ])
      await migrate(name);
    // This story adds no migration: it runs on the US-07-02 tables as they
    // are. Applied twice, as every suite that uses it does.
    for (let pass = 0; pass < 2; pass++)
      await migrate('0051_woocommerce_connection.sql');
    // Fault injection for the database-failure case: while the flag row says
    // so, no event can be written.
    await client.unsafe(`
      CREATE TABLE fault_switch (fail boolean NOT NULL);
      INSERT INTO fault_switch VALUES (false);
      CREATE FUNCTION fail_event_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (SELECT fail FROM fault_switch) THEN
          RAISE EXCEPTION 'injected event insert failure';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER webhook_events_fault BEFORE INSERT ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION fail_event_insert();
    `);
  });

  afterAll(async () => {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(() => {
    queued.length = 0;
    queue.down = false;
    settings.ingestionEnabled = true;
    sends.length = 0;
    failures.length = 0;
  });

  afterEach(() => {
    // Only the database-failure case answers 500, and it clears its own.
    expect(failures.map((failure) => failure.message)).toEqual([]);
  });

  describe('a cash-on-delivery order', () => {
    it('becomes one order and one verification, sent once from the Akeed sender', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();
      const requestsBefore = fake.requestsTo(merchant.store).length;

      const ack = await deliver(merchant, payload);
      const ends = await drain();

      expect(ack).toEqual({ status: 200 });
      expect(ends).toEqual(['done']);
      const [event, ...otherEvents] = await eventsOf(merchant);
      expect(otherEvents).toHaveLength(0);
      expect(event).toMatchObject({
        platform: 'woocommerce',
        job_type: 'order.create',
        status: 'completed',
        org_id: merchant.orgId,
        store_domain: `woocommerce:${merchant.orgId}`,
        idempotency_key: `order.create:${merchant.integrationId}:1001`,
      });
      const [order, ...otherOrders] = await ordersOf(merchant);
      expect(otherOrders).toHaveLength(0);
      expect(order).toMatchObject({
        org_id: merchant.orgId,
        external_order_id: '1001',
        order_number: '1001',
        customer_phone: '+201000000000',
        customer_name: 'Test Customer',
        total_price: '450.00',
        currency: 'EGP',
        payment_method: 'cod',
      });
      expect(event.order_id).toBe(order.id);
      const verifications = await verificationsOf(merchant);
      expect(verifications).toHaveLength(1);
      expect(verifications[0].order_id).toBe(order.id);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        to: '+201000000000',
        verificationId: verifications[0].id,
        orderNumber: '1001',
      });
      expect(sends[0].totalPrice).toContain('450');
      // No order lookup: ingestion never calls the store.
      expect(fake.requestsTo(merchant.store)).toHaveLength(requestsBefore);
    });

    it('starts an on-hold order and one delivered by order.updated first', async () => {
      const merchant = await connectMerchant();

      await deliver(merchant, placed({ id: 2001, status: 'on-hold' }));
      await deliver(merchant, placed({ id: 2002 }), { topic: 'order.updated' });
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { job_type: 'order.create', status: 'completed' },
        { job_type: 'order.create', status: 'completed' },
      ]);
      expect(await verificationsOf(merchant)).toHaveLength(2);
      expect(sends).toHaveLength(2);
    });

    it('takes the currency, the total and the phone country from the order', async () => {
      const merchant = await connectMerchant();

      await deliver(
        merchant,
        placed(
          { currency: 'SAR', total: '129.50' },
          { phone: '0512345678', country: 'SA' },
        ),
      );
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        {
          currency: 'SAR',
          total_price: '129.50',
          customer_phone: '+966512345678',
        },
      ]);
    });

    it('keeps an international number as given, whatever the billing country', async () => {
      const merchant = await connectMerchant();

      await deliver(merchant, placed({}, { phone: '+966512345678' }));
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        { customer_phone: '+966512345678' },
      ]);
    });

    it('accepts a store in a subdirectory by its own address', async () => {
      const merchant = await connectMerchant({ path: '/shop' });

      const inside = await deliver(merchant, placedCodFixture().payload);
      const root = await deliver(merchant, placed({ id: 2003 }), {
        headers: { source: `https://${merchant.store.host}/` },
      });
      await drain();

      expect(inside).toEqual({ status: 200 });
      expect(root).toEqual({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      expect(await ordersOf(merchant)).toHaveLength(1);
    });
  });

  describe('orders that must not be sent', () => {
    it.each([
      [
        'a bank-transfer order',
        () => placedNonCodFixture().payload,
        'non_cod_payment_method',
      ],
      [
        'a custom gateway',
        () => placed({ payment_method: 'cod_plus' }),
        'non_cod_payment_method',
      ],
      [
        'an order without a payment method',
        () => placed({ payment_method: '' }),
        'missing_payment_signal',
      ],
      [
        'a pending order',
        () => placed({ status: 'pending' }),
        'order_not_placed',
      ],
      [
        'a custom status',
        () => placed({ status: 'packed' }),
        'order_not_placed',
      ],
      [
        'a missing currency',
        () => placed({ currency: '' }),
        'missing_currency',
      ],
      [
        'a phone that does not parse',
        () => placed({}, { phone: '12345' }),
        'invalid_phone',
      ],
      [
        'a local phone without a billing country',
        () => placed({}, { country: '' }),
        'missing_phone_country',
      ],
      ['no phone', () => placed({}, { phone: '' }), 'incomplete_payload'],
      ['a zero total', () => placed({ total: '0.00' }), 'invalid_amount'],
    ])('records %s and creates nothing', async (_label, order, reason) => {
      const merchant = await connectMerchant();

      const ack = await deliver(merchant, order());
      await drain();

      expect(ack).toEqual({ status: 200 });
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: reason, order_id: null },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(await verificationsOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('accepts an order for a source that is not ready, and sends nothing', async () => {
      const merchant = await connectMerchant({ onboarding: 'pending' });

      const ack = await deliver(merchant, placedCodFixture().payload);
      await drain();

      expect(ack).toEqual({ status: 200 });
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'onboarding_incomplete' },
      ]);
      expect(await verificationsOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('records an order for a source switched off without a disconnect, and sends nothing', async () => {
      const merchant = await connectMerchant();
      await client`
        UPDATE integrations SET is_active = false
        WHERE id = ${merchant.integrationId}`;

      const ack = await deliver(merchant, placedCodFixture().payload);
      await drain();

      // Not a refusal: a pause on Akeed's side must not disable the store's
      // webhooks (finding 3.11).
      expect(ack).toEqual({ status: 200 });
      expect(await rejectedDeliveriesOf(merchant)).toBe(0);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'integration_inactive' },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });
  });

  describe('an order older than the connection', () => {
    it('starts nothing, on either topic', async () => {
      // Connected one second after the fixture order was created.
      const merchant = await connectMerchant({
        connectedAt: '2026-01-01T10:00:01.000Z',
      });
      const { payload } = placedCodFixture();

      const created = await deliver(merchant, payload);
      const updated = await deliver(
        merchant,
        { ...payload, date_modified_gmt: '2026-01-03T09:00:00' },
        { topic: 'order.updated' },
      );
      await drain();

      expect([created, updated]).toEqual([{ status: 200 }, { status: 200 }]);
      expect(await eventsOf(merchant)).toMatchObject([
        {
          job_type: 'order.create',
          status: 'skipped',
          last_error: 'order_predates_connection',
          idempotency_key: `order.skip:${merchant.integrationId}:1001:processing:2026-01-01T10:01:00`,
        },
        {
          job_type: 'order.create',
          status: 'skipped',
          last_error: 'order_predates_connection',
          idempotency_key: `order.skip:${merchant.integrationId}:1001:processing:2026-01-03T09:00:00`,
        },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(await verificationsOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('starts an order created in the second the source connected', async () => {
      const merchant = await connectMerchant({
        connectedAt: '2026-01-01T10:00:00.750Z',
      });

      await deliver(merchant, placedCodFixture().payload);
      await drain();

      expect(await verificationsOf(merchant)).toHaveLength(1);
    });

    it('starts nothing for an order whose creation date cannot be read', async () => {
      const merchant = await connectMerchant();

      await deliver(merchant, placed({ date_created_gmt: null }));
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'order_predates_connection' },
      ]);
      expect(sends).toHaveLength(0);
    });

    it('compares against the moment the callback stored: the 2026-01-01 fixtures start nothing on a connection made now', async () => {
      const merchant = await connectMerchant({ connectedAt: 'as-connected' });

      await deliver(merchant, placedCodFixture().payload);
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'order_predates_connection' },
      ]);
    });
  });

  describe('draft, placed, updated', () => {
    it('a checkout draft then the placed order give one verification', async () => {
      const merchant = await connectMerchant();

      const draft = await deliver(merchant, checkoutDraftFixture().payload);
      await drain();
      expect(await verificationsOf(merchant)).toHaveLength(0);
      const placedAck = await deliver(merchant, placedCodFixture().payload);
      await drain();

      expect([draft, placedAck]).toEqual([{ status: 200 }, { status: 200 }]);
      expect(await eventsOf(merchant)).toMatchObject([
        {
          job_type: 'order.create',
          status: 'skipped',
          last_error: 'order_not_placed',
          idempotency_key: `order.skip:${merchant.integrationId}:1001:checkout-draft:2026-01-01T10:00:00`,
        },
        {
          job_type: 'order.create',
          status: 'completed',
          idempotency_key: `order.create:${merchant.integrationId}:1001`,
        },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('a draft delivered again and again never becomes an order', async () => {
      const merchant = await connectMerchant();
      const { payload } = checkoutDraftFixture();

      for (const topic of ['order.created', 'order.updated', 'order.updated'])
        await deliver(merchant, payload, { topic });
      await drain();

      // The same state is one skipped event.
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'order_not_placed' },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
    });

    it('order.created and order.updated arriving together give one', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();

      const acks = await Promise.all([
        deliver(merchant, payload, { topic: 'order.created' }),
        deliver(merchant, payload, { topic: 'order.updated' }),
      ]);
      await drain();

      expect(acks).toEqual([{ status: 200 }, { status: 200 }]);
      const stored = await eventsOf(merchant);
      expect(
        stored.filter((event) => event.job_type === 'order.create'),
      ).toMatchObject([
        { idempotency_key: `order.create:${merchant.integrationId}:1001` },
      ]);
      // The second is a duplicate of the first, or an update recorded after it.
      expect(stored.length).toBeLessThanOrEqual(2);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('order.updated before order.created gives one, whichever comes first', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();

      await deliver(merchant, payload, { topic: 'order.updated' });
      await drain();
      await deliver(merchant, payload, { topic: 'order.created' });
      await drain();

      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('records a later update of an order Akeed has, and starts nothing', async () => {
      const merchant = await connectMerchant();
      await deliver(merchant, placedCodFixture().payload);
      await drain();

      const ack = await deliver(merchant, orderUpdatedFixture().payload, {
        topic: 'order.updated',
      });
      await drain();

      expect(ack).toEqual({ status: 200 });
      expect(await eventsOf(merchant)).toMatchObject([
        { job_type: 'order.create', status: 'completed' },
        {
          job_type: 'order.update',
          // Recorded only: acting on a store-side change is US-07-04.
          status: 'skipped',
          last_error: 'unhandled_job_type:order.update',
          idempotency_key: `order.update:${merchant.integrationId}:1001:completed:2026-01-02T07:30:00`,
          order_id: null,
        },
      ]);
      expect(await ordersOf(merchant)).toMatchObject([
        { total_price: '450.00', customer_phone: '+201000000000' },
      ]);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('does not turn a changed redelivery into an order edit', async () => {
      const merchant = await connectMerchant();
      await deliver(merchant, placedCodFixture().payload);
      await drain();

      await deliver(
        merchant,
        placed({ total: '1.00' }, { phone: '01111111111' }),
      );
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        { total_price: '450.00', customer_phone: '+201000000000' },
      ]);
      expect(sends).toHaveLength(1);
    });
  });

  describe('duplicate and concurrent deliveries', () => {
    it('collapses repeated deliveries into one order and one verification', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();

      // Sent again before the first was processed. Each has its own delivery
      // id, which is not what identifies the event.
      const acks = [
        await deliver(merchant, payload),
        await deliver(merchant, payload),
        await deliver(merchant, payload),
        await deliver(merchant, payload),
      ];
      await drain();

      expect(acks.every((ack) => ack.status === 200)).toBe(true);
      // One create event. The order is known from then on, so the repeats are
      // one recorded update between them; a repeat of that stores nothing new.
      expect(await eventsOf(merchant)).toMatchObject([
        {
          job_type: 'order.create',
          status: 'completed',
          idempotency_key: `order.create:${merchant.integrationId}:1001`,
        },
        {
          job_type: 'order.update',
          status: 'skipped',
          idempotency_key: `order.update:${merchant.integrationId}:1001:processing:2026-01-01T10:01:00`,
        },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('collapses concurrent deliveries of one order', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();

      const acks = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          deliver(merchant, payload, {
            topic: index % 2 ? 'order.updated' : 'order.created',
          }),
        ),
      );
      await drain();

      expect(acks.every((ack) => ack.status === 200)).toBe(true);
      const stored = await eventsOf(merchant);
      expect(
        stored.filter((event) => event.job_type === 'order.create'),
      ).toHaveLength(1);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('keeps X-WC-Webhook-Delivery-ID for audit and never as the key', async () => {
      const merchant = await connectMerchant();
      const { payload, headers } = placedCodFixture();

      await deliver(merchant, payload, {
        headers: {
          webhookId: headers['X-WC-Webhook-ID'],
          deliveryId: headers['X-WC-Webhook-Delivery-ID'],
        },
      });
      // The same delivery id on another order is another event.
      await deliver(merchant, placed({ id: 2010 }), {
        headers: { deliveryId: headers['X-WC-Webhook-Delivery-ID'] },
      });

      const stored = await eventsOf(merchant);
      expect(stored).toHaveLength(2);
      expect(stored[0].raw_payload).toMatchObject({
        topic: 'order.created',
        webhookId: '9001',
        deliveryId: 'synthetic-delivery-0002',
      });
      for (const event of stored)
        expect(event.idempotency_key).not.toContain('synthetic-delivery');
    });
  });

  describe('authentication', () => {
    it.each([
      [
        'a wrong signature',
        (): DeliveryOptions => ({
          secret: randomBytes(32).toString('base64url'),
        }),
        1,
      ],
      [
        'no signature',
        (): DeliveryOptions => ({ headers: { signature: undefined } }),
        1,
      ],
      [
        'a signature that is not base64',
        (): DeliveryOptions => ({ headers: { signature: 'not a signature' } }),
        1,
      ],
      [
        'no source header',
        (): DeliveryOptions => ({ headers: { source: undefined } }),
        1,
      ],
      [
        'another store as the source',
        (): DeliveryOptions => ({
          headers: { source: 'https://other.example.com/' },
        }),
        1,
      ],
      [
        'an unknown URL token',
        (): DeliveryOptions => ({
          token: randomBytes(32).toString('base64url'),
        }),
        0,
      ],
      [
        'a malformed URL token',
        (): DeliveryOptions => ({ token: 'not-a-token' }),
        0,
      ],
      ['an empty URL token', (): DeliveryOptions => ({ token: '' }), 0],
    ])(
      'answers %s with one 401 and stores nothing',
      async (_label, options, counted) => {
        const merchant = await connectMerchant();
        const before = await totalEvents();

        const ack = await deliver(
          merchant,
          placedCodFixture().payload,
          options(),
        );

        expect(ack).toEqual({
          status: 401,
          code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
        });
        await expectNothingStored(before);
        // Counted only when the token was valid.
        expect(await rejectedDeliveriesOf(merchant)).toBe(counted);
      },
    );

    it('refuses the store over plain HTTP as the source', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliver(merchant, placedCodFixture().payload, {
        headers: { source: `http://${merchant.store.host}/` },
      });

      expect(ack.status).toBe(401);
      await expectNothingStored(before);
    });

    it('refuses bytes altered after they were signed', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();
      const signed = Buffer.from(
        JSON.stringify(placedCodFixture().payload),
        'utf8',
      );
      const altered = Buffer.from(
        signed.toString('utf8').replace('"450.00"', '"950.00"'),
        'utf8',
      );

      const ack = await deliver(merchant, signed, { sentBody: altered });

      expect(altered.equals(signed)).toBe(false);
      expect(ack).toEqual({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      await expectNothingStored(before);
      expect(await rejectedDeliveriesOf(merchant)).toBe(1);
    });

    it('counts refused deliveries so a changed secret is visible', async () => {
      const merchant = await connectMerchant();

      for (let attempt = 0; attempt < 3; attempt++)
        await deliver(merchant, placedCodFixture().payload, {
          secret: 'changed-in-the-store',
        });

      expect(await rejectedDeliveriesOf(merchant)).toBe(3);
      const [row] = await client<{ last_rejected_at: Date | null }[]>`
        SELECT last_rejected_at FROM woocommerce_connections
        WHERE integration_id = ${merchant.integrationId}`;
      expect(row.last_rejected_at).not.toBeNull();
      // A valid delivery still gets through afterwards.
      await expect(
        deliver(merchant, placedCodFixture().payload),
      ).resolves.toEqual({ status: 200 });
    });

    it('stops accepting a token after it is rotated', async () => {
      const merchant = await connectMerchant();
      const rotated = track(randomBytes(32).toString('base64url'));
      await client`
        UPDATE woocommerce_connections
        SET webhook_token_hash = ${hashInstallToken(rotated)}
        WHERE integration_id = ${merchant.integrationId}`;
      const before = await totalEvents();

      const old = await deliver(merchant, placedCodFixture().payload);
      await expectNothingStored(before);
      const current = await deliver(merchant, placedCodFixture().payload, {
        token: rotated,
      });

      expect(old).toEqual({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      expect(current).toEqual({ status: 200 });
    });

    it('does not accept the install callback token as a delivery token', async () => {
      const { owner } = await createOrganization();
      const store = fake.addStore();
      const started = await auth.startInstall(owner, {
        storeUrl: store.url,
        locale: 'ar',
      });
      const callbackToken = track(
        new URL(started.authorizeUrl).searchParams
          .get('callback_url')!
          .split('/')
          .pop()!,
      );
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliver(merchant, placedCodFixture().payload, {
        token: callbackToken,
      });

      expect(ack.status).toBe(401);
      await expectNothingStored(before);
    });

    it('answers 404 and stores nothing while ingestion is switched off', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();
      settings.ingestionEnabled = false;

      const order = await deliver(merchant, placedCodFixture().payload);
      const updated = await deliver(merchant, placedCodFixture().payload, {
        topic: 'order.updated',
      });
      const unknown = await deliver(merchant, placedCodFixture().payload, {
        token: randomBytes(32).toString('base64url'),
      });

      const notFound = {
        status: 404,
        code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
      };
      expect([order, updated, unknown]).toEqual([notFound, notFound, notFound]);
      await expectNothingStored(before);
      expect(await rejectedDeliveriesOf(merchant)).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    it('refuses tenant A’s token with tenant B’s signature', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliver(a, placedCodFixture().payload, {
        secret: b.webhookSecret,
      });

      expect(ack).toEqual({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      await expectNothingStored(before);
      expect(await rejectedDeliveriesOf(a)).toBe(1);
      expect(await rejectedDeliveriesOf(b)).toBe(0);
    });

    it('refuses tenant B’s whole delivery on tenant A’s token', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();
      const before = await totalEvents();

      // B's secret and B's own address: authentic for B, not for A's URL.
      const ack = await deliver(a, placedCodFixture().payload, {
        secret: b.webhookSecret,
        headers: { source: `${b.store.url}/` },
      });

      expect(ack.status).toBe(401);
      await expectNothingStored(before);
    });

    it('refuses tenant A’s signature when the source names tenant B’s store', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliver(a, placedCodFixture().payload, {
        headers: { source: `${b.store.url}/` },
      });

      expect(ack.status).toBe(401);
      await expectNothingStored(before);
      expect(await rejectedDeliveriesOf(a)).toBe(1);
    });

    it('keeps the same order id from two stores apart', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();
      const { payload } = placedCodFixture();

      await deliver(a, payload);
      await deliver(b, { ...payload, total: '99.00' });
      await drain();

      const [eventA] = await eventsOf(a);
      const [eventB] = await eventsOf(b);
      expect(eventA.idempotency_key).toBe(
        `order.create:${a.integrationId}:1001`,
      );
      expect(eventB.idempotency_key).toBe(
        `order.create:${b.integrationId}:1001`,
      );
      expect(eventA.store_domain).not.toBe(eventB.store_domain);
      expect(await ordersOf(a)).toMatchObject([
        { org_id: a.orgId, external_order_id: '1001', total_price: '450.00' },
      ]);
      expect(await ordersOf(b)).toMatchObject([
        { org_id: b.orgId, external_order_id: '1001', total_price: '99.00' },
      ]);
      expect(await verificationsOf(a)).toHaveLength(1);
      expect(await verificationsOf(b)).toHaveLength(1);
      expect(sends).toHaveLength(2);
    });

    it('tenant B’s order does not make tenant A’s a known order', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();
      await deliver(b, placedCodFixture().payload);
      await drain();

      // B already has order 1001. For A it is still a first delivery.
      await deliver(a, placedCodFixture().payload, { topic: 'order.updated' });
      await drain();

      expect(await eventsOf(a)).toMatchObject([
        { job_type: 'order.create', status: 'completed' },
      ]);
      expect(await verificationsOf(a)).toHaveLength(1);
    });

    it('never takes the tenant from the payload', async () => {
      const a = await connectMerchant();
      const b = await connectMerchant();

      await deliver(a, {
        ...placedCodFixture().payload,
        org_id: b.orgId,
        orgId: b.orgId,
        integration_id: b.integrationId,
        store_url: b.store.url,
      });
      await drain();

      expect(await ordersOf(a)).toHaveLength(1);
      expect(await ordersOf(b)).toHaveLength(0);
      expect(await eventsOf(b)).toHaveLength(0);
    });
  });

  describe('the ping', () => {
    it.each([
      ['the assumed ping body', () => Buffer.from(pingFixture(), 'utf8')],
      ['any other body', () => randomBytes(64)],
      ['no body', () => Buffer.alloc(0)],
    ])(
      'answers %s on a connected token and stores nothing',
      async (_label, body) => {
        const merchant = await connectMerchant();
        const before = await totalEvents();

        for (const ingestionEnabled of [true, false]) {
          settings.ingestionEnabled = ingestionEnabled;
          await expect(
            answer(webhooks.handleDelivery(merchant.webhookToken, {}, body())),
          ).resolves.toEqual({ status: 200 });
        }

        await expectNothingStored(before);
        expect(await rejectedDeliveriesOf(merchant)).toBe(0);
      },
    );

    it('answers the ping, and an order, sent while the callback is still creating the webhooks', async () => {
      const { owner, orgId } = await createOrganization();
      const store = fake.addStore();
      const started = await auth.startInstall(owner, {
        storeUrl: store.url,
        locale: 'ar',
      });
      const params = new URL(started.authorizeUrl).searchParams;
      const keys = store.issueKeys();
      track(keys.consumerKey);
      track(keys.consumerSecret);
      const before = await totalEvents();
      const answers: Answer[] = [];
      store.onPing = async (deliveryUrl) => {
        const token = track(deliveryUrl.split('/').pop()!);
        // No connection exists yet, so no secret to check an order against.
        const body = Buffer.from(
          JSON.stringify(placedCodFixture().payload),
          'utf8',
        );
        answers.push(
          await answer(webhooks.handleDelivery(token, {}, Buffer.alloc(0))),
          await answer(
            webhooks.handleDelivery(
              token,
              {
                topic: 'order.created',
                signature: sign(body, 'not-known-yet'),
                source: `${store.url}/`,
              },
              body,
            ),
          ),
        );
      };

      await auth.handleCallback(
        track(params.get('callback_url')!.split('/').pop()!),
        {
          key_id: 1,
          user_id: params.get('user_id'),
          consumer_key: keys.consumerKey,
          consumer_secret: keys.consumerSecret,
          key_permissions: 'read_write',
        },
      );

      expect(answers).toHaveLength(4);
      expect(answers.every((entry) => entry.status === 200)).toBe(true);
      await expectNothingStored(before);
      const [row] = await client<{ rejected_deliveries: number }[]>`
        SELECT rejected_deliveries FROM woocommerce_connections WHERE org_id = ${orgId}`;
      expect(row.rejected_deliveries).toBe(0);
    });

    it('answers an unknown token 401 while ingestion is on and 404 while it is off', async () => {
      const token = randomBytes(32).toString('base64url');

      await expect(
        answer(webhooks.handleDelivery(token, {}, Buffer.alloc(0))),
      ).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
      });
      settings.ingestionEnabled = false;
      await expect(
        answer(webhooks.handleDelivery(token, {}, Buffer.alloc(0))),
      ).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
      });
    });

    it.each([
      ['a body that is not JSON', 'webhook_id=9001'],
      ['an order without an id', '{"status":"processing"}'],
      ['an id sent as text', '{"id":"1001","status":"processing"}'],
    ])(
      'answers a signed order delivery with %s 200 and stores nothing',
      async (_label, text) => {
        const merchant = await connectMerchant();
        const before = await totalEvents();

        const ack = await deliver(merchant, Buffer.from(text, 'utf8'));

        expect(ack).toEqual({ status: 200 });
        await expectNothingStored(before);
        expect(await rejectedDeliveriesOf(merchant)).toBe(0);
      },
    );
  });

  describe('queue outage and database failure', () => {
    it('acknowledges after the durable write and recovers the order once the queue is back', async () => {
      const merchant = await connectMerchant();
      const { payload } = placedCodFixture();
      queue.down = true;

      const ack = await deliver(merchant, payload);

      expect(ack).toEqual({ status: 200 });
      expect(queued).toHaveLength(0);
      const [stored] = await eventsOf(merchant);
      expect(stored).toMatchObject({
        status: 'pending',
        dispatch_required: true,
        dispatched_at: null,
        org_id: merchant.orgId,
      });
      expect(stored.last_dispatch_error).toContain('redis unavailable');
      expect(await ordersOf(merchant)).toHaveLength(0);

      // A redelivery during the outage is answered too and starts nothing
      // of its own: the order is already known, so it is a recorded update.
      const repeat = await deliver(merchant, payload);
      expect(repeat).toEqual({ status: 200 });
      expect(await eventsOf(merchant)).toMatchObject([
        { job_type: 'order.create', status: 'pending' },
        { job_type: 'order.update', status: 'pending' },
      ]);

      // The queue returns; the backoff has elapsed.
      queue.down = false;
      await client`
        UPDATE webhook_events
        SET next_dispatch_at = now(), dispatch_lease_until = NULL
        WHERE id = ${stored.id}`;
      expect(await dispatcher.dispatchById(stored.id)).toBe('dispatched');
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { job_type: 'order.create', status: 'completed' },
        { job_type: 'order.update' },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('answers 5xx when the event cannot be written, and logs it apart from a refusal', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();
      const logsBefore = logs.length;
      await client`UPDATE fault_switch SET fail = true`;

      let ack: Answer;
      try {
        ack = await deliver(merchant, placedCodFixture().payload);
      } finally {
        await client`UPDATE fault_switch SET fail = false`;
      }

      expect(ack).toEqual({ status: 500 });
      // The driver's error sits under the query error that wraps it.
      expect(
        failures.map((failure) =>
          failure.cause instanceof Error
            ? failure.cause.message
            : failure.message,
        ),
      ).toEqual([expect.stringContaining('injected event insert failure')]);
      failures.length = 0;
      await expectNothingStored(before);
      const lines = logs.slice(logsBefore).join('\n');
      expect(lines).toContain('woocommerce-webhook-not-persisted');
      expect(lines).not.toContain('woocommerce-webhook-refused');
      // Not a refused delivery: the store did nothing wrong.
      expect(await rejectedDeliveriesOf(merchant)).toBe(0);

      // The store sends it again and it is taken.
      await expect(
        deliver(merchant, placedCodFixture().payload),
      ).resolves.toEqual({ status: 200 });
      await drain();
      expect(await verificationsOf(merchant)).toHaveLength(1);
    });
  });

  describe('secrets and stored data', () => {
    it('keeps the delivery identifiers and only the order fields Akeed reads', async () => {
      const merchant = await connectMerchant();
      const { payload, headers } = placedCodFixture();

      await deliver(
        merchant,
        {
          ...payload,
          meta_data: [
            { id: 1, key: '_other_plugin_token', value: 'sk_synthetic_plugin' },
            { id: 2, key: 'akeed_outcome', value: 'customer_confirmation:x' },
          ],
        },
        {
          headers: {
            webhookId: headers['X-WC-Webhook-ID'],
            deliveryId: headers['X-WC-Webhook-Delivery-ID'],
          },
        },
      );
      await drain();

      const [event] = await eventsOf(merchant);
      expect(event.raw_payload).toEqual({
        topic: 'order.created',
        webhookId: '9001',
        deliveryId: 'synthetic-delivery-0002',
        order: {
          id: 1001,
          number: '1001',
          status: 'processing',
          currency: 'EGP',
          date_created_gmt: '2026-01-01T10:00:00',
          date_modified_gmt: '2026-01-01T10:01:00',
          total: '450.00',
          payment_method: 'cod',
          billing: {
            first_name: 'Test',
            last_name: 'Customer',
            phone: '01000000000',
            country: 'EG',
          },
          meta_data: [
            { key: 'akeed_outcome', value: 'customer_confirmation:x' },
          ],
        },
      });
      const [order] = await ordersOf(merchant);
      const kept = `${JSON.stringify(event.raw_payload)}${JSON.stringify(order.raw_payload)}`;
      for (const dropped of [
        'test.customer@example.com',
        'Synthetic address 1',
        'Sample item 1',
        'wc_order_SYNTHETIC0001',
        'sk_synthetic_plugin',
      ])
        expect(kept).not.toContain(dropped);
    });

    it('never logs or returns a token, a secret or a key', () => {
      expect(secrets.size).toBeGreaterThan(20);
      expect(logs.length).toBeGreaterThan(20);
      const output = `${logs.join('\n')}\n${JSON.stringify(responses)}`;
      for (const value of secrets) {
        expect(output).not.toContain(value);
        expect(output).not.toContain(hashInstallToken(value));
      }
    });

    it('stores no secret, token or key in an event', async () => {
      const stored = await client<{ raw: string }[]>`
        SELECT raw_payload::text || idempotency_key || store_domain AS raw
        FROM webhook_events`;
      expect(stored.length).toBeGreaterThan(20);
      const output = stored.map((row) => row.raw).join('\n');
      for (const value of secrets) {
        expect(output).not.toContain(value);
        expect(output).not.toContain(hashInstallToken(value));
      }
    });

    it('never names a store in an event: the source identity is the organization', async () => {
      const stored = await client<{ store_domain: string }[]>`
        SELECT DISTINCT store_domain FROM webhook_events`;

      for (const row of stored)
        expect(row.store_domain).toMatch(/^woocommerce:[0-9a-f-]{36}$/);
    });
  });
});
