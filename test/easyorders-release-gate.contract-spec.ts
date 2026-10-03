import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DelayedError, type Job, type Queue } from 'bullmq';
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
import { EasyOrdersApiClient } from '../src/infrastructure/spokes/easyorders/easyorders-api.client';
import { EasyOrdersAuthService } from '../src/infrastructure/spokes/easyorders/easyorders-auth.service';
import { hashInstallToken } from '../src/infrastructure/spokes/easyorders/easyorders-install-token';
import { EasyOrdersOrderEligibilityStrategy } from '../src/infrastructure/spokes/easyorders/easyorders-order-eligibility.strategy';
import { EasyOrdersOrderNormalizer } from '../src/infrastructure/spokes/easyorders/easyorders-order.normalizer';
import { EasyOrdersOutcomeAdapter } from '../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { EasyOrdersRateLimiter } from '../src/infrastructure/spokes/easyorders/easyorders-rate-limiter';
import { EasyOrdersStatusUpdateHandler } from '../src/infrastructure/spokes/easyorders/easyorders-status-update.handler';
import { EasyOrdersWebhookService } from '../src/infrastructure/spokes/easyorders/easyorders-webhook.service';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { ShopifyOrderEligibilityStrategy } from '../src/infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneOutcomeAdapter } from '../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import type { CommerceOutcomeSyncJobPayload } from '../src/modules/commerce-outcomes/commerce-outcome-sync.constants';
import { OUTCOME_SYNC_MAX_ATTEMPTS } from '../src/modules/commerce-outcomes/commerce-outcome-sync.policy';
import { CommerceOutcomeSyncProcessor } from '../src/modules/commerce-outcomes/commerce-outcome-sync.processor';
import { CommerceOutcomeSyncProducer } from '../src/modules/commerce-outcomes/commerce-outcome-sync.producer';
import { VerificationAutomationJobType } from '../src/modules/verification-automation/verification-automation.constants';
import { VerificationAutomationProcessor } from '../src/modules/verification-automation/verification-automation.processor';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { VerificationsService } from '../src/modules/verifications/verifications.service';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { shopifyOrderFixture } from '../src/modules/webhook-queue/normalizers/fixtures/shopify-order.fixture';
import { ShopifyOrderNormalizer } from '../src/modules/webhook-queue/normalizers/shopify-order.normalizer';
import { StandaloneManualOrderNormalizer } from '../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookDispatchReconciler } from '../src/modules/webhook-queue/webhook-dispatch-reconciler.service';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
} from '../src/shared/commerce/commerce-outcome';
import { COMMERCE_OUTCOME_ACTIONS } from '../src/shared/commerce/commerce-outcome';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../src/shared/config/easyorders.config';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { PhoneService } from '../src/shared/services/phone.service';
import {
  easyOrdersProviderFake,
  type FakeEasyOrdersRequest,
} from './contracts/easyorders-provider-fake';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import {
  orderCreatedFixture,
  type EasyOrdersOrderFixture,
} from './fixtures/easyorders/load';

/**
 * US-06-06 release gate: one EasyOrders store through install, order, send,
 * customer outcome and store status, over PostgreSQL, with two tenants and a
 * Shopify source beside it. Real repositories and services; the edges are
 * fakes: the provider fake (never EasyOrders), the messaging port (never
 * Meta) and the BullMQ queues, whose jobs are recorded and run in process.
 */

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

const namespace = `e06_gate_${randomUUID().replaceAll('-', '')}`;
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
  outcomeSyncEnabled: true,
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

// --- The edges ---

const provider = easyOrdersProviderFake();
/** The key probe each install makes, kept apart from what a case asserts. */
const installProbes = new WeakSet<FakeEasyOrdersRequest>();
/** Requests to EasyOrders after the install: lookups and status writes. */
function storeRequests(key?: string): FakeEasyOrdersRequest[] {
  return (key ? provider.requestsWith(key) : provider.requests).filter(
    (request) => !installProbes.has(request),
  );
}

interface RecordedSend {
  to: string;
  verificationId: string;
}
const sends: RecordedSend[] = [];
const messaging: MessagingPort = {
  sendVerificationTemplate(params) {
    sends.push({ to: params.to, verificationId: params.verificationId });
    return Promise.resolve({ messages: [{ id: `wamid-e06-${sends.length}` }] });
  },
};

interface AutomationJob {
  kind: 'initial' | 'follow_up' | 'no_reply';
  verificationId: string;
  orgId: string;
  dueAt: Date;
}
const automationJobs: AutomationJob[] = [];
const record =
  (kind: AutomationJob['kind']) => (params: Omit<AutomationJob, 'kind'>) => {
    automationJobs.push({ kind, ...params });
    return Promise.resolve();
  };
const automation = {
  enqueueInitialSend: record('initial'),
  enqueueFollowUp: record('follow_up'),
  enqueueNoReplyEscalation: record('no_reply'),
};

/**
 * The outcome-retry queue with BullMQ's rule: an `add` whose job id already
 * exists adds nothing, and a finished job keeps its id.
 */
const retryQueue = {
  down: false,
  ids: new Set<string>(),
  waiting: [] as CommerceOutcomeSyncJobPayload[],
  delays: [] as number[],
};
const retryProducer = new CommerceOutcomeSyncProducer({
  add: (
    _name: string,
    payload: CommerceOutcomeSyncJobPayload,
    options: { jobId: string; delay: number },
  ) => {
    if (retryQueue.down) return Promise.reject(new Error('redis unavailable'));
    if (!retryQueue.ids.has(options.jobId)) {
      retryQueue.ids.add(options.jobId);
      retryQueue.waiting.push(payload);
      retryQueue.delays.push(options.delay);
    }
    return Promise.resolve();
  },
} as unknown as Queue<CommerceOutcomeSyncJobPayload>);

// --- Real repositories and services ---

const connections = new EasyOrdersConnectionsRepository(db);
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

const limiter = new EasyOrdersRateLimiter();
const api = new EasyOrdersApiClient(provider.http);
const phones = new PhoneService();

/** What the Shopify adapter was asked to do: the Shopify spoke is not run. */
const shopifyOutcomes: Array<{
  integrationId: string;
  action: CommerceOutcomeAction;
}> = [];
const shopifyAdapter: CommerceOutcomeAdapter = {
  platformType: 'shopify',
  requiresActiveConnection: true,
  capabilities: new Set(COMMERCE_OUTCOME_ACTIONS),
  execute(request) {
    shopifyOutcomes.push({
      integrationId: request.integrationId,
      action: request.action,
    });
    return Promise.resolve({ status: 'applied' });
  },
};

