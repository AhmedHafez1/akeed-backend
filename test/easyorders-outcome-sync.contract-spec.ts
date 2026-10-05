import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { PhoneService } from '../src/shared/services/phone.service';
import { EasyOrdersAuthService } from '../src/infrastructure/spokes/easyorders/easyorders-auth.service';
import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { CommerceOutcomeSyncsRepository } from '../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { EasyOrdersConnectionsRepository } from '../src/infrastructure/database/repositories/easyorders-connections.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import {
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from '../src/infrastructure/spokes/easyorders/easyorders-api.client';
import {
  generateInstallToken,
  hashInstallToken,
} from '../src/shared/commerce/install-token';
import { installTokenHint } from '../src/infrastructure/spokes/easyorders/easyorders-install-token';
import { EasyOrdersOutcomeAdapter } from '../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { EasyOrdersRateLimiter } from '../src/infrastructure/spokes/easyorders/easyorders-rate-limiter';
import { EasyOrdersStatusUpdateHandler } from '../src/infrastructure/spokes/easyorders/easyorders-status-update.handler';
import { EasyOrdersWebhookService } from '../src/infrastructure/spokes/easyorders/easyorders-webhook.service';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import type { CommerceOutcomeSyncJobPayload } from '../src/modules/commerce-outcomes/commerce-outcome-sync.constants';
import { CommerceOutcomeSyncProcessor } from '../src/modules/commerce-outcomes/commerce-outcome-sync.processor';
import type {
  CommerceOutcomeSyncProducer,
  OutcomeSyncRetry,
} from '../src/modules/commerce-outcomes/commerce-outcome-sync.producer';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeDispatchResult,
} from '../src/shared/commerce/commerce-outcome';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../src/shared/config/easyorders.config';
import { encryptToken } from '../src/shared/utils/token-encryption.util';
import {
  selectOutcomeSync,
  toRemoteSync,
} from '../src/shared/verification/outcome-sync';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';

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

