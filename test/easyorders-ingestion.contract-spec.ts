import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DelayedError, type Job } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { CreditAccountingRepository } from '../src/infrastructure/database/repositories/credit-accounting.repository';
import { EasyOrdersConnectionsRepository } from '../src/infrastructure/database/repositories/easyorders-connections.repository';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { PeriodicPlanAccounting } from '../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../src/infrastructure/database/repositories/usage-accounting.router';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import {
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from '../src/infrastructure/spokes/easyorders/easyorders-api.client';
import { EasyOrdersAuthService } from '../src/infrastructure/spokes/easyorders/easyorders-auth.service';
import { hashInstallToken } from '../src/infrastructure/spokes/easyorders/easyorders-install-token';
import { EasyOrdersOrderEligibilityStrategy } from '../src/infrastructure/spokes/easyorders/easyorders-order-eligibility.strategy';
import { EasyOrdersOrderNormalizer } from '../src/infrastructure/spokes/easyorders/easyorders-order.normalizer';
import { EasyOrdersRateLimiter } from '../src/infrastructure/spokes/easyorders/easyorders-rate-limiter';
import { EasyOrdersWebhookService } from '../src/infrastructure/spokes/easyorders/easyorders-webhook.service';
import { ShopifyOrderEligibilityStrategy } from '../src/infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneOutcomeAdapter } from '../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
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
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../src/shared/config/easyorders.config';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { PhoneService } from '../src/shared/services/phone.service';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import {
  orderCreatedFixture,
  orderStatusFixture,
  type EasyOrdersOrderFixture,
} from './fixtures/easyorders/load';

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

const namespace = `e06_ingestion_${randomUUID().replaceAll('-', '')}`;
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

const settings: EasyOrdersConfig & { pilotOrgIds: string[] } = {
  enabled: true,
  ingestionEnabled: true,
  outcomeSyncEnabled: false,
  pilotOrgIds: [],
  publicApiBaseUrl: 'https://api.akeed.test',
  appBaseUrl: 'https://app.akeed.test',
};

const easyOrdersConfig = {
  get: (key: string) => (key === EASYORDERS_CONFIG ? settings : undefined),
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

// --- The fake EasyOrders API: no request ever leaves the process. ---

interface ProviderRequest {
  key: string;
  orderId: string;
}
const providerRequests: ProviderRequest[] = [];
/** What reading an order answers, by order id. Unlisted ids answer 200 `{}`. */
const orderAnswers = new Map<string, () => Response>();

/** The client only ever passes the URL as text. */
function requestedOrderId(input: string | URL | Request): string {
  const url = typeof input === 'string' ? input : '';
  return decodeURIComponent(url.split('/').pop() ?? '');
}

const fakeEasyOrders: EasyOrdersHttp = (input: string | URL | Request) =>
  Promise.resolve(
    orderAnswers.get(requestedOrderId(input))?.() ?? Response.json({}),
  );
const recordingEasyOrders: EasyOrdersHttp = (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  providerRequests.push({
    key: new Headers(init?.headers).get('Api-Key') ?? '',
    orderId: requestedOrderId(input),
  });
  return fakeEasyOrders(input, init);
};

// --- Real repositories and services; only the edges are fakes. ---

const connections = new EasyOrdersConnectionsRepository(db);
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
    return Promise.resolve({ messages: [{ id: `wamid-e06-${sends.length}` }] });
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
  ]),
  send,
  billing,
  creditEligibility,
  automation as never,
);