// The registries as the application binds them: every platform, by type.
const registry = new CommerceOutcomeRegistryService(
  ordersRepo,
  [
    shopifyAdapter,
    new StandaloneOutcomeAdapter(),
    new EasyOrdersOutcomeAdapter(connections, api, limiter, easyOrdersConfig),
  ],
  new CommerceOutcomeSyncTracker(syncs, retryProducer),
);
const retryWorker = new CommerceOutcomeSyncProcessor(syncs, registry);
const send = new VerificationSendService(
  verificationsRepo,
  ordersRepo,
  billing,
  creditEligibility,
  dispatches,
  messaging,
);
const hub = new VerificationHubService(
  ordersRepo,
  verificationsRepo,
  registry,
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
  [new EasyOrdersStatusUpdateHandler(ordersRepo, syncs)],
);
const automationProcessor = new VerificationAutomationProcessor(
  verificationsRepo,
  ordersRepo,
  send,
  hub,
  registry,
  billing,
);
const whatsapp = new WhatsAppWebhookService(verificationsRepo, hub, dispatches);
const verifications = new VerificationsService(
  verificationsRepo,
  billing,
  integrations,
  ordersRepo,
  registry,
  hub,
  syncs,
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
const reconciler = new WebhookDispatchReconciler(events, dispatcher, {
  get: () => undefined,
} as never);
const producer = new WebhookQueueProducer(events, integrations, dispatcher);
const webhooks = new EasyOrdersWebhookService(
  connections,
  producer,
  easyOrdersConfig,
);
const auth = new EasyOrdersAuthService(
  connections,
  api,
  easyOrdersConfig,
  phones,
  syncs,
);

// --- Running what the queues hold ---

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

/** Runs waiting outcome retries, as the worker would once each is due. */
async function runRetries(limit = 20): Promise<number> {
  let ran = 0;
  while (retryQueue.waiting.length > 0 && ran < limit) {
    const data = retryQueue.waiting.shift()!;
    retryQueue.delays.shift();
    await retryWorker.process({
      id: `retry-${ran}`,
      data,
    } as Job<CommerceOutcomeSyncJobPayload>);
    ran += 1;
  }
  return ran;
}

async function runAutomation(
  verificationId: string,
  kind: 'follow_up' | 'no_reply',
): Promise<void> {
  const job = automationJobs.find(
    (candidate) =>
      candidate.verificationId === verificationId && candidate.kind === kind,
  );
  if (!job) throw new Error(`No ${kind} job was scheduled`);
  await automationProcessor.process({
    id: `${kind}-${verificationId}`,
    name:
      kind === 'follow_up'
        ? VerificationAutomationJobType.FOLLOW_UP
        : VerificationAutomationJobType.ESCALATE_NO_REPLY,
    data: {
      verificationId,
      orgId: job.orgId,
      scheduledAt: job.dueAt.toISOString(),
    },
  } as Parameters<typeof automationProcessor.process>[0]);
}

/** A customer tapping a quick-reply button, as Meta posts it. */
async function reply(
  verificationId: string,
  phone: string,
  action: 'confirm' | 'cancel',
): Promise<void> {
  await whatsapp.processIncoming({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: phone.replace(/^\+/, ''),
                  id: `wamid-reply-${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'button',
                  button: {
                    text: action === 'confirm' ? 'Confirm' : 'Cancel',
                    payload: `${action}_${verificationId}`,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  } as never);
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

function secret(): string {
  const value = randomBytes(12).toString('base64');
  secrets.add(value);
  return value;
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

async function newOrganization(): Promise<AuthenticatedUser> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${`Store ${randomUUID().slice(0, 8)}`}, ${`org-${randomUUID()}`})
    RETURNING id`;
  settings.pilotOrgIds.push(organization.id);
  return {
    userId: randomUUID(),
    orgId: organization.id,
    role: 'owner',
    source: 'supabase',
  };
}

/** The install link's two tokens, as the seller's browser carries them. */
async function startInstall(owner: AuthenticatedUser) {
  const started = await auth.startInstall(owner, { locale: 'ar' });
  const params = new URLSearchParams(started.installUrl.split('?')[1]);
  const callbackToken = params.get('callback_url')!.split('/').pop()!;
  const webhookToken = params.get('orders_webhook')!.split('/').pop()!;
  secrets.add(callbackToken).add(webhookToken);
  return { callbackToken, webhookToken };
}

/** Accept in EasyOrders: a new key for the store, posted to the callback. */
async function install(
  owner: AuthenticatedUser,
  storeId: string,
): Promise<{ apiKey: string; webhookToken: string }> {
  const { callbackToken, webhookToken } = await startInstall(owner);
  const apiKey = provider.issueKey(storeId);
  secrets.add(apiKey);
  await auth.handleCallback(callbackToken, {
    api_key: apiKey,
    store_id: storeId,
  });
  for (const probe of provider.requestsWith(apiKey)) installProbes.add(probe);
  return { apiKey, webhookToken };
}

/**
 * Connects a store the way a seller does: install, callback, the two webhook
 * secrets, currency and phone country. The store claim is left unverified
 * unless asked: it is verified by the first order read with the stored key.
 */
async function connectMerchant(
  options: { verified?: boolean } = {},
): Promise<Merchant> {
  const owner = await newOrganization();
  const storeId = randomUUID();
  const { apiKey, webhookToken } = await install(owner, storeId);
  const ordersSecret = secret();
  const statusSecret = secret();
  await auth.saveWebhookSecrets(owner, { ordersSecret, statusSecret });
  await auth.saveOrderSettings(owner, { currency: 'EGP', phoneCountry: 'EG' });
  const [integration] = await client<{ id: string }[]>`
    UPDATE integrations SET onboarding_status = 'completed'
    WHERE org_id = ${owner.orgId}
    RETURNING id`;
  if (options.verified !== false)
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

let phoneSuffix = 1_000;

/** A storefront order: held by EasyOrders, and its order-created payload. */
function placeOrder(
  merchant: Merchant,
  overrides: Record<string, unknown> = {},
): EasyOrdersOrderFixture {
  phoneSuffix += 1;
  const payload = {
    ...orderCreatedFixture(),
    id: randomUUID(),
    store_id: merchant.storeId,
    phone: `0100000${phoneSuffix}`,
    ...overrides,
  } as EasyOrdersOrderFixture;
  provider.placeOrder(merchant.storeId, payload.id, payload);
  return payload;
}

function deliverOrder(
  merchant: Merchant,
  payload: unknown,
  overrides: { token?: string; secret?: string } = {},
): Promise<Answer> {
  return answer(
    webhooks.handleOrderCreated(
      overrides.token ?? merchant.webhookToken,
      overrides.secret ?? merchant.ordersSecret,
      payload,
    ),
  );
}

function deliverStatus(
  merchant: Merchant,
  payload: Record<string, unknown>,
  overrides: { token?: string; secret?: string } = {},
): Promise<Answer> {
  return answer(
    webhooks.handleStatusUpdate(
      overrides.token ?? merchant.webhookToken,
      overrides.secret ?? merchant.statusSecret,
      { event_type: 'order-status-update', payment_ref_id: null, ...payload },
    ),
  );
}

interface SentOrder {
  payload: EasyOrdersOrderFixture;
  verificationId: string;
  phone: string;
}

/** An order delivered, processed and sent: waiting for the customer. */
async function sentOrder(merchant: Merchant): Promise<SentOrder> {
  const payload = placeOrder(merchant);
  await deliverOrder(merchant, payload);
  await drain();
  const [verification] = await client<{ id: string }[]>`
    SELECT v.id FROM verifications v JOIN orders o ON o.id = v.order_id
    WHERE o.integration_id = ${merchant.integrationId}
      AND o.external_order_id = ${payload.id}`;
  if (!verification) throw new Error('The order produced no verification');
  const sent = sends.find((item) => item.verificationId === verification.id);
  if (!sent) throw new Error('The order was not sent');
  return { payload, verificationId: verification.id, phone: sent.to };
}

// --- Reconciliation: what one tenant holds, counted from the database ---

interface Reconciliation {
  events: number;
  completedEvents: number;
  orders: number;
  verifications: number;
  sends: number;
  usage: number;
  appliedSyncs: number;
  remoteWrites: number;
}

async function reconcile(merchant: {
  orgId: string;
  integrationId: string;
  apiKey?: string;
}): Promise<Reconciliation> {
  const [counts] = await client<
    {
      events: number;
      completed_events: number;
      orders: number;
      verifications: number;
      usage: number;
      applied_syncs: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM webhook_events WHERE integration_id = ${merchant.integrationId}) AS events,
      (SELECT count(*)::int FROM webhook_events WHERE integration_id = ${merchant.integrationId} AND status = 'completed') AS completed_events,
      (SELECT count(*)::int FROM orders WHERE integration_id = ${merchant.integrationId}) AS orders,
      (SELECT count(*)::int FROM verifications WHERE org_id = ${merchant.orgId}) AS verifications,
      (SELECT coalesce(sum(consumed_count), 0)::int FROM integration_monthly_usage WHERE integration_id = ${merchant.integrationId}) AS usage,
      (SELECT count(*)::int FROM commerce_outcome_syncs WHERE integration_id = ${merchant.integrationId} AND state = 'succeeded') AS applied_syncs`;
  const owned = await client<{ id: string }[]>`
    SELECT id FROM verifications WHERE org_id = ${merchant.orgId}`;
  const ids = new Set(owned.map((row) => row.id));
  return {
    events: counts.events,
    completedEvents: counts.completed_events,
    orders: counts.orders,
    verifications: counts.verifications,
    sends: sends.filter((item) => ids.has(item.verificationId)).length,
    usage: counts.usage,
    appliedSyncs: counts.applied_syncs,
    remoteWrites: merchant.apiKey
      ? provider
          .writes(merchant.apiKey)
          .filter((request) => request.answered === 200).length
      : 0,
  };
}

/** Every row a tenant owns, to prove nothing moved, changed or went away. */
async function historyOf(merchant: Merchant) {
  const rows = (query: Promise<Record<string, unknown>[]>) =>
    query.then((result) => JSON.stringify(result));
  return {
    orders: await rows(
      client`SELECT * FROM orders WHERE integration_id = ${merchant.integrationId} ORDER BY id`,
    ),
    verifications: await rows(
      client`SELECT * FROM verifications WHERE org_id = ${merchant.orgId} ORDER BY id`,
    ),
    events: await rows(
      client`SELECT * FROM webhook_events WHERE integration_id = ${merchant.integrationId} ORDER BY id`,
    ),
    usage: await rows(
      client`SELECT * FROM integration_monthly_usage WHERE integration_id = ${merchant.integrationId} ORDER BY id`,
    ),
    dispatches: await rows(
      client`SELECT * FROM verification_message_dispatches WHERE org_id = ${merchant.orgId} ORDER BY id`,
    ),
    syncs: await rows(
      client`SELECT * FROM commerce_outcome_syncs WHERE integration_id = ${merchant.integrationId} ORDER BY id`,
    ),
  };
}

function syncsOf(merchant: Merchant, verificationId: string) {
  return client<
    {
      id: string;
      action: string;
      state: string;
      attempts: number;
      deferrals: number;
      error_code: string | null;
      provider_status: string | null;
      requires_assistance: boolean;
    }[]
  >`
    SELECT * FROM commerce_outcome_syncs
    WHERE org_id = ${merchant.orgId} AND correlation_id = ${verificationId}
    ORDER BY created_at`;
}

async function verificationStatus(verificationId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`
    SELECT status FROM verifications WHERE id = ${verificationId}`;
  return row.status;
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

function eventsOf(merchant: { integrationId: string }) {
  return client<{ id: string; status: string; last_error: string | null }[]>`
    SELECT id, status, last_error FROM webhook_events
    WHERE integration_id = ${merchant.integrationId}
    ORDER BY received_at, id`;
}

// --- A Shopify source beside the EasyOrders ones ---

interface ShopifyStore {
  orgId: string;
  integrationId: string;
  domain: string;
}

async function connectShopify(): Promise<ShopifyStore> {
  const orgId = randomUUID();
  const domain = `gate-${orgId.slice(0, 8)}.myshopify.com`;
  await db
    .insert(tables.organizations)
    .values({ id: orgId, name: 'Gate Shopify store', slug: orgId });
  const now = new Date().toISOString();
  const [integration] = await db
    .insert(tables.integrations)
    .values({
      orgId,
      platformType: 'shopify',
      platformStoreUrl: domain,
      storeName: 'Gate Shopify store',
      isActive: true,
      onboardingStatus: 'completed',
      isAutoVerifyEnabled: true,
      followUpEnabled: false,
      escalationEnabled: false,
      quietHoursEnabled: false,
      sendDelayMinutes: 0,
      billingStatus: 'active',
      billingPlanId: 'starter',
      billingActivatedAt: now,
      billingStatusUpdatedAt: now,
    })
    .returning({ id: tables.integrations.id });
  return { orgId, integrationId: integration.id, domain };
}

/** One Shopify order from webhook to a confirmed outcome at its adapter. */
async function shopifyJourney(store: ShopifyStore) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  const sendsBefore = sends.length;
  const outcomesBefore = shopifyOutcomes.length;
  const ingested = await producer.ingest({
    platform: 'shopify',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: `orders/create:${id}`,
    storeDomain: store.domain,
    rawPayload: shopifyOrderFixture({ id, order_number: id }),
  });
  const ends = await drain();
  const [verification] = await client<{ id: string }[]>`
    SELECT v.id FROM verifications v JOIN orders o ON o.id = v.order_id
    WHERE o.integration_id = ${store.integrationId}
      AND o.external_order_id = ${String(id)}`;
  const sent = sends.slice(sendsBefore);
  if (verification && sent[0])
    await reply(verification.id, sent[0].to, 'confirm');
  return {
    ingested,
    ends,
    sends: sent.length,
    status: verification ? await verificationStatus(verification.id) : null,
    outcomes: shopifyOutcomes.slice(outcomesBefore),
  };
}

// --- Schema: the Drizzle tables, then the real migrations ---

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

describe('EasyOrders release gate PostgreSQL contract (US-06-06)', () => {
  /** Tenant B and the Shopify store stand beside every case. */
  let bystander: Merchant;
  let bystanderOrder: SentOrder;
  let shopify: ShopifyStore;

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
      '0047_easyorders_connection.sql',
      '0048_easyorders_ingestion.sql',
      '0049_commerce_outcome_syncs.sql',
      '0050_easyorders_disconnect.sql',
    ])
      await migrate(name);
    // Fault injection for the install callback: while the flag row says so,
    // the credentials insert fails after the integration was inserted.
    await client.unsafe(`
      CREATE TABLE fault_switch (fail boolean NOT NULL);
      INSERT INTO fault_switch VALUES (false);
      CREATE FUNCTION fail_connection_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (SELECT fail FROM fault_switch) THEN
          RAISE EXCEPTION 'injected connection insert failure';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER easyorders_connections_fault BEFORE INSERT ON easyorders_connections
        FOR EACH ROW EXECUTE FUNCTION fail_connection_insert();
    `);

    bystander = await connectMerchant();
    bystanderOrder = await sentOrder(bystander);
    shopify = await connectShopify();
  });

  afterAll(async () => {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  let bystanderBefore: Awaited<ReturnType<typeof historyOf>>;

  beforeEach(async () => {
    settings.enabled = true;
    settings.ingestionEnabled = true;
    settings.outcomeSyncEnabled = true;
    queue.down = false;
    retryQueue.down = false;
    retryQueue.waiting.length = 0;
    retryQueue.delays.length = 0;
    queued.length = 0;
    provider.clear();
    bystanderBefore = await historyOf(bystander);
  });

  /** No case may move tenant B's rows or spend tenant B's key. */
  afterEach(async () => {
    expect(await historyOf(bystander)).toEqual(bystanderBefore);
    expect(provider.requestsWith(bystander.apiKey)).toHaveLength(0);
    expect(provider.statusOf(bystanderOrder.payload.id)).toBe('pending');
  });

  describe('AC1 journey: install, order, send, customer outcome, store status', () => {
    it.each([
      ['confirm', 'confirmed', 'customer_confirmation'],
      ['cancel', 'canceled', 'customer_cancellation'],
    ] as const)(
      'a customer %s ends as %s in EasyOrders, with every count reconciled',
      async (action, target, outcome) => {
        const merchant = await connectMerchant({ verified: false });
        expect(await connectionOf(merchant)).toMatchObject({
          health: 'ok',
          store_verified_at: null,
        });

        const payload = placeOrder(merchant);
        const ack = await deliverOrder(merchant, payload);
        expect(ack).toEqual({ status: 200, body: { received: true } });
        expect(await drain()).toEqual([{ kind: 'done' }]);

        // The first order proves the store: one read, with the store's key.
        expect((await connectionOf(merchant)).store_verified_at).not.toBeNull();
        expect(storeRequests(merchant.apiKey)).toEqual([
          {
            method: 'GET',
            key: merchant.apiKey,
            orderId: payload.id,
            answered: 200,
          },
        ]);
        expect(await reconcile(merchant)).toEqual({
          events: 1,
          completedEvents: 1,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
          appliedSyncs: 0,
          remoteWrites: 0,
        });
        const [sent] = sends.slice(-1);
        expect(sent.to).toBe(`+20${payload.phone.slice(1)}`);
        expect(await verificationStatus(sent.verificationId)).toBe('sent');
        expect(provider.statusOf(payload.id)).toBe('pending');

        await reply(sent.verificationId, sent.to, action);

        expect(await verificationStatus(sent.verificationId)).toBe(target);
        expect(provider.statusOf(payload.id)).toBe(target);
        expect(await syncsOf(merchant, sent.verificationId)).toMatchObject([
          { action: outcome, state: 'succeeded', provider_status: target },
        ]);
        expect(provider.writes(merchant.apiKey)).toEqual([
          {
            method: 'PATCH',
            key: merchant.apiKey,
            orderId: payload.id,
            status: target,
            answered: 200,
          },
        ]);

        // EasyOrders tells Akeed about Akeed's own write: nothing follows.
        await deliverStatus(merchant, {
          order_id: payload.id,
          old_status: 'pending',
          new_status: target,
        });
        await drain();

        expect(await eventsOf(merchant)).toMatchObject([
          { status: 'completed' },
          { status: 'skipped', last_error: 'reflected_outcome' },
        ]);
        expect(await reconcile(merchant)).toEqual({
          events: 2,
          completedEvents: 1,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
          appliedSyncs: 1,
          remoteWrites: 1,
        });
        expect(retryQueue.waiting).toHaveLength(0);
      },
    );
  });

  describe('AC3 duplicate and replayed deliveries', () => {
    it('repeated, concurrent and late order webhooks make one order, one send and one usage unit', async () => {
      const merchant = await connectMerchant();
      const payload = placeOrder(merchant);

      const acks = await Promise.all([
        deliverOrder(merchant, payload),
        deliverOrder(merchant, payload),
        deliverOrder(merchant, payload),
      ]);
      await drain();
      const late = await deliverOrder(merchant, {
        ...payload,
        total_cost: 9_999,
      });
      await drain();

      expect(acks.map((ack) => ack.status)).toEqual([200, 200, 200]);
      expect(late.body).toEqual({ received: true, duplicate: true });
      expect(await reconcile(merchant)).toMatchObject({
        events: 1,
        orders: 1,
        verifications: 1,
        sends: 1,
        usage: 1,
      });
      const [order] = await client<{ total_price: string }[]>`
        SELECT total_price FROM orders WHERE integration_id = ${merchant.integrationId}`;
      expect(order.total_price).toBe('750.00');
    });

    it('a replayed customer reply and a replayed status webhook write to the store once', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);

      await reply(order.verificationId, order.phone, 'confirm');
      await reply(order.verificationId, order.phone, 'confirm');
      await reply(order.verificationId, order.phone, 'cancel');
      const echo = {
        order_id: order.payload.id,
        old_status: 'pending',
        new_status: 'confirmed',
      };
      const statusAcks = [
        await deliverStatus(merchant, echo),
        await deliverStatus(merchant, echo),
      ];
      await drain();

      expect(statusAcks[1].body).toEqual({ received: true, duplicate: true });
      expect(await verificationStatus(order.verificationId)).toBe('confirmed');
      expect(provider.statusOf(order.payload.id)).toBe('confirmed');
      expect(await reconcile(merchant)).toMatchObject({
        events: 2,
        orders: 1,
        verifications: 1,
        sends: 1,
        usage: 1,
        appliedSyncs: 1,
        remoteWrites: 1,
      });
      expect(await syncsOf(merchant, order.verificationId)).toHaveLength(1);
    });

    it('a replayed install callback is refused and leaves the stored credentials as they were', async () => {
      const owner = await newOrganization();
      const storeId = randomUUID();
      const { callbackToken } = await startInstall(owner);
      const apiKey = provider.issueKey(storeId);
      const attackerKey = provider.issueKey(randomUUID());
      secrets.add(apiKey).add(attackerKey);
      await auth.handleCallback(callbackToken, {
        api_key: apiKey,
        store_id: storeId,
      });
      const [integration] = await client<{ id: string }[]>`
        SELECT id FROM integrations WHERE org_id = ${owner.orgId}`;
      const before = await connectionOf({ integrationId: integration.id });

      const replay = await answer(
        auth.handleCallback(callbackToken, {
          api_key: attackerKey,
          store_id: storeId,
        }),
      );

      expect(replay).toMatchObject({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });
      expect(await connectionOf({ integrationId: integration.id })).toEqual(
        before,
      );
      expect(provider.requestsWith(attackerKey)).toHaveLength(0);
    });
  });

  describe('AC3 wrong-store credentials', () => {
    it('one tenant’s token, secret or key never reaches another tenant’s store', async () => {
      const merchant = await connectMerchant();
      const foreign = placeOrder(bystander);
      const eventsBefore = (await reconcile(merchant)).events;

      // Tenant A's address and secret, carrying tenant B's order.
      expect((await deliverOrder(merchant, foreign)).status).toBe(403);
      // Tenant B's secret on tenant A's address, and the reverse.
      expect(
        (
          await deliverOrder(merchant, placeOrder(merchant), {
            secret: bystander.ordersSecret,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await deliverOrder(bystander, foreign, {
            secret: merchant.ordersSecret,
          })
        ).status,
      ).toBe(401);
      // A status event for tenant B's order on tenant A's address.
      await deliverStatus(merchant, {
        order_id: bystanderOrder.payload.id,
        old_status: 'pending',
        new_status: 'canceled',
      });
      expect(await drain()).toEqual([{ kind: 'done' }]);

      expect(queued).toHaveLength(0);
      expect(await reconcile(merchant)).toMatchObject({
        events: eventsBefore + 1,
        orders: 0,
        verifications: 0,
        sends: 0,
        usage: 0,
      });
      expect(await verificationStatus(bystanderOrder.verificationId)).toBe(
        'sent',
      );
    });

    it('an outcome that names another tenant’s order is refused before any key is used', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);

      const crossed = await registry.dispatch({
        orgId: merchant.orgId,
        integrationId: merchant.integrationId,
        externalOrderId: bystanderOrder.payload.id,
        action: 'customer_cancellation',
        correlationId: order.verificationId,
        retryInBackground: true,
      });
      const borrowed = await registry.dispatch({
        orgId: merchant.orgId,
        integrationId: bystander.integrationId,
        externalOrderId: bystanderOrder.payload.id,
        action: 'customer_cancellation',
        correlationId: order.verificationId,
        retryInBackground: true,
      });

      expect(crossed.status).toBe('permanent_failure');
      expect(borrowed.status).toBe('permanent_failure');
      expect(storeRequests()).toHaveLength(0);
      expect(retryQueue.waiting).toHaveLength(0);
    });

    it('a store whose key answers for a different store is not written to', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      // The connection claims a store its key does not belong to.
      await client`
        UPDATE easyorders_connections SET store_id = ${randomUUID()}
        WHERE integration_id = ${merchant.integrationId}`;

      await reply(order.verificationId, order.phone, 'confirm');

      expect(await verificationStatus(order.verificationId)).toBe('confirmed');
      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'failed', error_code: 'store_mismatch' },
      ]);
      expect(provider.writes()).toHaveLength(0);
      expect(provider.statusOf(order.payload.id)).toBe('pending');
    });
  });

  describe('AC3 key revocation', () => {
    it('a revoked key stops the store update at once, keeps the customer’s answer and retries nothing', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      provider.revokeKey(merchant.apiKey);

      await reply(order.verificationId, order.phone, 'confirm');

      expect(await verificationStatus(order.verificationId)).toBe('confirmed');
      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        {
          state: 'failed',
          error_code: 'source_credentials_rejected',
          requires_assistance: true,
        },
      ]);
      expect((await connectionOf(merchant)).health).toBe(
        'credentials_rejected',
      );
      expect(storeRequests(merchant.apiKey)).toEqual([
        expect.objectContaining({ method: 'GET', answered: 401 }),
      ]);
      expect(retryQueue.waiting).toHaveLength(0);
      expect(await runRetries()).toBe(0);
      expect(provider.statusOf(order.payload.id)).toBe('pending');
    });

    it('a revoked key on an order lookup is permanent: the event is closed and the connection flagged', async () => {
      const merchant = await connectMerchant();
      const payload = placeOrder(merchant);
      provider.revokeKey(merchant.apiKey);

      await deliverOrder(merchant, { ...payload, full_name: undefined });
      const ends = await drain();

      expect(ends).toEqual([{ kind: 'done' }]);
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'skipped', last_error: 'source_credentials_rejected' },
      ]);
      expect((await connectionOf(merchant)).health).toBe(
        'credentials_rejected',
      );
      expect(storeRequests(merchant.apiKey)).toHaveLength(1);
      expect(await reconcile(merchant)).toMatchObject({
        orders: 0,
        sends: 0,
        usage: 0,
      });
    });

    it('a new key from a disconnect and same-store reconnect resumes store updates', async () => {
      const merchant = await connectMerchant();
      provider.revokeKey(merchant.apiKey);
      await auth.disconnect(merchant.owner);

      const next = await install(merchant.owner, merchant.storeId);
      const ordersSecret = secret();
      const statusSecret = secret();
      await auth.saveWebhookSecrets(merchant.owner, {
        ordersSecret,
        statusSecret,
      });
      const reconnected: Merchant = {
        ...merchant,
        ...next,
        ordersSecret,
        statusSecret,
      };
      const order = await sentOrder(reconnected);
      await reply(order.verificationId, order.phone, 'confirm');

      expect(provider.statusOf(order.payload.id)).toBe('confirmed');
      expect(storeRequests(merchant.apiKey)).toHaveLength(0);
      expect((await connectionOf(merchant)).health).toBe('ok');
    });
  });

  describe('AC3 rate limits', () => {
    it('a 429 with Retry-After waits without spending an attempt, then writes exactly once', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      provider.failNext(
        'write',
        { kind: 'rate_limited', retryAfterSeconds: 1 },
        merchant.apiKey,
      );

      await reply(order.verificationId, order.phone, 'confirm');

      expect(await verificationStatus(order.verificationId)).toBe('confirmed');
      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        {
          state: 'pending',
          error_code: 'source_rate_limited',
          attempts: 0,
          deferrals: 1,
        },
      ]);
      expect(retryQueue.delays).toEqual([1_000]);
      expect(provider.statusOf(order.payload.id)).toBe('pending');

      await new Promise((done) => setTimeout(done, 1_100));
      expect(await runRetries()).toBe(1);

      expect(provider.statusOf(order.payload.id)).toBe('confirmed');
      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'succeeded', attempts: 1, deferrals: 1 },
      ]);
      expect(
        provider.writes(merchant.apiKey).map((request) => request.answered),
      ).toEqual([429, 200]);
    });

    it('a 429 without Retry-After pauses that store until the next minute and no other store', async () => {
      const merchant = await connectMerchant();
      const first = await sentOrder(merchant);
      const second = await sentOrder(merchant);
      const other = await connectMerchant();
      const otherOrder = await sentOrder(other);
      provider.failNext('read', { kind: 'rate_limited' }, merchant.apiKey);

      await reply(first.verificationId, first.phone, 'confirm');
      const requestsWhenLimited = storeRequests(merchant.apiKey).length;
      await reply(second.verificationId, second.phone, 'confirm');
      await reply(otherOrder.verificationId, otherOrder.phone, 'confirm');

      // Section 8: wait for the next clock minute, plus up to 10 s of jitter.
      expect(retryQueue.delays[0]).toBeGreaterThan(0);
      expect(retryQueue.delays[0]).toBeLessThanOrEqual(70_000);
      // The paused store makes no further request, for any of its orders.
      expect(storeRequests(merchant.apiKey)).toHaveLength(requestsWhenLimited);
      expect(await syncsOf(merchant, second.verificationId)).toMatchObject([
        { state: 'pending', error_code: 'source_rate_budget_exhausted' },
      ]);
      // Both answers are kept; neither order is written twice or lost.
      expect(await verificationStatus(first.verificationId)).toBe('confirmed');
      expect(await verificationStatus(second.verificationId)).toBe('confirmed');
      // The other store is not delayed.
      expect(provider.statusOf(otherOrder.payload.id)).toBe('confirmed');
      expect(await reconcile(other)).toMatchObject({
        appliedSyncs: 1,
        remoteWrites: 1,
      });
    });
  });

  describe('AC3 queue and provider outages', () => {
    it('a queue outage at webhook dispatch: acknowledged after the durable write, recovered by the sweep, one order', async () => {
      const merchant = await connectMerchant();
      const payload = placeOrder(merchant);
      queue.down = true;

      const ack = await deliverOrder(merchant, payload);
      const repeat = await deliverOrder(merchant, payload);

      expect(ack).toEqual({ status: 200, body: { received: true } });
      expect(repeat.body).toEqual({ received: true, duplicate: true });
      expect(queued).toHaveLength(0);
      expect(await reconcile(merchant)).toMatchObject({ events: 1, orders: 0 });

      queue.down = false;
      await client`
        UPDATE webhook_events
        SET next_dispatch_at = now() - interval '1 second', dispatch_lease_until = NULL
        WHERE integration_id = ${merchant.integrationId}`;
      const swept = await reconciler.reconcileOnce();
      await drain();

      expect(swept.dispatched).toBe(1);
      expect(await reconcile(merchant)).toMatchObject({
        events: 1,
        completedEvents: 1,
        orders: 1,
        verifications: 1,
        sends: 1,
        usage: 1,
      });
    });

    it('a queue outage at outcome retry: a visible failure the merchant retries, written once', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      provider.failNext('read', { kind: 'unavailable' }, merchant.apiKey);
      retryQueue.down = true;

      await reply(order.verificationId, order.phone, 'cancel');

      expect(await verificationStatus(order.verificationId)).toBe('canceled');
      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'failed', error_code: 'retry_not_scheduled' },
      ]);

      retryQueue.down = false;
      const retried = await verifications.retryOutcomeSync(
        merchant.owner,
        order.verificationId,
      );
      responses.push(retried);

      expect(retried.remote_sync).toMatchObject({ state: 'succeeded' });
      expect(provider.statusOf(order.payload.id)).toBe('canceled');
      expect(await reconcile(merchant)).toMatchObject({
        appliedSyncs: 1,
        remoteWrites: 1,
      });
    });

    it('a provider outage ends in a bounded, visible failure, and every try after a merchant retry is queued', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      for (let tries = 0; tries < OUTCOME_SYNC_MAX_ATTEMPTS; tries++)
        provider.failNext('read', { kind: 'unavailable' }, merchant.apiKey);

      await reply(order.verificationId, order.phone, 'confirm');
      expect(await runRetries()).toBe(OUTCOME_SYNC_MAX_ATTEMPTS - 1);

      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        {
          state: 'failed',
          error_code: 'source_unavailable',
          attempts: OUTCOME_SYNC_MAX_ATTEMPTS,
          requires_assistance: false,
        },
      ]);
      expect(retryQueue.waiting).toHaveLength(0);
      expect(await verificationStatus(order.verificationId)).toBe('confirmed');

      // The outage outlasts the merchant's retry: the rewound counters name
      // tries that already ran, and each one must still reach the queue.
      for (let tries = 0; tries < 2; tries++)
        provider.failNext('read', { kind: 'unavailable' }, merchant.apiKey);
      await verifications.retryOutcomeSync(
        merchant.owner,
        order.verificationId,
      );
      expect(retryQueue.waiting).toHaveLength(1);
      expect(await runRetries(1)).toBe(1);
      expect(retryQueue.waiting).toHaveLength(1);
      expect(await runRetries()).toBe(1);

      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'succeeded' },
      ]);
      expect(provider.statusOf(order.payload.id)).toBe('confirmed');
      expect(await reconcile(merchant)).toMatchObject({
        sends: 1,
        usage: 1,
        appliedSyncs: 1,
        remoteWrites: 1,
      });
    });
  });

  describe('fault injection', () => {
    it('install callback, provider unreachable: nothing is stored and the same link works on retry', async () => {
      const owner = await newOrganization();
      const storeId = randomUUID();
      const { callbackToken } = await startInstall(owner);
      const apiKey = provider.issueKey(storeId);
      secrets.add(apiKey);
      provider.failNext('read', { kind: 'timeout_before_apply' }, apiKey);

      const first = await answer(
        auth.handleCallback(callbackToken, {
          api_key: apiKey,
          store_id: storeId,
        }),
      );

      expect(first).toMatchObject({
        status: 503,
        code: 'EASYORDERS_PROVIDER_UNAVAILABLE',
      });
      expect(
        await client`
        SELECT id FROM integrations WHERE org_id = ${owner.orgId}`,
      ).toHaveLength(0);

      await auth.handleCallback(callbackToken, {
        api_key: apiKey,
        store_id: storeId,
      });
      expect(
        await client`
        SELECT id FROM integrations WHERE org_id = ${owner.orgId}`,
      ).toHaveLength(1);
    });

    it('install callback, database write fails half-way: all of it is rolled back and the same link then connects', async () => {
      const owner = await newOrganization();
      const storeId = randomUUID();
      const { callbackToken } = await startInstall(owner);
      const apiKey = provider.issueKey(storeId);
      secrets.add(apiKey);

      await client`UPDATE fault_switch SET fail = true`;
      try {
        await expect(
          auth.handleCallback(callbackToken, {
            api_key: apiKey,
            store_id: storeId,
          }),
        ).rejects.toThrow();
      } finally {
        await client`UPDATE fault_switch SET fail = false`;
      }
      expect(
        await client`
        SELECT id FROM integrations WHERE org_id = ${owner.orgId}`,
      ).toHaveLength(0);

      await auth.handleCallback(callbackToken, {
        api_key: apiKey,
        store_id: storeId,
      });
      expect(
        await client`
        SELECT integration_id FROM easyorders_connections WHERE org_id = ${owner.orgId}`,
      ).toHaveLength(1);
    });

    it('remote status timeout before the write was taken: read back, then written once', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      provider.failNext(
        'write',
        { kind: 'timeout_before_apply' },
        merchant.apiKey,
      );

      await reply(order.verificationId, order.phone, 'confirm');

      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'pending', error_code: 'write_unconfirmed', attempts: 1 },
      ]);
      expect(provider.statusOf(order.payload.id)).toBe('pending');
      expect(await runRetries()).toBe(1);

      expect(provider.statusOf(order.payload.id)).toBe('confirmed');
      expect(
        storeRequests(merchant.apiKey).map(
          (request) => `${request.method} ${request.answered}`,
        ),
      ).toEqual([
        'GET 200',
        'PATCH timeout',
        'GET 200',
        'GET 200',
        'PATCH 200',
      ]);
      expect(await reconcile(merchant)).toMatchObject({
        appliedSyncs: 1,
        remoteWrites: 1,
      });
    });

    it('remote status timeout after the write was taken: read back, and never written again', async () => {
      const merchant = await connectMerchant();
      const order = await sentOrder(merchant);
      provider.failNext(
        'write',
        { kind: 'timeout_after_apply' },
        merchant.apiKey,
      );

      await reply(order.verificationId, order.phone, 'cancel');

      expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
        { state: 'succeeded', provider_status: 'canceled' },
      ]);
      expect(
        storeRequests(merchant.apiKey).map(
          (request) => `${request.method} ${request.answered}`,
        ),
      ).toEqual(['GET 200', 'PATCH timeout', 'GET 200']);
      expect(retryQueue.waiting).toHaveLength(0);
      expect(provider.statusOf(order.payload.id)).toBe('canceled');
    });

    it('rate limiting on the order lookup: the event is released, not failed, and the order arrives once', async () => {
      const merchant = await connectMerchant();
      const payload = placeOrder(merchant);
      provider.failNext(
        'read',
        { kind: 'rate_limited', retryAfterSeconds: 1 },
        merchant.apiKey,
      );

      await deliverOrder(merchant, { ...payload, full_name: undefined });
      const [end] = await drain();

      expect(end).toMatchObject({ kind: 'delayed' });
      expect(await eventsOf(merchant)).toMatchObject([
        { status: 'pending', last_error: 'source_rate_limited' },
      ]);
      await new Promise((done) => setTimeout(done, 1_100));
      const delayed = end as Extract<JobEnd, { kind: 'delayed' }>;
      expect(await runJob(delayed.payload)).toEqual({ kind: 'done' });

      expect(await reconcile(merchant)).toMatchObject({
        events: 1,
        completedEvents: 1,
        orders: 1,
        verifications: 1,
        sends: 1,
        usage: 1,
      });
    });
  });

  describe('AC4 disconnect and reconnect', () => {
    it('keeps every order, verification, event, usage row and store update, on the same source', async () => {
      const merchant = await connectMerchant();
      const answered = await sentOrder(merchant);
      await reply(answered.verificationId, answered.phone, 'confirm');
      const waiting = await sentOrder(merchant);
      const before = await historyOf(merchant);
      const countsBefore = await reconcile(merchant);

      await auth.disconnect(merchant.owner);

      expect(await historyOf(merchant)).toEqual(before);
      expect(await connectionOf(merchant)).toMatchObject({
        api_key_encrypted: null,
        webhook_token_hash: null,
      });
      // The old address is dead, and a late answer stays in Akeed.
      expect((await deliverOrder(merchant, placeOrder(merchant))).status).toBe(
        401,
      );
      const requestsBefore = provider.requests.length;
      await reply(waiting.verificationId, waiting.phone, 'confirm');
      expect(await verificationStatus(waiting.verificationId)).toBe(
        'confirmed',
      );
      expect(provider.requests).toHaveLength(requestsBefore);
      expect(provider.statusOf(waiting.payload.id)).toBe('pending');

      const next = await install(merchant.owner, merchant.storeId);
      const ordersSecret = secret();
      const statusSecret = secret();
      await auth.saveWebhookSecrets(merchant.owner, {
        ordersSecret,
        statusSecret,
      });
      const reconnected: Merchant = {
        ...merchant,
        ...next,
        ordersSecret,
        statusSecret,
      };

      const [source, ...others] = await client<
        { id: string; is_active: boolean }[]
      >`SELECT id, is_active FROM integrations WHERE org_id = ${merchant.orgId}`;
      expect(others).toHaveLength(0);
      expect(source).toEqual({ id: merchant.integrationId, is_active: true });
      const after = await historyOf(merchant);
      expect(after.orders).toEqual(before.orders);
      expect(after.events).toEqual(before.events);
      expect(after.usage).toEqual(before.usage);
      expect(after.dispatches).toEqual(before.dispatches);
      expect(JSON.parse(after.syncs)).toEqual(
        expect.arrayContaining(JSON.parse(before.syncs) as unknown[]),
      );
      expect((await deliverOrder(merchant, placeOrder(merchant))).status).toBe(
        401,
      );

      const fresh = await sentOrder(reconnected);
      await reply(fresh.verificationId, fresh.phone, 'confirm');

      expect(provider.statusOf(fresh.payload.id)).toBe('confirmed');
      const countsAfter = await reconcile(reconnected);
      expect(countsAfter).toMatchObject({
        orders: countsBefore.orders + 1,
        verifications: countsBefore.verifications + 1,
        sends: countsBefore.sends + 1,
        usage: countsBefore.usage + 1,
      });
    });
  });

  describe('AC4 no automatic no-reply cancellation', () => {
    it.each([
      ['on', true],
      ['off', false],
    ] as const)(
      'with remote writes %s, an unanswered order is never canceled in EasyOrders by Akeed itself',
      async (_label, syncEnabled) => {
        settings.outcomeSyncEnabled = syncEnabled;
        const merchant = await connectMerchant();
        const order = await sentOrder(merchant);

        await runAutomation(order.verificationId, 'follow_up');
        await runAutomation(order.verificationId, 'no_reply');

        expect(await verificationStatus(order.verificationId)).toBe('no_reply');
        expect(storeRequests(merchant.apiKey)).toHaveLength(0);
        expect(provider.statusOf(order.payload.id)).toBe('pending');
        expect(await syncsOf(merchant, order.verificationId)).toMatchObject([
          { action: 'automatic_no_reply_tagging', state: 'unsupported' },
        ]);
        expect(retryQueue.waiting).toHaveLength(0);
        expect(await runRetries()).toBe(0);

        // Only the merchant's own action may cancel, and only with writes on.
        const cancel = await answer(
          verifications.cancelNoReplyOrder(
            merchant.owner,
            order.verificationId,
          ),
        );
        if (syncEnabled) {
          expect(cancel.status).toBe(200);
          expect(provider.statusOf(order.payload.id)).toBe('canceled');
          expect(provider.writes(merchant.apiKey)).toHaveLength(1);
        } else {
          expect(cancel.status).toBe(400);
          expect(storeRequests(merchant.apiKey)).toHaveLength(0);
          expect(provider.statusOf(order.payload.id)).toBe('pending');
        }
      },
    );

    it('the EasyOrders adapter never offers an automatic or tagging action', () => {
      const adapter = new EasyOrdersOutcomeAdapter(
        connections,
        api,
        limiter,
        easyOrdersConfig,
      );

      expect([...adapter.capabilities].sort()).toEqual([
        'customer_cancellation',
        'customer_confirmation',
        'merchant_no_reply_cancellation',
      ]);
    });
  });

  describe('pausing EasyOrders without touching Shopify', () => {
    it('with the connect switch off: no new connection, existing stores keep working, Shopify is processed', async () => {
      const merchant = await connectMerchant();
      const owner = await newOrganization();
      const open = await startInstall(owner);
      settings.enabled = false;

      const start = await answer(auth.startInstall(owner, { locale: 'ar' }));
      const apiKey = provider.issueKey(randomUUID());
      secrets.add(apiKey);
      const callback = await answer(
        auth.handleCallback(open.callbackToken, {
          api_key: apiKey,
          store_id: randomUUID(),
        }),
      );

      expect(start).toMatchObject({
        status: 404,
        code: 'EASYORDERS_CONNECT_UNAVAILABLE',
      });
      expect(callback).toMatchObject({
        status: 404,
        code: 'EASYORDERS_CONNECT_UNAVAILABLE',
      });
      expect(
        await client`
        SELECT id FROM integrations WHERE org_id = ${owner.orgId}`,
      ).toHaveLength(0);
      expect(provider.requestsWith(apiKey)).toHaveLength(0);

      const order = await sentOrder(merchant);
      await reply(order.verificationId, order.phone, 'confirm');
      expect(provider.statusOf(order.payload.id)).toBe('confirmed');

      expect(await shopifyJourney(shopify)).toMatchObject({
        ingested: { enqueued: true },
        ends: [{ kind: 'done' }],
        sends: 1,
        status: 'confirmed',
        outcomes: [
          {
            integrationId: shopify.integrationId,
            action: 'customer_confirmation',
          },
        ],
      });
    });

    it('Shopify is processed the same with every EasyOrders switch on and with every switch off', async () => {
      const merchant = await connectMerchant();
      const allOn = await shopifyJourney(shopify);
      const requestsBefore = provider.requests.length;

      settings.enabled = false;
      settings.ingestionEnabled = false;
      settings.outcomeSyncEnabled = false;
      const allOff = await shopifyJourney(shopify);
      const refused = await deliverOrder(merchant, placeOrder(merchant));

      expect(allOff).toEqual(allOn);
      expect(allOn).toMatchObject({
        sends: 1,
        status: 'confirmed',
        outcomes: [{ action: 'customer_confirmation' }],
      });
      // EasyOrders itself is dark: the address answers 404 and stores nothing.
      expect(refused.status).toBe(404);
      expect(await reconcile(merchant)).toMatchObject({ events: 0, orders: 0 });
      expect(provider.requests).toHaveLength(requestsBefore);
      expect(await reconcile(shopify)).toMatchObject({
        orders: 3,
        verifications: 3,
        sends: 3,
        usage: 3,
      });
    });
  });

  describe('secrets', () => {
    it('no key, token or webhook secret is logged, returned or stored in clear', async () => {
      const stored = await client<{ row: string }[]>`
        SELECT to_jsonb(t)::text AS row FROM webhook_events t
        UNION ALL SELECT to_jsonb(t)::text FROM commerce_outcome_syncs t
        UNION ALL SELECT to_jsonb(t)::text FROM easyorders_connections t
        UNION ALL SELECT to_jsonb(t)::text FROM easyorders_pending_installs t
        UNION ALL SELECT to_jsonb(t)::text FROM integrations t
        UNION ALL SELECT to_jsonb(t)::text FROM orders t
        UNION ALL SELECT to_jsonb(t)::text FROM verifications t`;
      const haystack = [
        ...logs,
        JSON.stringify(responses),
        ...stored.map((item) => item.row),
      ].join('\n');

      expect(secrets.size).toBeGreaterThan(40);
      expect(logs.length).toBeGreaterThan(100);
      expect(stored.length).toBeGreaterThan(50);
      for (const value of secrets) {
        expect(haystack).not.toContain(value);
        // A token is stored only as its hash; the hash is never logged or
        // returned either.
        expect(
          `${logs.join('\n')}\n${JSON.stringify(responses)}`,
        ).not.toContain(hashInstallToken(value));
      }
    });

    it('the fixtures hold no key, token or secret, and say they were not captured', () => {
      for (const name of ['order-created.json', 'order-status-update.json']) {
        const text = readFileSync(
          resolve(__dirname, 'fixtures/easyorders', name),
          'utf8',
        );
        const fixture = JSON.parse(text) as { _fixture: { source: string } };

        expect(fixture._fixture.source).toBe('documented, not captured');
        expect(text).not.toMatch(/api[_-]?key|secret|token/i);
        for (const value of secrets) expect(text).not.toContain(value);
      }
    });
  });
});