const namespace = `e06_outcome_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
let created = false;

/** Synthetic, generated per run: never a real key. */
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

const settings: EasyOrdersConfig = {
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
    if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return ENCRYPTION_KEY;
    throw new Error(`Unexpected configuration key ${key}`);
  },
} as unknown as ConfigService;

/** Every value that must never be logged, returned or stored in clear. */
const secrets = new Set<string>();
const logs: string[] = [];
const answers: unknown[] = [];

// --- The fake EasyOrders API: no request ever leaves the process. ---

interface RemoteOrder {
  storeId: string;
  status: string;
  /** The key that owns the order; any other key gets a 404. */
  key: string;
}
const remoteOrders = new Map<string, RemoteOrder>();
interface ProviderRequest {
  method: string;
  key: string;
  orderId: string;
  status?: string;
}
const providerRequests: ProviderRequest[] = [];
/** One-shot behaviors for the next write or read, consumed in order. */
type WriteFault =
  | 'lost_after_apply'
  | 'lost_before_apply'
  | 'throttled'
  | 'revoked';
const writeFaults: WriteFault[] = [];
const readFaults: Array<'ok' | 'unavailable' | 'throttled'> = [];

const fakeEasyOrders: EasyOrdersHttp = (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : '';
  const method = init?.method ?? 'GET';
  const key = new Headers(init?.headers).get('Api-Key') ?? '';
  const segments = url.split('/');
  const isWrite = method === 'PATCH';
  const orderId = decodeURIComponent(
    segments[isWrite ? segments.length - 2 : segments.length - 1],
  );
  const body =
    isWrite && typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { status: string })
      : undefined;
  providerRequests.push({ method, key, orderId, status: body?.status });
  const order = remoteOrders.get(orderId);
  const visible = order && order.key === key ? order : undefined;

  if (!isWrite) {
    const fault = readFaults.shift();
    if (fault === 'unavailable')
      return Promise.reject(new Error('socket hang up'));
    if (fault === 'throttled')
      return Promise.resolve(
        new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
      );
    return Promise.resolve(
      visible
        ? Response.json({
            id: orderId,
            store_id: visible.storeId,
            status: visible.status,
          })
        : new Response('', { status: 404 }),
    );
  }

  const fault = writeFaults.shift();
  if (fault === 'revoked')
    return Promise.resolve(new Response('', { status: 401 }));
  if (fault === 'throttled')
    return Promise.resolve(new Response('', { status: 429 }));
  if (fault === 'lost_before_apply')
    return Promise.reject(new DOMException('timed out', 'TimeoutError'));
  if (!visible) return Promise.resolve(new Response('', { status: 404 }));
  visible.status = body!.status;
  if (fault === 'lost_after_apply')
    return Promise.reject(new DOMException('timed out', 'TimeoutError'));
  return Promise.resolve(Response.json({}));
};

// --- Real repositories and services; only the edges are fakes. ---

const coreConfig = standaloneCreditBillingConfigService();
const connections = new EasyOrdersConnectionsRepository(db);
const ordersRepo = new OrdersRepository(db);
const syncs = new CommerceOutcomeSyncsRepository(db);
const events = new WebhookEventsRepository(db);
const integrations = new IntegrationsRepository(db as never, coreConfig);

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

const limiter = new EasyOrdersRateLimiter();
const adapter = new EasyOrdersOutcomeAdapter(
  connections,
  new EasyOrdersApiClient(fakeEasyOrders),
  limiter,
  config,
);
const registry = new CommerceOutcomeRegistryService(
  ordersRepo,
  [adapter],
  new CommerceOutcomeSyncTracker(syncs, retryProducer),
);
const retryWorker = new CommerceOutcomeSyncProcessor(syncs, registry);
/** The real disconnect (US-06-05), with the real outcome-sync repository. */
const connectionService = new EasyOrdersAuthService(
  connections,
  new EasyOrdersApiClient(fakeEasyOrders),
  config,
  new PhoneService(),
  syncs,
);

function ownerOf(merchant: { orgId: string }): AuthenticatedUser {
  return {
    userId: randomUUID(),
    orgId: merchant.orgId,
    role: 'owner',
    source: 'supabase',
  };
}

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

const queuedEvents: WebhookJobPayload[] = [];
const dispatcher = new WebhookDispatchService(
  {
    add: (_name: string, payload: WebhookJobPayload) => {
      queuedEvents.push(payload);
      return Promise.resolve();
    },
  } as never,
  events,
  { get: () => undefined } as never,
);
const webhooks = new EasyOrdersWebhookService(
  connections,
  new WebhookQueueProducer(events, integrations, dispatcher),
  config,
);
/** The hub is never reached by a status event; a call would fail the test. */
const hub = {
  handleNewOrder: () => {
    throw new Error('a status event must not create an order');
  },
};
const eventWorker = new WebhookQueueProcessor(
  [],
  events,
  integrations,
  hub as never,
  [new EasyOrdersStatusUpdateHandler(ordersRepo, syncs)],
);

async function drainEvents(): Promise<void> {
  while (queuedEvents.length > 0) {
    const data = queuedEvents.shift()!;
    await eventWorker.process(
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
  storeId: string;
  apiKey: string;
  webhookToken: string;
  statusSecret: string;
}

async function connectMerchant(): Promise<Merchant> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${`Store ${randomUUID().slice(0, 8)}`}, ${`org-${randomUUID()}`})
    RETURNING id`;
  const orgId = organization.id;
  const [integration] = await db
    .insert(tables.integrations)
    .values({
      orgId,
      platformType: 'easyorders',
      platformStoreUrl: `easyorders:${orgId}`,
      isActive: true,
    })
    .returning({ id: tables.integrations.id });
  const apiKey = `eo_${randomBytes(24).toString('base64url')}`;
  const webhookToken = generateInstallToken();
  const statusSecret = randomBytes(12).toString('base64');
  const ordersSecret = randomBytes(12).toString('base64');
  const storeId = randomUUID();
  secrets.add(apiKey).add(webhookToken).add(statusSecret).add(ordersSecret);
  await db.insert(tables.easyordersConnections).values({
    integrationId: integration.id,
    orgId,
    storeId,
    storeVerifiedAt: new Date().toISOString(),
    apiKeyEncrypted: encryptToken(apiKey, ENCRYPTION_KEY),
    webhookTokenHash: hashInstallToken(webhookToken),
    webhookTokenHint: installTokenHint(webhookToken),
    ordersWebhookSecretEncrypted: encryptToken(ordersSecret, ENCRYPTION_KEY),
    statusWebhookSecretEncrypted: encryptToken(statusSecret, ENCRYPTION_KEY),
    currency: 'EGP',
    phoneCountry: 'EG',
    connectedBy: randomUUID(),
  });
  return {
    orgId,
    integrationId: integration.id,
    storeId,
    apiKey,
    webhookToken,
    statusSecret,
  };
}