const limiter = new EasyOrdersRateLimiter();
const api = new EasyOrdersApiClient(recordingEasyOrders);
const phones = new PhoneService();
const processor = new WebhookQueueProcessor(
  [
    new ShopifyOrderNormalizer(phones),
    new StandaloneManualOrderNormalizer(),
    new EasyOrdersOrderNormalizer(
      connections,
      api,
      limiter,
      phones,
      easyOrdersConfig,
    ),
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
const webhooks = new EasyOrdersWebhookService(
  connections,
  producer,
  easyOrdersConfig,
);
const auth = new EasyOrdersAuthService(
  connections,
  new EasyOrdersApiClient(fakeEasyOrders),
  easyOrdersConfig,
  phones,
);

/** How one job ended: done, moved to the delayed set, or thrown for a retry. */
type JobEnd =
  | { kind: 'done' }
  | { kind: 'delayed'; delayMs: number; payload: WebhookJobPayload }
  | { kind: 'failed'; message: string };

async function runJob(payload: WebhookJobPayload): Promise<JobEnd> {
  let data = payload;
  let delayedUntil = 0;
  const job = {
    id: `job-${payload.webhookEventId}`,
    get data() {
      return data;
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
    updateData: (next: WebhookJobPayload) => {
      data = next;
      return Promise.resolve();
    },
    moveToDelayed: (timestamp: number) => {
      delayedUntil = timestamp;
      return Promise.resolve();
    },
  } as unknown as Job<WebhookJobPayload>;
  try {
    await processor.process(job, 'lock-token');
    return { kind: 'done' };
  } catch (error) {
    if (error instanceof DelayedError)
      return {
        kind: 'delayed',
        delayMs: delayedUntil - Date.now(),
        payload: data,
      };
    // What the worker's `failed` event does before BullMQ backs off.
    await processor.onFailed(
      { ...job, data, attemptsMade: 1 } as Job<WebhookJobPayload>,
      error as Error,
    );
    return { kind: 'failed', message: (error as Error).message };
  }
}

async function drain(): Promise<JobEnd[]> {
  const ends: JobEnd[] = [];
  while (queued.length > 0) ends.push(await runJob(queued.shift()!));
  return ends;
}

// --- Tenants ---

interface Merchant {
  orgId: string;
  integrationId: string;
  storeId: string;
  apiKey: string;
  webhookToken: string;
  ordersSecret: string;
  statusSecret: string;
  owner: AuthenticatedUser;
}

interface MerchantOptions {
  storeId?: string;
  /** Leaves the store an unverified claim, as a fresh connection is. */
  verified?: boolean;
  secrets?: boolean;
  orderSettings?: { currency: string; phoneCountry: string } | null;
  onboarding?: 'completed' | 'pending';
}

function secret(): string {
  const value = randomBytes(12).toString('base64');
  secrets.add(value);
  return value;
}

/** Connects a store the way a seller does: install, callback, setup inputs. */
async function connectMerchant(
  options: MerchantOptions = {},
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

  const started = await auth.startInstall(owner, { locale: 'ar' });
  const params = new URLSearchParams(started.installUrl.split('?')[1]);
  const callbackToken = params.get('callback_url')!.split('/').pop()!;
  const webhookToken = params.get('orders_webhook')!.split('/').pop()!;
  const apiKey = `eo_${randomBytes(24).toString('base64url')}`;
  const storeId = options.storeId ?? randomUUID();
  secrets.add(callbackToken).add(webhookToken).add(apiKey);
  await auth.handleCallback(callbackToken, {
    api_key: apiKey,
    store_id: storeId,
  });

  const ordersSecret = secret();
  const statusSecret = secret();
  if (options.secrets !== false)
    await auth.saveWebhookSecrets(owner, { ordersSecret, statusSecret });
  if (options.orderSettings !== null)
    await auth.saveOrderSettings(
      owner,
      options.orderSettings ?? { currency: 'EGP', phoneCountry: 'EG' },
    );

  const [integration] = await client<{ id: string }[]>`
    UPDATE integrations
    SET onboarding_status = ${options.onboarding ?? 'completed'}
    WHERE org_id = ${orgId}
    RETURNING id`;
  if (options.verified !== false)
    await client`
      UPDATE easyorders_connections SET store_verified_at = now()
      WHERE integration_id = ${integration.id}`;
  return {
    orgId,
    integrationId: integration.id,
    storeId,
    apiKey,
    webhookToken,
    ordersSecret,
    statusSecret,
    owner,
  };
}

/** The documented order-created payload, for one merchant's store. */
function orderFor(
  merchant: Merchant,
  overrides: Record<string, unknown> = {},
): EasyOrdersOrderFixture {
  return {
    ...orderCreatedFixture(),
    id: randomUUID(),
    store_id: merchant.storeId,
    ...overrides,
  } as EasyOrdersOrderFixture;
}

interface Answer {
  status: number;
  code?: string;
  body?: unknown;
}

async function answer(promise: Promise<unknown>): Promise<Answer> {
  try {
    const body = await promise;
    responses.push(body);
    return { status: 200, body };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code?: string };
    responses.push(body);
    return { status: error.getStatus(), code: body.code };
  }
}

function deliverOrder(
  merchant: Merchant,
  payload: unknown,
  overrides: { token?: string; secret?: string | undefined } = {},
): Promise<Answer> {
  return answer(
    webhooks.handleOrderCreated(
      overrides.token ?? merchant.webhookToken,
      'secret' in overrides ? overrides.secret : merchant.ordersSecret,
      payload,
    ),
  );
}

function deliverStatus(merchant: Merchant, payload: unknown): Promise<Answer> {
  return answer(
    webhooks.handleStatusUpdate(
      merchant.webhookToken,
      merchant.statusSecret,
      payload,
    ),
  );
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
  dispatch_required: boolean;
  dispatched_at: Date | null;
  last_dispatch_error: string | null;
}

function eventsOf(merchant: Merchant) {
  return client<EventRow[]>`
    SELECT * FROM webhook_events
    WHERE integration_id = ${merchant.integrationId}
    ORDER BY received_at, id`;
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
    }[]
  >`SELECT * FROM orders WHERE integration_id = ${merchant.integrationId} ORDER BY created_at`;
}

function verificationsOf(merchant: Merchant) {
  return client<{ id: string; order_id: string; status: string }[]>`
    SELECT * FROM verifications WHERE org_id = ${merchant.orgId} ORDER BY created_at`;
}

async function connectionOf(merchant: Merchant) {
  const [row] = await client<
    {
      store_verified_at: Date | null;
      health: string;
      rejected_deliveries: number;
      last_rejected_at: Date | null;
      currency: string | null;
      phone_country: string | null;
    }[]
  >`SELECT * FROM easyorders_connections WHERE integration_id = ${merchant.integrationId}`;
  return row;
}

async function totalEvents(): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM webhook_events`;
  return row.count;
}

async function expectNothingQueued(before: number) {
  expect(await totalEvents()).toBe(before);
  expect(queued).toHaveLength(0);
}

// --- Schema: the Drizzle tables, then the real EasyOrders migrations. ---

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

describe('EasyOrders webhook ingestion PostgreSQL contract (US-06-03)', () => {
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
    // The story's own migrations, twice: both must be re-runnable.
    for (let pass = 0; pass < 2; pass++) {
      await migrate('0047_easyorders_connection.sql');
      await migrate('0048_easyorders_ingestion.sql');
    }
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
    providerRequests.length = 0;
    orderAnswers.clear();
  });

  describe('a cash-on-delivery order', () => {
    it('becomes one order and one verification, sent once from the Akeed sender', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);

      const ack = await deliverOrder(merchant, payload);
      const ends = await drain();

      expect(ack).toEqual({ status: 200, body: { received: true } });
      expect(ends).toEqual([{ kind: 'done' }]);
      const [event, ...otherEvents] = await eventsOf(merchant);
      expect(otherEvents).toHaveLength(0);
      expect(event).toMatchObject({
        platform: 'easyorders',
        job_type: 'order.create',
        status: 'completed',
        org_id: merchant.orgId,
        store_domain: `easyorders:${merchant.orgId}`,
        idempotency_key: `order.create:${merchant.integrationId}:${payload.id}`,
      });
      const [order, ...otherOrders] = await ordersOf(merchant);
      expect(otherOrders).toHaveLength(0);
      expect(order).toMatchObject({
        org_id: merchant.orgId,
        external_order_id: payload.id,
        order_number: payload.id.slice(0, 8),
        customer_phone: '+201000000000',
        customer_name: 'Test Customer',
        total_price: '750.00',
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
        orderNumber: payload.id.slice(0, 8),
      });
      expect(sends[0].totalPrice).toContain('750');
      // A complete order from a verified store costs no EasyOrders request.
      expect(providerRequests).toHaveLength(0);
    });

    it('takes the currency and the phone country from the integration, not the payload', async () => {
      const merchant = await connectMerchant({
        orderSettings: { currency: 'SAR', phoneCountry: 'SA' },
      });

      await deliverOrder(
        merchant,
        orderFor(merchant, {
          phone: '0512345678',
          currency: 'USD',
          country: 'EG',
        }),
      );
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        { currency: 'SAR', customer_phone: '+966512345678' },
      ]);
    });

    it('keeps an international number as given', async () => {
      const merchant = await connectMerchant();

      await deliverOrder(
        merchant,
        orderFor(merchant, { phone: '+966512345678' }),
      );
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        { customer_phone: '+966512345678' },
      ]);
    });
  });

  describe('orders that must not be sent', () => {
    it.each([
      [
        'a non-COD payment method',
        { payment_method: 'card' },
        'non_cod_payment_method',
      ],
      ['a phone that does not parse', { phone: '12345' }, 'invalid_phone'],
      ['a zero amount', { total_cost: 0 }, 'invalid_amount'],
    ])('records %s and creates nothing', async (_label, overrides, reason) => {
      const merchant = await connectMerchant();

      const ack = await deliverOrder(merchant, orderFor(merchant, overrides));
      await drain();

      expect(ack.status).toBe(200);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: reason, order_id: null },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(await verificationsOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it.each([
      [{ currency: 'EGP', phoneCountry: null }, 'missing_phone_country'],
      [{ currency: null, phoneCountry: 'EG' }, 'missing_currency'],
    ])('records %j as the reason and never guesses', async (stored, reason) => {
      const merchant = await connectMerchant({ orderSettings: null });
      await client`
        UPDATE easyorders_connections
        SET currency = ${stored.currency}, phone_country = ${stored.phoneCountry}
        WHERE integration_id = ${merchant.integrationId}`;

      await deliverOrder(merchant, orderFor(merchant));
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: reason },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });

    it('accepts an order for a source that is not ready, and sends nothing', async () => {
      const merchant = await connectMerchant({ onboarding: 'pending' });

      const ack = await deliverOrder(merchant, orderFor(merchant));
      await drain();

      expect(ack.status).toBe(200);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'onboarding_incomplete' },
      ]);
      expect(await verificationsOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it.each([
      ['a wrong secret', () => ({ secret: secret() })],
      ['no secret header', () => ({ secret: undefined })],
      [
        'an unknown URL token',
        () => ({ token: randomBytes(32).toString('base64url') }),
      ],
      ['a malformed URL token', () => ({ token: 'not-a-token' })],
    ])('answers 401 and stores nothing for %s', async (_label, overrides) => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(merchant, orderFor(merchant), overrides());

      expect(ack).toEqual({
        status: 401,
        code: 'EASYORDERS_WEBHOOK_UNAUTHORIZED',
      });
      await expectNothingQueued(before);
    });

    it('rejects every webhook while the seller has not added the secrets', async () => {
      const merchant = await connectMerchant({ secrets: false });
      const before = await totalEvents();

      expect((await deliverOrder(merchant, orderFor(merchant))).status).toBe(
        401,
      );
      expect((await deliverStatus(merchant, orderStatusFixture())).status).toBe(
        401,
      );

      await expectNothingQueued(before);
      expect((await connectionOf(merchant)).rejected_deliveries).toBe(0);
    });

    it('counts wrong-secret deliveries so a mistyped secret is visible', async () => {
      const merchant = await connectMerchant();

      await deliverOrder(merchant, orderFor(merchant), { secret: secret() });
      await deliverOrder(merchant, orderFor(merchant), { secret: secret() });

      const connection = await connectionOf(merchant);
      expect(connection.rejected_deliveries).toBe(2);
      expect(connection.last_rejected_at).not.toBeNull();
      const status = await auth.getStatus(merchant.owner);
      responses.push(status);
      expect(status.connection?.rejectedDeliveries).toBe(2);
    });

    it('does not accept the status webhook’s secret on the orders route', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(merchant, orderFor(merchant), {
        secret: merchant.statusSecret,
      });

      expect(ack.status).toBe(401);
      await expectNothingQueued(before);
    });

    it('stops accepting a token after it is rotated', async () => {
      const merchant = await connectMerchant();
      const rotated = randomBytes(32).toString('base64url');
      secrets.add(rotated);
      await client`
        UPDATE easyorders_connections
        SET webhook_token_hash = ${hashInstallToken(rotated)}
        WHERE integration_id = ${merchant.integrationId}`;
      const before = await totalEvents();

      const old = await deliverOrder(merchant, orderFor(merchant));
      expect(old.status).toBe(401);
      await expectNothingQueued(before);

      const current = await deliverOrder(merchant, orderFor(merchant), {
        token: rotated,
      });
      expect(current.status).toBe(200);
    });

    it('answers 404 and stores nothing while ingestion is switched off', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();
      settings.ingestionEnabled = false;

      expect(await deliverOrder(merchant, orderFor(merchant))).toEqual({
        status: 404,
        code: 'EASYORDERS_INGESTION_UNAVAILABLE',
      });
      expect(await deliverStatus(merchant, orderStatusFixture())).toEqual({
        status: 404,
        code: 'EASYORDERS_INGESTION_UNAVAILABLE',
      });
      await expectNothingQueued(before);
    });
  });

  describe('store binding and tenant isolation', () => {
    it.each([
      [
        'another store id',
        (merchant: Merchant) => orderFor(merchant, { store_id: randomUUID() }),
      ],
      [
        'no store id',
        (merchant: Merchant) => orderFor(merchant, { store_id: undefined }),
      ],
    ])('answers 403 and stores nothing for %s', async (_label, build) => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(merchant, build(merchant));

      expect(ack).toEqual({
        status: 403,
        code: 'EASYORDERS_WEBHOOK_STORE_MISMATCH',
      });
      await expectNothingQueued(before);
    });

    it('rejects tenant A’s token with tenant B’s store id', async () => {
      const tenantA = await connectMerchant();
      const tenantB = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(tenantA, orderFor(tenantB));

      expect(ack.status).toBe(403);
      await expectNothingQueued(before);
      expect(await ordersOf(tenantB)).toHaveLength(0);
    });

    it('does not accept tenant B’s secret on tenant A’s token', async () => {
      const tenantA = await connectMerchant();
      const tenantB = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(tenantA, orderFor(tenantA), {
        secret: tenantB.ordersSecret,
      });

      expect(ack.status).toBe(401);
      await expectNothingQueued(before);
    });

    it('never takes the tenant from the payload', async () => {
      const tenantA = await connectMerchant();
      const tenantB = await connectMerchant();

      await deliverOrder(
        tenantA,
        orderFor(tenantA, {
          org_id: tenantB.orgId,
          orgId: tenantB.orgId,
          integration_id: tenantB.integrationId,
          integrationId: tenantB.integrationId,
        }),
      );
      await drain();

      expect(await ordersOf(tenantA)).toHaveLength(1);
      expect(await ordersOf(tenantB)).toHaveLength(0);
      expect(await eventsOf(tenantB)).toHaveLength(0);
    });

    it('keeps the same order id apart for two integrations', async () => {
      const tenantA = await connectMerchant();
      const tenantB = await connectMerchant();
      const orderId = randomUUID();

      await deliverOrder(tenantA, orderFor(tenantA, { id: orderId }));
      await deliverOrder(tenantB, orderFor(tenantB, { id: orderId }));
      await drain();

      expect(await ordersOf(tenantA)).toMatchObject([
        { org_id: tenantA.orgId, external_order_id: orderId },
      ]);
      expect(await ordersOf(tenantB)).toMatchObject([
        { org_id: tenantB.orgId, external_order_id: orderId },
      ]);
      expect(sends).toHaveLength(2);
    });

    it('a status event for tenant B’s order on tenant A’s token changes nothing', async () => {
      const tenantA = await connectMerchant();
      const tenantB = await connectMerchant();
      const payload = orderFor(tenantB);
      await deliverOrder(tenantB, payload);
      await drain();
      const [orderBefore] = await ordersOf(tenantB);
      const [verificationBefore] = await verificationsOf(tenantB);

      const ack = await deliverStatus(tenantA, {
        ...orderStatusFixture(),
        order_id: payload.id,
        new_status: 'canceled',
      });
      await drain();

      expect(ack.status).toBe(200);
      // Recorded under the token's tenant, and ignored.
      expect(await eventsOf(tenantA)).toMatchObject([
        {
          job_type: 'order.update',
          status: 'skipped',
          last_error: 'unhandled_job_type:order.update',
          org_id: tenantA.orgId,
          order_id: null,
          idempotency_key: `order.status:${tenantA.integrationId}:${payload.id}:pending:canceled`,
        },
      ]);
      expect(await ordersOf(tenantB)).toEqual([orderBefore]);
      expect(await verificationsOf(tenantB)).toEqual([verificationBefore]);
      expect(await eventsOf(tenantB)).toHaveLength(1);
      expect(await ordersOf(tenantA)).toHaveLength(0);
    });
  });

  describe('event types', () => {
    it.each([
      [
        'a status event',
        (merchant: Merchant) => ({
          ...orderStatusFixture(),
          store_id: merchant.storeId,
          id: randomUUID(),
        }),
      ],
      [
        'an unknown event type',
        (merchant: Merchant) =>
          orderFor(merchant, { event_type: 'order-deleted' }),
      ],
      [
        'an order without an id',
        (merchant: Merchant) => orderFor(merchant, { id: undefined }),
      ],
    ])('keeps %s out of the create path', async (_label, build) => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverOrder(merchant, build(merchant));

      expect(ack).toEqual({
        status: 400,
        code: 'EASYORDERS_WEBHOOK_MALFORMED',
      });
      await expectNothingQueued(before);
    });

    it('records a status event of the merchant’s own order without touching it', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      await deliverOrder(merchant, payload);
      await drain();
      const [verificationBefore] = await verificationsOf(merchant);
      const status = { ...orderStatusFixture(), order_id: payload.id };

      const first = await deliverStatus(merchant, status);
      const repeat = await deliverStatus(merchant, status);
      await drain();

      expect(first.body).toEqual({ received: true });
      // The same transition again collapses into the one event (section 3).
      expect(repeat.body).toEqual({ received: true, duplicate: true });
      const updates = (await eventsOf(merchant)).filter(
        (event) => event.job_type === 'order.update',
      );
      expect(updates).toMatchObject([{ status: 'skipped' }]);
      expect(await verificationsOf(merchant)).toEqual([verificationBefore]);
      expect(sends).toHaveLength(1);
    });

    it('refuses an order payload on the status route', async () => {
      const merchant = await connectMerchant();
      const before = await totalEvents();

      const ack = await deliverStatus(merchant, orderFor(merchant));

      expect(ack.status).toBe(400);
      await expectNothingQueued(before);
    });
  });

  describe('duplicate and concurrent deliveries', () => {
    it('collapses a repeated delivery into one event, one order and one verification', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);

      const first = await deliverOrder(merchant, payload);
      await drain();
      const repeat = await deliverOrder(merchant, payload);
      await drain();

      expect(first.body).toEqual({ received: true });
      expect(repeat.body).toEqual({ received: true, duplicate: true });
      expect(await eventsOf(merchant)).toHaveLength(1);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('collapses concurrent deliveries of one order', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);

      const acks = await Promise.all(
        Array.from({ length: 8 }, () => deliverOrder(merchant, payload)),
      );
      await drain();

      expect(acks.every((ack) => ack.status === 200)).toBe(true);
      expect(
        acks.filter(
          (ack) => (ack.body as { duplicate?: boolean }).duplicate !== true,
        ),
      ).toHaveLength(1);
      expect(await eventsOf(merchant)).toHaveLength(1);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('does not turn a changed redelivery into an order edit', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      await deliverOrder(merchant, payload);
      await drain();

      await deliverOrder(merchant, {
        ...payload,
        total_cost: 1,
        phone: '01111111111',
      });
      await drain();

      expect(await ordersOf(merchant)).toMatchObject([
        { total_price: '750.00', customer_phone: '+201000000000' },
      ]);
      expect(sends).toHaveLength(1);
    });
  });

  describe('order lookup', () => {
    it('reads an incomplete order back with the integration’s own key', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      orderAnswers.set(payload.id, () => Response.json(payload));

      await deliverOrder(merchant, {
        ...payload,
        phone: undefined,
        full_name: undefined,
      });
      // Nothing is fetched while the webhook is being received.
      expect(providerRequests).toHaveLength(0);
      await drain();

      expect(providerRequests).toEqual([
        { key: merchant.apiKey, orderId: payload.id },
      ]);
      expect(await ordersOf(merchant)).toMatchObject([
        { customer_phone: '+201000000000', customer_name: 'Test Customer' },
      ]);
      expect(sends).toHaveLength(1);
    });

    it('records an order that stays incomplete after the lookup', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant, { phone: undefined });
      orderAnswers.set(payload.id, () => Response.json(payload));

      await deliverOrder(merchant, payload);
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'incomplete_payload' },
      ]);
      expect(sends).toHaveLength(0);
    });

    it('verifies an unverified store on its first order and stops asking after', async () => {
      const merchant = await connectMerchant({ verified: false });
      const first = orderFor(merchant);
      orderAnswers.set(first.id, () => Response.json(first));

      await deliverOrder(merchant, first);
      await drain();

      expect(providerRequests).toHaveLength(1);
      expect((await connectionOf(merchant)).store_verified_at).not.toBeNull();
      expect(await ordersOf(merchant)).toHaveLength(1);

      await deliverOrder(merchant, orderFor(merchant));
      await drain();

      expect(providerRequests).toHaveLength(1);
      expect(await ordersOf(merchant)).toHaveLength(2);
    });

    it('does not verify a store from data naming another store', async () => {
      const merchant = await connectMerchant({ verified: false });
      const payload = orderFor(merchant);
      orderAnswers.set(payload.id, () =>
        Response.json({ ...payload, store_id: randomUUID() }),
      );

      await deliverOrder(merchant, payload);
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'store_mismatch' },
      ]);
      expect((await connectionOf(merchant)).store_verified_at).toBeNull();
      expect(await ordersOf(merchant)).toHaveLength(0);
    });

    it('lets only one integration hold a store once it is verified', async () => {
      const storeId = randomUUID();
      const claimant = await connectMerchant({ storeId, verified: false });
      const owner = await connectMerchant({ storeId, verified: false });
      const ownerOrder = orderFor(owner);
      const claimantOrder = orderFor(claimant);
      orderAnswers.set(ownerOrder.id, () => Response.json(ownerOrder));
      orderAnswers.set(claimantOrder.id, () => Response.json(claimantOrder));

      await deliverOrder(owner, ownerOrder);
      await drain();
      await deliverOrder(claimant, claimantOrder);
      await drain();

      expect((await connectionOf(owner)).store_verified_at).not.toBeNull();
      expect((await connectionOf(claimant)).store_verified_at).toBeNull();
      expect(await eventsOf(claimant)).toMatchObject([
        { status: 'skipped', last_error: 'store_unavailable' },
      ]);
      expect(await ordersOf(claimant)).toHaveLength(0);
      expect(await ordersOf(owner)).toHaveLength(1);
    });

    it('reschedules a 429 for the delay EasyOrders names, then recovers', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      const incomplete = { ...payload, full_name: undefined };
      orderAnswers.set(
        payload.id,
        () =>
          new Response('', { status: 429, headers: { 'Retry-After': '1' } }),
      );

      await deliverOrder(merchant, incomplete);
      const [end] = await drain();

      expect(end).toMatchObject({ kind: 'delayed' });
      const delayed = end as Extract<JobEnd, { kind: 'delayed' }>;
      expect(delayed.delayMs).toBeGreaterThan(0);
      expect(delayed.delayMs).toBeLessThanOrEqual(1_000);
      expect(delayed.payload.deferrals).toBe(1);
      // The event is released, not failed, and no attempt was spent.
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'pending', last_error: 'source_rate_limited' },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);

      // While paused, the integration makes no other EasyOrders call.
      const requestsBefore = providerRequests.length;
      expect(await runJob(delayed.payload)).toMatchObject({ kind: 'delayed' });
      expect(providerRequests).toHaveLength(requestsBefore);

      orderAnswers.set(payload.id, () => Response.json(payload));
      await new Promise((done) => setTimeout(done, 1_100));
      const [event] = await eventsOf(merchant);
      expect(
        await runJob({ ...delayed.payload, webhookEventId: event.id }),
      ).toEqual({ kind: 'done' });
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });

    it('leaves a transient failure to the queue’s retry and recovers on the next attempt', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      orderAnswers.set(payload.id, () => new Response('', { status: 503 }));

      await deliverOrder(merchant, { ...payload, full_name: undefined });
      const job = queued[0];
      const [end] = await drain();

      expect(end).toEqual({ kind: 'failed', message: 'source_unavailable' });
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'pending', last_error: 'source_unavailable' },
      ]);

      orderAnswers.set(payload.id, () => Response.json(payload));
      expect(await runJob(job)).toEqual({ kind: 'done' });
      expect(await ordersOf(merchant)).toHaveLength(1);
    });

    it('treats a rejected key as permanent: health changes and nothing is retried', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant, { full_name: undefined });
      orderAnswers.set(payload.id, () => new Response('', { status: 401 }));

      await deliverOrder(merchant, payload);
      const ends = await drain();

      expect(ends).toEqual([{ kind: 'done' }]);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'source_credentials_rejected' },
      ]);
      expect((await connectionOf(merchant)).health).toBe(
        'credentials_rejected',
      );
      const status = await auth.getStatus(merchant.owner);
      responses.push(status);
      expect(status.connection?.health).toBe('credentials_rejected');
    });

    it('records an inactive store as a health state and retries slowly', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant, { full_name: undefined });
      orderAnswers.set(payload.id, () =>
        Response.json(
          { message: EASYORDERS_INACTIVE_STORE_MESSAGE },
          { status: 400 },
        ),
      );

      await deliverOrder(merchant, payload);
      const [end] = await drain();

      expect(end).toMatchObject({ kind: 'delayed' });
      expect((end as { delayMs: number }).delayMs).toBeGreaterThan(4 * 60_000);
      expect((await connectionOf(merchant)).health).toBe('store_inactive');
    });

    it('one store spending its lookup budget does not delay another', async () => {
      const busy = await connectMerchant();
      const quiet = await connectMerchant();
      for (let call = 0; call < 40; call += 1)
        limiter.acquire(busy.integrationId, 'lookup');
      const busyOrder = orderFor(busy);
      const quietOrder = orderFor(quiet);
      orderAnswers.set(busyOrder.id, () => Response.json(busyOrder));
      orderAnswers.set(quietOrder.id, () => Response.json(quietOrder));

      await deliverOrder(busy, { ...busyOrder, full_name: undefined });
      await deliverOrder(quiet, { ...quietOrder, full_name: undefined });
      const ends = await drain();

      expect(ends[0]).toMatchObject({ kind: 'delayed' });
      expect(ends[1]).toEqual({ kind: 'done' });
      expect(providerRequests).toEqual([
        { key: quiet.apiKey, orderId: quietOrder.id },
      ]);
      expect(await eventsOf(busy)).toMatchObject([
        { status: 'pending', last_error: 'source_rate_budget_exhausted' },
      ]);
      expect(await ordersOf(quiet)).toHaveLength(1);
    });
  });

  describe('queue outage', () => {
    it('acknowledges after the durable write and recovers the order once the queue is back', async () => {
      const merchant = await connectMerchant();
      const payload = orderFor(merchant);
      queue.down = true;

      const ack = await deliverOrder(merchant, payload);

      expect(ack).toEqual({ status: 200, body: { received: true } });
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

      // A redelivery during the outage does not create a second event.
      const repeat = await deliverOrder(merchant, payload);
      expect(repeat.body).toEqual({ received: true, duplicate: true });
      expect(await eventsOf(merchant)).toHaveLength(1);

      // The queue returns; the backoff has elapsed.
      queue.down = false;
      await client`
        UPDATE webhook_events
        SET next_dispatch_at = now(), dispatch_lease_until = NULL
        WHERE id = ${stored.id}`;
      expect(await dispatcher.dispatchById(stored.id)).toBe('dispatched');
      await drain();

      expect(await eventsOf(merchant)).toMatchObject([{ status: 'completed' }]);
      expect(await ordersOf(merchant)).toHaveLength(1);
      expect(await verificationsOf(merchant)).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });
  });

  describe('a disconnected source', () => {
    it('rejects new webhooks and stops an order that was already queued', async () => {
      const merchant = await connectMerchant();
      const queuedBefore = orderFor(merchant);
      await deliverOrder(merchant, queuedBefore);
      await client`
        UPDATE integrations SET is_active = false
        WHERE id = ${merchant.integrationId}`;
      const before = await totalEvents();

      const ack = await deliverOrder(merchant, orderFor(merchant));
      await drain();

      expect(ack).toEqual({
        status: 401,
        code: 'EASYORDERS_WEBHOOK_UNAUTHORIZED',
      });
      expect(await totalEvents()).toBe(before);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'integration_inactive' },
      ]);
      expect(await ordersOf(merchant)).toHaveLength(0);
      expect(sends).toHaveLength(0);
    });
  });

  describe('secrets and migration', () => {
    it('keeps the new columns nullable and the health values closed', async () => {
      const merchant = await connectMerchant({ orderSettings: null });

      expect(await connectionOf(merchant)).toMatchObject({
        currency: null,
        phone_country: null,
        rejected_deliveries: 0,
        health: 'ok',
      });
      await expect(
        client`UPDATE easyorders_connections SET currency = 'egp' WHERE integration_id = ${merchant.integrationId}`,
      ).rejects.toThrow(/easyorders_connections_currency_check/);
      await expect(
        client`UPDATE easyorders_connections SET phone_country = 'e1' WHERE integration_id = ${merchant.integrationId}`,
      ).rejects.toThrow(/easyorders_connections_phone_country_check/);
      await expect(
        client`UPDATE easyorders_connections SET health = 'unknown' WHERE integration_id = ${merchant.integrationId}`,
      ).rejects.toThrow(/easyorders_connections_health_check/);
    });

    it('lets only an owner or admin set the order settings', async () => {
      const merchant = await connectMerchant({ orderSettings: null });

      const refused = await answer(
        auth.saveOrderSettings(
          { ...merchant.owner, role: 'viewer' },
          { currency: 'EGP', phoneCountry: 'EG' },
        ),
      );
      expect(refused.code).toBe('EASYORDERS_ROLE_REQUIRED');
      expect((await connectionOf(merchant)).currency).toBeNull();

      const saved = await auth.saveOrderSettings(
        { ...merchant.owner, role: 'admin' },
        { currency: 'sar', phoneCountry: 'sa' },
      );
      responses.push(saved);
      expect(saved.connection).toMatchObject({
        currency: 'SAR',
        phoneCountry: 'SA',
      });
    });

    it('never logs or returns a token, a secret or an API key', () => {
      expect(secrets.size).toBeGreaterThan(20);
      expect(logs.length).toBeGreaterThan(20);
      const output = `${logs.join('\n')}\n${JSON.stringify(responses)}`;
      for (const value of secrets) {
        expect(output).not.toContain(value);
        expect(output).not.toContain(hashInstallToken(value));
      }
    });

    it('stores no secret, token or API key in an event', async () => {
      const stored = await client<{ raw: string }[]>`
        SELECT raw_payload::text || idempotency_key || store_domain AS raw
        FROM webhook_events`;
      expect(stored.length).toBeGreaterThan(20);
      const output = stored.map((row) => row.raw).join('\n');
      for (const value of secrets) expect(output).not.toContain(value);
    });
  });
});