interface LocalOrder {
  orderId: string;
  externalOrderId: string;
  verificationId: string;
}

/** An order as ingestion left it, with its verification at a local result. */
async function orderWith(
  merchant: Merchant,
  local: {
    status: 'confirmed' | 'canceled' | 'no_reply';
    remoteStatus?: string;
  },
): Promise<LocalOrder> {
  const externalOrderId = randomUUID();
  const [order] = await db
    .insert(tables.orders)
    .values({
      orgId: merchant.orgId,
      integrationId: merchant.integrationId,
      externalOrderId,
      orderNumber: externalOrderId.slice(0, 8),
      customerPhone: '+201000000000',
      customerName: 'Test Customer',
      totalPrice: '750.00',
      currency: 'EGP',
    })
    .returning({ id: tables.orders.id });
  const [verification] = await db
    .insert(tables.verifications)
    .values({ orgId: merchant.orgId, orderId: order.id, status: local.status })
    .returning({ id: tables.verifications.id });
  remoteOrders.set(externalOrderId, {
    storeId: merchant.storeId,
    status: local.remoteStatus ?? 'pending',
    key: merchant.apiKey,
  });
  return {
    orderId: order.id,
    externalOrderId,
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

async function healthOf(merchant: Merchant): Promise<string> {
  const [row] = await client<{ health: string }[]>`
    SELECT health FROM easyorders_connections WHERE integration_id = ${merchant.integrationId}`;
  return row.health;
}

async function deliverStatus(
  merchant: Merchant,
  payload: Record<string, unknown>,
): Promise<number> {
  try {
    answers.push(
      await webhooks.handleStatusUpdate(
        merchant.webhookToken,
        merchant.statusSecret,
        { event_type: 'order-status-update', payment_ref_id: null, ...payload },
      ),
    );
    return 200;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    answers.push(error.getResponse());
    return error.getStatus();
  }
}

function eventsOf(merchant: Merchant) {
  return client<{ status: string; last_error: string | null }[]>`
    SELECT status, last_error FROM webhook_events
    WHERE integration_id = ${merchant.integrationId}
    ORDER BY received_at, id`;
}

const writes = () =>
  providerRequests.filter((request) => request.method === 'PATCH');

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

async function migrate(name: string) {
  const statements = readFileSync(
    resolve(__dirname, '../drizzle', name),
    'utf8',
  )
    .replaceAll('"public"', `"${namespace}"`)
    .split('--> statement-breakpoint')
    .filter((part) => part.trim());
  for (const statement of statements) await client.unsafe(statement);
}

describe('EasyOrders outcome synchronization PostgreSQL contract (US-06-04)', () => {
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
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
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
      tables.webhookEvents,
    ])
      await scaffold(table);
    await client.unsafe(`
      CREATE UNIQUE INDEX webhook_events_order_id_key ON webhook_events (order_id) WHERE order_id IS NOT NULL;
    `);
    // 0049 is this story's migration: twice, to prove it is re-runnable.
    await migrate('0047_easyorders_connection.sql');
    await migrate('0048_easyorders_ingestion.sql');
    for (let pass = 0; pass < 2; pass++)
      await migrate('0049_commerce_outcome_syncs.sql');
    // US-06-05: the credentials become nullable for a disconnect.
    await migrate('0050_easyorders_disconnect.sql');
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
    queuedEvents.length = 0;
    providerRequests.length = 0;
    writeFaults.length = 0;
    readFaults.length = 0;
    // A merchant per test: its own rate budget and its own key.
    merchant = await connectMerchant();
  });

  describe('approved mapping', () => {
    it.each<[CommerceOutcomeAction, 'confirmed' | 'canceled', string]>([
      ['customer_confirmation', 'confirmed', 'confirmed'],
      ['customer_cancellation', 'canceled', 'canceled'],
      ['merchant_no_reply_cancellation', 'canceled', 'canceled'],
    ])(
      '%s sets the store order to %s and records it against the order',
      async (action, localResult, remoteStatus) => {
        const order = await orderWith(merchant, { status: localResult });

        const result = await dispatch(merchant, order, action);

        expect(result).toMatchObject({ status: 'applied' });
        expect(remoteOrders.get(order.externalOrderId)!.status).toBe(
          remoteStatus,
        );
        expect(providerRequests).toEqual([
          {
            method: 'GET',
            key: merchant.apiKey,
            orderId: order.externalOrderId,
            status: undefined,
          },
          {
            method: 'PATCH',
            key: merchant.apiKey,
            orderId: order.externalOrderId,
            status: remoteStatus,
          },
        ]);
        expect(await syncsOf(order)).toEqual([
          expect.objectContaining({
            org_id: merchant.orgId,
            integration_id: merchant.integrationId,
            order_id: order.orderId,
            external_order_id: order.externalOrderId,
            correlation_id: order.verificationId,
            action,
            state: 'succeeded',
            attempts: 1,
            error_code: null,
            provider_status: remoteStatus,
          }),
        ]);
      },
    );

    it('keeps automatic no-reply local: unsupported, and nothing is sent', async () => {
      const order = await orderWith(merchant, { status: 'no_reply' });

      const result = await dispatch(
        merchant,
        order,
        'automatic_no_reply_tagging',
      );

      expect(result).toMatchObject({
        status: 'unsupported',
        reason: 'capability_not_supported',
      });
      expect(providerRequests).toHaveLength(0);
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('pending');
      expect(scheduled).toHaveLength(0);
      expect(await syncsOf(order)).toEqual([
        expect.objectContaining({
          action: 'automatic_no_reply_tagging',
          state: 'unsupported',
          error_code: 'capability_not_supported',
        }),
      ]);
      expect(await localStatus(order)).toBe('no_reply');
      // The merchant sees a local-only result, not a cancellation.
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
      expect(
        registry.supports('easyorders', 'merchant_no_reply_cancellation'),
      ).toBe(false);
      expect(providerRequests).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'unsupported' });
    });
  });

  describe('remote state', () => {
    it.each(['delivered', 'canceled', 'refunded'])(
      'does not overwrite an order that is already %s',
      async (remoteStatus) => {
        const order = await orderWith(merchant, {
          status: 'confirmed',
          remoteStatus,
        });

        const result = await dispatch(merchant, order, 'customer_confirmation');

        expect(result).toMatchObject({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
        });
        expect(writes()).toHaveLength(0);
        expect(remoteOrders.get(order.externalOrderId)!.status).toBe(
          remoteStatus,
        );
        expect(scheduled).toHaveLength(0);
        expect((await syncsOf(order))[0]).toMatchObject({
          state: 'failed',
          error_code: 'remote_state_conflict',
          provider_status: remoteStatus,
        });
        expect(await localStatus(order)).toBe('confirmed');
      },
    );

    it('does not write again for a repeated outcome', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });

      await dispatch(merchant, order, 'customer_confirmation');
      await dispatch(merchant, order, 'customer_confirmation');

      expect(writes()).toHaveLength(1);
      const rows = await syncsOf(order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'succeeded' });
    });
  });

  describe('tenant isolation', () => {
    it('refuses a dispatch that names another tenant’s order, and never uses that tenant’s key', async () => {
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

      expect(providerRequests).toHaveLength(0);
      expect(remoteOrders.get(theirs.externalOrderId)!.status).toBe('pending');
      expect(await syncsOf(theirs)).toHaveLength(0);
    });

    it('uses each order’s own key and writes one row per source', async () => {
      const other = await connectMerchant();
      const mine = await orderWith(merchant, { status: 'confirmed' });
      const theirs = await orderWith(other, { status: 'canceled' });

      await dispatch(merchant, mine, 'customer_confirmation');
      await dispatch(other, theirs, 'customer_cancellation');

      for (const request of providerRequests)
        expect(request.key).toBe(
          request.orderId === mine.externalOrderId
            ? merchant.apiKey
            : other.apiKey,
        );
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

    it('fails closed when the store answers for a different store', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      remoteOrders.get(order.externalOrderId)!.storeId = randomUUID();

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'store_mismatch',
      });
      expect(writes()).toHaveLength(0);
    });
  });

  describe('timeout after a possible success', () => {
    it('reads the order back and reports success without writing twice', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      writeFaults.push('lost_after_apply');

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({ status: 'applied' });
      expect(providerRequests.map((request) => request.method)).toEqual([
        'GET',
        'PATCH',
        'GET',
      ]);
      expect(scheduled).toHaveLength(0);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 1,
      });
    });

    it('stays pending, keeps the local result, and reconciles on the retry', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      // The write is lost, and so is the read-back.
      writeFaults.push('lost_after_apply');
      readFaults.push('ok', 'unavailable');

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

      // The retry read the order first, found it confirmed, and did not
      // write a second time.
      expect(writes()).toHaveLength(1);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'succeeded',
        attempts: 2,
        error_code: null,
      });
    });

    it('writes again only after reading that the first write was not taken', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      writeFaults.push('lost_before_apply');

      await dispatch(merchant, order, 'customer_cancellation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });
      await runRetries();

      expect(providerRequests.map((request) => request.method)).toEqual([
        'GET',
        'PATCH',
        'GET',
        'GET',
        'PATCH',
      ]);
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('canceled');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });
  });

  describe('throttling and transient failures', () => {
    it('waits for a 429, without spending an attempt, then succeeds', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      readFaults.push('throttled');

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
      // The integration is paused: a retry that came early is told to wait.
      await runRetries(1);
      expect(providerRequests).toHaveLength(1);
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'pending',
        error_code: 'source_rate_budget_exhausted',
        deferrals: 2,
      });
    });

    it('gives up after bounded attempts and leaves a failure the merchant can retry', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      for (let attempt = 0; attempt < 10; attempt += 1)
        readFaults.push('unavailable');

      await dispatch(merchant, order, 'customer_confirmation');
      const ran = await runRetries();

      expect(ran).toBe(4);
      expect(providerRequests).toHaveLength(5);
      const [row] = await syncsOf(order);
      expect(row).toMatchObject({
        state: 'failed',
        error_code: 'source_unavailable',
        attempts: 5,
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
      readFaults.length = 0;
      expect(await syncs.resetForRetry(row.id, merchant.orgId)).toMatchObject({
        state: 'pending',
        attempts: 0,
      });
      await dispatch(merchant, order, 'customer_confirmation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('confirmed');
    });

    it('shows a failure instead of waiting forever when the retry cannot be queued', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      readFaults.push('unavailable');
      retryQueue.down = true;

      await dispatch(merchant, order, 'customer_confirmation');

      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'retry_not_scheduled',
      });
    });

    it('does not let another organization reopen a failed sync', async () => {
      const other = await connectMerchant();
      const order = await orderWith(merchant, {
        status: 'confirmed',
        remoteStatus: 'delivered',
      });
      await dispatch(merchant, order, 'customer_confirmation');
      const [row] = await syncsOf(order);

      expect(await syncs.resetForRetry(row.id, other.orgId)).toBeUndefined();
      expect(await syncs.findByIdForOrg(row.id, other.orgId)).toBeUndefined();
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'failed' });
    });
  });

  describe('a revoked key', () => {
    it('stops at once, flags assisted action and marks the connection', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      writeFaults.push('revoked');

      const result = await dispatch(merchant, order, 'customer_confirmation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'source_credentials_rejected',
        requiresAssistance: true,
      });
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
  });

  describe('status webhook feedback loop', () => {
    it('recognizes its own write coming back and does nothing', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');
      const requestsAfterWrite = providerRequests.length;
      const [before] = await syncsOf(order);

      // EasyOrders reflects the change, and reflects it a second time.
      for (let delivery = 0; delivery < 2; delivery += 1)
        expect(
          await deliverStatus(merchant, {
            order_id: order.externalOrderId,
            old_status: 'pending',
            new_status: 'confirmed',
          }),
        ).toBe(200);
      await drainEvents();

      expect(await eventsOf(merchant)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
      ]);
      expect(providerRequests).toHaveLength(requestsAfterWrite);
      expect(scheduled).toHaveLength(0);
      expect(await syncsOf(order)).toEqual([before]);
      expect(await localStatus(order)).toBe('confirmed');
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('confirmed');
    });

    it('recognizes the echo of a write whose answer never arrived', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      writeFaults.push('lost_after_apply');
      readFaults.push('ok', 'unavailable');
      await dispatch(merchant, order, 'customer_cancellation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });

      await deliverStatus(merchant, {
        order_id: order.externalOrderId,
        old_status: 'pending',
        new_status: 'canceled',
      });
      await drainEvents();

      expect(await eventsOf(merchant)).toEqual([
        { status: 'skipped', last_error: 'reflected_outcome' },
      ]);
      expect(writes()).toHaveLength(1);
    });

    it('only records a change the merchant made in the store', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, order, 'customer_confirmation');
      const requestsAfterWrite = providerRequests.length;

      await deliverStatus(merchant, {
        order_id: order.externalOrderId,
        old_status: 'confirmed',
        new_status: 'in_delivery',
      });
      await drainEvents();

      expect(await eventsOf(merchant)).toEqual([
        { status: 'skipped', last_error: 'remote_status_observed' },
      ]);
      expect(providerRequests).toHaveLength(requestsAfterWrite);
      expect(await localStatus(order)).toBe('confirmed');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'succeeded' });
    });

    it('changes nothing for another tenant’s order id on this tenant’s token', async () => {
      const other = await connectMerchant();
      const theirs = await orderWith(other, { status: 'confirmed' });
      await dispatch(other, theirs, 'customer_confirmation');
      const [before] = await syncsOf(theirs);

      await deliverStatus(merchant, {
        order_id: theirs.externalOrderId,
        old_status: 'pending',
        new_status: 'confirmed',
      });
      await drainEvents();

      expect(await eventsOf(merchant)).toEqual([
        { status: 'skipped', last_error: 'order_not_owned' },
      ]);
      expect(await eventsOf(other)).toHaveLength(0);
      expect(await syncsOf(theirs)).toEqual([before]);
      expect(await localStatus(theirs)).toBe('confirmed');
    });
  });

  describe('a disconnected source (US-06-05)', () => {
    it('a retry queued before the disconnect makes no request and ends failed', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      readFaults.push('unavailable');
      await dispatch(merchant, order, 'customer_confirmation');
      expect((await syncsOf(order))[0]).toMatchObject({ state: 'pending' });
      expect(scheduled).toHaveLength(1);
      const requestsBefore = providerRequests.length;

      await connectionService.disconnect(ownerOf(merchant));

      // Closed at the disconnect, not left waiting for a job that may be lost.
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'integration_inactive',
      });
      await runRetries();
      expect(providerRequests).toHaveLength(requestsBefore);
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('pending');
      expect((await syncsOf(order))[0]).toMatchObject({
        state: 'failed',
        error_code: 'integration_inactive',
      });
      expect(await localStatus(order)).toBe('confirmed');
    });

    it('a reply after the disconnect is kept locally and nothing is sent to EasyOrders', async () => {
      const order = await orderWith(merchant, { status: 'canceled' });
      await connectionService.disconnect(ownerOf(merchant));

      const result = await dispatch(merchant, order, 'customer_cancellation');

      expect(result).toMatchObject({
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      });
      expect(providerRequests).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
      expect(remoteOrders.get(order.externalOrderId)!.status).toBe('pending');
      expect(await localStatus(order)).toBe('canceled');
    });

    it('the adapter itself refuses a disconnected connection, without a request', async () => {
      const order = await orderWith(merchant, { status: 'confirmed' });
      await connectionService.disconnect(ownerOf(merchant));

      // Past the registry's check, as a disconnect landing mid-dispatch would be.
      const result = await adapter.execute({
        orgId: merchant.orgId,
        integrationId: merchant.integrationId,
        externalOrderId: order.externalOrderId,
        action: 'customer_confirmation',
        correlationId: order.verificationId,
        connection: {
          id: merchant.integrationId,
          orgId: merchant.orgId,
          platformType: 'easyorders',
          platformStoreUrl: `easyorders:${merchant.orgId}`,
          accessToken: null,
          isActive: true,
          metadata: {},
        },
      });

      expect(result).toEqual({
        status: 'permanent_failure',
        errorCode: 'integration_inactive',
      });
      expect(providerRequests).toHaveLength(0);
    });

    it('closes only its own waiting rows, and another tenant cannot disconnect it', async () => {
      const other = await connectMerchant();
      const mine = await orderWith(merchant, { status: 'confirmed' });
      const theirs = await orderWith(other, { status: 'confirmed' });
      readFaults.push('unavailable', 'unavailable');
      await dispatch(merchant, mine, 'customer_confirmation');
      await dispatch(other, theirs, 'customer_confirmation');

      await connectionService.disconnect(ownerOf(other));

      expect((await syncsOf(mine))[0]).toMatchObject({ state: 'pending' });
      expect((await syncsOf(theirs))[0]).toMatchObject({ state: 'failed' });
      const [source] = await client<{ is_active: boolean }[]>`
        SELECT is_active FROM integrations WHERE id = ${merchant.integrationId}`;
      expect(source.is_active).toBe(true);
      expect(
        await syncs.failPendingForIntegration(
          other.orgId,
          merchant.integrationId,
          'integration_inactive',
        ),
      ).toBe(0);
      expect((await syncsOf(mine))[0]).toMatchObject({ state: 'pending' });
    });
  });

  describe('store-update health (US-06-05)', () => {
    const since = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const summaryOf = (target: Merchant) =>
      syncs.summarizeForIntegration(
        target.orgId,
        target.integrationId,
        since(),
      );

    it('reports nothing for a store with no outcomes yet', async () => {
      await expect(summaryOf(merchant)).resolves.toEqual({
        failedCount: 0,
        lastFailedAt: null,
        requiresAssistance: false,
        pendingCount: 0,
      });
    });

    it('an unsupported outcome is not counted as a failed store update', async () => {
      const order = await orderWith(merchant, { status: 'no_reply' });
      await dispatch(merchant, order, 'automatic_no_reply_tagging');
      const done = await orderWith(merchant, { status: 'confirmed' });
      await dispatch(merchant, done, 'customer_confirmation');

      await expect(summaryOf(merchant)).resolves.toEqual({
        failedCount: 0,
        lastFailedAt: null,
        requiresAssistance: false,
        pendingCount: 0,
      });
    });

    it('counts failures and waiting rows apart, and flags a rejected key', async () => {
      const waiting = await orderWith(merchant, { status: 'confirmed' });
      readFaults.push('unavailable');
      await dispatch(merchant, waiting, 'customer_confirmation');
      const conflict = await orderWith(merchant, {
        status: 'confirmed',
        remoteStatus: 'delivered',
      });
      await dispatch(merchant, conflict, 'customer_confirmation');

      const before = await summaryOf(merchant);
      expect(before).toMatchObject({
        failedCount: 1,
        requiresAssistance: false,
        pendingCount: 1,
      });
      expect(before.lastFailedAt).not.toBeNull();

      const revoked = await orderWith(merchant, { status: 'confirmed' });
      writeFaults.push('revoked');
      await dispatch(merchant, revoked, 'customer_confirmation');

      await expect(summaryOf(merchant)).resolves.toMatchObject({
        failedCount: 2,
        requiresAssistance: true,
        pendingCount: 1,
      });
    });

    it('never reports another tenant’s store updates, and still reports after a disconnect', async () => {
      const other = await connectMerchant();
      const order = await orderWith(merchant, {
        status: 'confirmed',
        remoteStatus: 'delivered',
      });
      await dispatch(merchant, order, 'customer_confirmation');

      await expect(summaryOf(other)).resolves.toMatchObject({ failedCount: 0 });
      await expect(
        syncs.summarizeForIntegration(
          other.orgId,
          merchant.integrationId,
          since(),
        ),
      ).resolves.toMatchObject({ failedCount: 0, pendingCount: 0 });

      await connectionService.disconnect(ownerOf(merchant));
      await expect(summaryOf(merchant)).resolves.toMatchObject({
        failedCount: 1,
        pendingCount: 0,
      });
      expect(await syncsOf(order)).toHaveLength(1);
    });
  });

  describe('secrets', () => {
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
