import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../../src/infrastructure/database/schema';
import * as schema from '../../src/infrastructure/database';
import { CommerceOutcomeSyncsRepository } from '../../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { CreditAccountingRepository } from '../../src/infrastructure/database/repositories/credit-accounting.repository';
import { IntegrationMonthlyUsageRepository } from '../../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { IntegrationsRepository } from '../../src/infrastructure/database/repositories/integrations.repository';
import {
  buildStandaloneSourceIdentity,
  STANDALONE_SOURCE_DEFAULTS,
} from '../../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { OrdersRepository } from '../../src/infrastructure/database/repositories/orders.repository';
import { PeriodicPlanAccounting } from '../../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../../src/infrastructure/database/repositories/usage-accounting.router';
import { VerificationMessageDispatchesRepository } from '../../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationsRepository } from '../../src/infrastructure/database/repositories/verifications.repository';
import { WebhookEventsRepository } from '../../src/infrastructure/database/repositories/webhook-events.repository';
import { WhatsAppWebhookService } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { ShopifyOrderEligibilityStrategy } from '../../src/infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from '../../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneOutcomeAdapter } from '../../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import type { AuthenticatedUser } from '../../src/modules/auth/guards/dual-auth.guard';
import { CommerceOutcomeRegistryService } from '../../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import type { CommerceOutcomeSyncJobPayload } from '../../src/modules/commerce-outcomes/commerce-outcome-sync.constants';
import { OUTCOME_SYNC_MAX_ATTEMPTS } from '../../src/modules/commerce-outcomes/commerce-outcome-sync.policy';
import { CommerceOutcomeSyncProcessor } from '../../src/modules/commerce-outcomes/commerce-outcome-sync.processor';
import { CommerceOutcomeSyncProducer } from '../../src/modules/commerce-outcomes/commerce-outcome-sync.producer';
import { VerificationAutomationJobType } from '../../src/modules/verification-automation/verification-automation.constants';
import { VerificationAutomationProcessor } from '../../src/modules/verification-automation/verification-automation.processor';
import { BillingEntitlementService } from '../../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../../src/modules/verification-core/order-eligibility.service';
import type { OrderEligibilityStrategy } from '../../src/modules/verification-core/strategies/order-eligibility.strategy';
import { VerificationHubService } from '../../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../../src/modules/verification-core/verification-send.service';
import { VerificationsService } from '../../src/modules/verifications/verifications.service';
import type { WebhookJobPayload } from '../../src/modules/webhook-queue/interfaces/webhook-job.interface';
import type { WebhookOrderNormalizer } from '../../src/modules/webhook-queue/interfaces/webhook-normalizer.interface';
import type { WebhookOrderUpdateHandler } from '../../src/modules/webhook-queue/interfaces/webhook-order-update-handler.interface';
import { shopifyOrderFixture } from '../../src/infrastructure/spokes/shopify/services/fixtures/shopify-order.fixture';
import { ShopifyOrderNormalizer } from '../../src/infrastructure/spokes/shopify/services/shopify-order.normalizer';
import { StandaloneManualOrderNormalizer } from '../../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookDispatchReconciler } from '../../src/modules/webhook-queue/webhook-dispatch-reconciler.service';
import { WebhookDispatchService } from '../../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookJobType } from '../../src/modules/webhook-queue/webhook-queue.constants';
import { WebhookQueueProcessor } from '../../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../../src/modules/webhook-queue/webhook-queue.producer';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapter,
} from '../../src/shared/commerce/commerce-outcome';
import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../src/shared/billing/billing-plan';
import { COMMERCE_OUTCOME_ACTIONS } from '../../src/shared/commerce/commerce-outcome';
import { buildStandaloneOrderEnvelope } from '../../src/shared/commerce/standalone-order-envelope';
import type { MessagingPort } from '../../src/shared/ports/messaging.port';
import { PhoneService } from '../../src/shared/services/phone.service';
import { standaloneCreditBillingConfigService } from './standalone-credit-billing-config';

/**
 * The source conformance harness: what every connectable store source has to
 * hold, whatever its provider is.
 *
 * It was extracted from the US-06-06 EasyOrders release gate so that a second
 * source runs the same matrix (US-07-06). It has three parts:
 *
 * - a world: one PostgreSQL schema, the real repositories and services, and
 *   fakes only at the edges (the messaging port and the BullMQ queues, whose
 *   jobs are recorded and run in process);
 * - a driver, written per source, for everything a provider decides: how a
 *   store connects, what a delivery looks like, what the store shows after an
 *   outcome, and the controls of its provider fake;
 * - the matrix, which runs each case through the driver and asserts Akeed's
 *   side of it: events, orders, verifications, sends, usage and store updates,
 *   with a second tenant and other sources standing beside every case.
 *
 * No request leaves the process and no shared database is used.
 */

// --- What a driver hands to the matrix ---

export interface ConformanceMerchant {
  orgId: string;
  integrationId: string;
  owner: AuthenticatedUser;
}

export interface ConformanceOrder {
  /** The order's id at the provider, as Akeed stores it. */
  externalOrderId: string;
  /** The customer's number as Akeed must send to it. */
  expectedPhone: string;
  /** The total Akeed must keep, whatever a later delivery says. */
  expectedTotal: string;
}

export interface SentOrder<O extends ConformanceOrder> {
  order: O;
  verificationId: string;
  phone: string;
}

export interface ConformanceAnswer {
  status: number;
  code?: string;
  body?: unknown;
}

/** What the store shows of an order, in terms every source shares. */
export type RemoteOutcomeState = 'untouched' | 'confirmed' | 'cancelled';

/** A fault the provider fake applies to the next matching request. */
export type ProviderFault =
  /** 429, not applied. */
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** 503, not applied. */
  | { kind: 'unavailable' }
  /** No answer; a write was not taken. */
  | { kind: 'timeout_before_apply' }
  /** No answer; a write was taken. */
  | { kind: 'timeout_after_apply' };

export interface RecordedProviderRequest {
  method: string;
  answered: number | string;
}

/** A way an install callback can fail before anything is stored. */
export interface InstallFault<I> {
  /** As it reads in the case's title. */
  name: string;
  inject(install: I): void;
  refusal: { status: number; code: string };
  /** What the provider must not be left holding, when it can be told. */
  expectNothingLeft?(install: I): void | Promise<void>;
}

export interface SourceConformanceDriver<
  M extends ConformanceMerchant,
  O extends ConformanceOrder,
  I,
> {
  /** The provider's name, as it reads in a case's title. */
  label: string;
  codes: {
    installContextInvalid: string;
    connectUnavailable: string;
    /** The store update's error when the store answers for another store. */
    storeMismatch: string;
  };
  /** What the first accepted delivery of an order is answered with. */
  accepted: ConformanceAnswer;
  /** Event rows one order leaves once it has been delivered again. */
  repeatedDeliveryEvents: number;
  /** How much the suite must have produced for the secrets scan to count. */
  minimums: { secrets: number; logs: number; storedRows: number };
  /** The spoke's own tables, scanned with the shared ones for secrets. */
  secretTables: string[];
  /** The table whose insert the half-way install fault breaks. */
  connectionTable: string;
  fixtures: { directory: string; files: string[]; forbidden: RegExp };
  installFaults: InstallFault<I>[];
  /** The store calls of a status write whose answer was lost. */
  traces: { timeoutBeforeApply: string[]; timeoutAfterApply: string[] };
  titles: { throttledWithoutHint: string };
  hashToken(value: string): string;
  switches: {
    connect(on: boolean): void;
    ingestion(on: boolean): void;
    outcomeSync(on: boolean): void;
  };
  newAdapter(): CommerceOutcomeAdapter;
  /** The provider status a succeeded store update records. */
  providerStatusAfter(action: CommerceOutcomeAction): string;

  // --- Connecting ---

  /**
   * A connected store with setup finished. `unproven` leaves out whatever
   * the provider proves only later, for the journey case.
   */
  connect(options?: { unproven?: boolean }): Promise<M>;
  /** The start call alone, as a signed-in owner makes it. */
  startInstall(owner: AuthenticatedUser): Promise<unknown>;
  /** Start, and the merchant approving at the provider: keys are issued. */
  beginInstall(owner: AuthenticatedUser): Promise<I>;
  /** The provider's callback; with `replay`, carrying somebody else's keys. */
  finishInstall(install: I, replay?: I): Promise<void>;
  /** The same link, with keys that belong to another store. */
  foreignInstall(install: I): I;
  /** Requests the provider received with an install's keys. */
  requestsWithInstallKeys(install: I): unknown[];
  disconnect(merchant: M): Promise<void>;
  /** The same store, connected again by the same organization. */
  reconnect(merchant: M): Promise<M>;
  connectionRow(orgId: string): Promise<Record<string, unknown> | undefined>;
  healthOf(merchant: M): Promise<string>;

  // --- Orders ---

  /** A cash-on-delivery order a customer placed in the store. */
  placeOrder(merchant: M): O;
  /** `changed`: the same order again, with a different total. */
  deliverOrder(
    merchant: M,
    order: O,
    options?: { changed?: boolean },
  ): Promise<ConformanceAnswer>;
  /** The provider telling Akeed about Akeed's own write. */
  deliverOutcomeEcho(
    merchant: M,
    order: O,
    action: CommerceOutcomeAction,
  ): Promise<ConformanceAnswer>;

  // --- The provider fake ---

  /** A `RemoteOutcomeState`, or text naming what was found instead. */
  remoteStateOf(merchant: M, order: O): string;
  /** Requests after the install, for one store or for all of them. */
  requestsOf(merchant?: M): RecordedProviderRequest[];
  /** Every request since the case began, installs included. */
  requestCount(): number;
  writesOf(merchant?: M): RecordedProviderRequest[];
  /** Order writes the store took. */
  appliedWrites(merchant: M): number;
  /** `METHOD answer` for each request after the install. */
  trace(merchant: M): string[];
  /** Requests made with a key the merchant no longer uses. */
  retiredKeyRequests(merchant: M): unknown[];
  revokeKey(merchant: M): void;
  failNext(merchant: M, channel: 'read' | 'write', fault: ProviderFault): void;
  /** The store's answer for the order stops naming this store. */
  makeStoreAnswerAsAnother(merchant: M, order: O): Promise<void>;

  // --- What only this provider can assert ---

  expects: {
    justConnected(merchant: M): Promise<void>;
    firstOrderProcessed(merchant: M, order: O): Promise<void>;
    outcomeWritten(
      merchant: M,
      order: O,
      action: CommerceOutcomeAction,
      verificationId: string,
    ): void;
    /** The answer to an order delivered again. */
    repeatedDelivery(answer: ConformanceAnswer): void;
    /** The answer to the echo delivered again. */
    repeatedEcho(answer: ConformanceAnswer): void;
    throttledWithoutHint(context: {
      merchant: M;
      second: SentOrder<O>;
      requestsWhenLimited: number;
    }): Promise<void>;
    disconnected(merchant: M): Promise<void>;
  };
  /**
   * One tenant's address, secret or key used against another tenant. Each
   * answer is asserted here; `recorded` is how many events the attacking
   * tenant was rightly left with.
   */
  attemptCrossTenantDeliveries(
    merchant: M,
    bystander: M,
    bystanderOrder: SentOrder<O>,
  ): Promise<{ recorded: number }>;
}

/** What a spoke adds to the registries the application binds. */
export interface ConformanceSpoke {
  outcomeAdapter: CommerceOutcomeAdapter;
  eligibilityStrategy: OrderEligibilityStrategy;
  normalizer: WebhookOrderNormalizer;
  updateHandlers: WebhookOrderUpdateHandler[];
  /** Before each case: every switch on, the provider's request log empty. */
  reset(): void;
}

/** A source that stands beside the one under test and must not be touched. */
export interface BesideSource {
  label: string;
  /** Called once, before the first case. */
  connect(): Promise<void>;
  /** One order from ingestion to a confirmed outcome at its own adapter. */
  journey(): Promise<Record<string, unknown>>;
  /** What every journey must look like. */
  expected(): Record<string, unknown>;
  /** Journeys run so far. */
  readonly journeys: number;
  counts(): Promise<Reconciliation>;
}

export interface Reconciliation {
  events: number;
  completedEvents: number;
  orders: number;
  verifications: number;
  sends: number;
  usage: number;
  appliedSyncs: number;
  remoteWrites: number;
}

export type JobEnd =
  | { kind: 'done' }
  | { kind: 'delayed'; delayMs: number; payload: WebhookJobPayload }
  | { kind: 'failed'; message: string };

interface RecordedSend {
  to: string;
  verificationId: string;
}

interface AutomationJob {
  kind: 'initial' | 'follow_up' | 'no_reply';
  verificationId: string;
  orgId: string;
  dueAt: Date;
}

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

// --- The world, before any spoke: the database, the queues, the edges ---

export function createConformanceBase(options: {
  /** Names the run's own schema, e.g. `e06_gate`. */
  namespacePrefix: string;
  /** Names the message ids the fake messaging port answers with. */
  messageIdPrefix: string;
}) {
  const namespace = `${options.namespacePrefix}_${randomUUID().replaceAll('-', '')}`;
  const client = postgres(isolatedDatabaseUrl(), {
    max: 12,
    connect_timeout: 5,
    onnotice: () => undefined,
    connection: { search_path: `${namespace},public` },
  });
  const db = drizzle(client, { schema });

  /** Synthetic, generated per run: never a real key. */
  const encryptionKey = randomBytes(32).toString('hex');
  const coreConfig = standaloneCreditBillingConfigService();

  /** Every value that must never be logged, returned or stored in clear. */
  const secrets = new Set<string>();
  const logs: string[] = [];
  const responses: unknown[] = [];

  const sends: RecordedSend[] = [];
  const messaging: MessagingPort = {
    sendVerificationTemplate(params) {
      sends.push({ to: params.to, verificationId: params.verificationId });
      return Promise.resolve({
        messages: [{ id: `${options.messageIdPrefix}-${sends.length}` }],
      });
    },
  };

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
      jobOptions: { jobId: string; delay: number },
    ) => {
      if (retryQueue.down)
        return Promise.reject(new Error('redis unavailable'));
      if (!retryQueue.ids.has(jobOptions.jobId)) {
        retryQueue.ids.add(jobOptions.jobId);
        retryQueue.waiting.push(payload);
        retryQueue.delays.push(jobOptions.delay);
      }
      return Promise.resolve();
    },
  } as unknown as Queue<CommerceOutcomeSyncJobPayload>);

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
  const phones = new PhoneService();

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

  /** Called for each new organization, so a spoke can admit it as a pilot. */
  const organizationHooks: Array<(orgId: string) => void> = [];

  /** A value that must stay secret from here on; handed back unchanged. */
  function track(value: string): string {
    secrets.add(value);
    return value;
  }

  async function answer(promise: Promise<unknown>): Promise<ConformanceAnswer> {
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
    for (const admit of organizationHooks) admit(organization.id);
    return {
      userId: randomUUID(),
      orgId: organization.id,
      role: 'owner',
      source: 'supabase',
    };
  }

  return {
    namespace,
    client,
    db,
    encryptionKey,
    coreConfig,
    secrets,
    logs,
    responses,
    sends,
    messaging,
    automationJobs,
    automation,
    retryQueue,
    retryProducer,
    events,
    integrations,
    ordersRepo,
    verificationsRepo,
    syncs,
    credits,
    router,
    dispatches,
    billing,
    creditEligibility,
    phones,
    queued,
    queue,
    dispatcher,
    reconciler,
    producer,
    organizationHooks,
    track,
    answer,
    newOrganization,
  };
}

export type ConformanceBase = ReturnType<typeof createConformanceBase>;

// --- The world, with its sources: the registries as the application binds them ---

export function assembleConformanceWorld(
  base: ConformanceBase,
  spokes: ConformanceSpoke[],
) {
  const {
    namespace,
    client,
    db,
    logs,
    sends,
    automationJobs,
    retryQueue,
    queued,
    events,
    integrations,
    ordersRepo,
    verificationsRepo,
    syncs,
    dispatches,
    billing,
    creditEligibility,
    phones,
    producer,
  } = base;
  let created = false;

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
      ...spokes.map((spoke) => spoke.outcomeAdapter),
    ],
    new CommerceOutcomeSyncTracker(syncs, base.retryProducer),
  );
  const retryWorker = new CommerceOutcomeSyncProcessor(syncs, registry);
  const send = new VerificationSendService(
    verificationsRepo,
    ordersRepo,
    billing,
    creditEligibility,
    dispatches,
    base.messaging,
  );
  const hub = new VerificationHubService(
    ordersRepo,
    verificationsRepo,
    registry,
    new OrderEligibilityService([
      new ShopifyOrderEligibilityStrategy(),
      new StandaloneOrderEligibilityStrategy(),
      ...spokes.map((spoke) => spoke.eligibilityStrategy),
    ]),
    send,
    billing,
    creditEligibility,
    base.automation as never,
  );
  const processor = new WebhookQueueProcessor(
    [
      new ShopifyOrderNormalizer(phones),
      new StandaloneManualOrderNormalizer(),
      ...spokes.map((spoke) => spoke.normalizer),
    ],
    events,
    integrations,
    hub,
    spokes.flatMap((spoke) => spoke.updateHandlers),
  );
  const automationProcessor = new VerificationAutomationProcessor(
    verificationsRepo,
    ordersRepo,
    send,
    hub,
    registry,
    billing,
  );
  const whatsapp = new WhatsAppWebhookService(
    verificationsRepo,
    hub,
    dispatches,
  );
  const verifications = new VerificationsService(
    verificationsRepo,
    billing,
    integrations,
    ordersRepo,
    registry,
    hub,
    syncs,
  );

  // --- Running what the queues hold ---

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

  // --- Reconciliation: what one tenant holds, counted from the database ---

  async function reconcile(
    source: { orgId: string; integrationId: string },
    remoteWrites = 0,
  ): Promise<Reconciliation> {
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
        (SELECT count(*)::int FROM webhook_events WHERE integration_id = ${source.integrationId}) AS events,
        (SELECT count(*)::int FROM webhook_events WHERE integration_id = ${source.integrationId} AND status = 'completed') AS completed_events,
        (SELECT count(*)::int FROM orders WHERE integration_id = ${source.integrationId}) AS orders,
        (SELECT count(*)::int FROM verifications WHERE org_id = ${source.orgId}) AS verifications,
        (SELECT coalesce(sum(consumed_count), 0)::int FROM integration_monthly_usage WHERE integration_id = ${source.integrationId}) AS usage,
        (SELECT count(*)::int FROM commerce_outcome_syncs WHERE integration_id = ${source.integrationId} AND state = 'succeeded') AS applied_syncs`;
    const owned = await client<{ id: string }[]>`
      SELECT id FROM verifications WHERE org_id = ${source.orgId}`;
    const ids = new Set(owned.map((row) => row.id));
    return {
      events: counts.events,
      completedEvents: counts.completed_events,
      orders: counts.orders,
      verifications: counts.verifications,
      sends: sends.filter((item) => ids.has(item.verificationId)).length,
      usage: counts.usage,
      appliedSyncs: counts.applied_syncs,
      remoteWrites,
    };
  }

  /** Every row a tenant owns, to prove nothing moved, changed or went away. */
  async function historyOf(source: { orgId: string; integrationId: string }) {
    const rows = (query: Promise<Record<string, unknown>[]>) =>
      query.then((result) => JSON.stringify(result));
    return {
      orders: await rows(
        client`SELECT * FROM orders WHERE integration_id = ${source.integrationId} ORDER BY id`,
      ),
      verifications: await rows(
        client`SELECT * FROM verifications WHERE org_id = ${source.orgId} ORDER BY id`,
      ),
      events: await rows(
        client`SELECT * FROM webhook_events WHERE integration_id = ${source.integrationId} ORDER BY id`,
      ),
      usage: await rows(
        client`SELECT * FROM integration_monthly_usage WHERE integration_id = ${source.integrationId} ORDER BY id`,
      ),
      dispatches: await rows(
        client`SELECT * FROM verification_message_dispatches WHERE org_id = ${source.orgId} ORDER BY id`,
      ),
      syncs: await rows(
        client`SELECT * FROM commerce_outcome_syncs WHERE integration_id = ${source.integrationId} ORDER BY id`,
      ),
    };
  }

  function syncsOf(source: { orgId: string }, verificationId: string) {
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
      WHERE org_id = ${source.orgId} AND correlation_id = ${verificationId}
      ORDER BY created_at`;
  }

  async function verificationStatus(verificationId: string): Promise<string> {
    const [row] = await client<{ status: string }[]>`
      SELECT status FROM verifications WHERE id = ${verificationId}`;
    return row.status;
  }

  function eventsOf(source: { integrationId: string }) {
    return client<{ id: string; status: string; last_error: string | null }[]>`
      SELECT id, status, last_error FROM webhook_events
      WHERE integration_id = ${source.integrationId}
      ORDER BY received_at, id`;
  }

  /** The verification an order produced, and the number it was sent to. */
  async function sentVerification(
    integrationId: string,
    externalOrderId: string,
  ): Promise<{ verificationId: string; phone: string }> {
    const [verification] = await client<{ id: string }[]>`
      SELECT v.id FROM verifications v JOIN orders o ON o.id = v.order_id
      WHERE o.integration_id = ${integrationId}
        AND o.external_order_id = ${externalOrderId}`;
    if (!verification) throw new Error('The order produced no verification');
    const sent = sends.find((item) => item.verificationId === verification.id);
    if (!sent) throw new Error('The order was not sent');
    return { verificationId: verification.id, phone: sent.to };
  }

  // --- A Shopify source beside the ones under test ---

  function shopifyBeside(): BesideSource {
    let store: { orgId: string; integrationId: string; domain: string };
    let journeys = 0;
    return {
      label: 'Shopify',
      get journeys() {
        return journeys;
      },
      async connect() {
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
        store = { orgId, integrationId: integration.id, domain };
      },
      /** One Shopify order from webhook to a confirmed outcome at its adapter. */
      async journey() {
        journeys += 1;
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
          status: verification
            ? await verificationStatus(verification.id)
            : null,
          outcomes: shopifyOutcomes.slice(outcomesBefore),
        };
      },
      expected() {
        return {
          ingested: { enqueued: true },
          ends: [{ kind: 'done' }],
          sends: 1,
          status: 'confirmed',
          outcomes: [
            {
              integrationId: store.integrationId,
              action: 'customer_confirmation',
            },
          ],
        };
      },
      counts: () => reconcile(store),
    };
  }

  // --- A Standalone source, with orders entered by hand ---

  function standaloneBeside(): BesideSource {
    let source: { orgId: string; integrationId: string; identity: string };
    let journeys = 0;
    return {
      label: 'Standalone',
      get journeys() {
        return journeys;
      },
      async connect() {
        const orgId = randomUUID();
        const identity = buildStandaloneSourceIdentity(orgId);
        await db
          .insert(tables.organizations)
          .values({ id: orgId, name: 'Gate Standalone store', slug: orgId });
        const now = new Date().toISOString();
        const [integration] = await db
          .insert(tables.integrations)
          .values({
            orgId,
            platformType: 'standalone',
            platformStoreUrl: identity,
            storeName: 'Gate Standalone store',
            isActive: true,
            // As provisioning creates a Standalone source: its defaults, and
            // the plan it is granted with no external billing to settle.
            ...STANDALONE_SOURCE_DEFAULTS,
            onboardingStatus: 'completed',
            billingStatus: STANDALONE_BILLING_STATUS,
            billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
            billingActivatedAt: now,
            billingStatusUpdatedAt: now,
          })
          .returning({ id: tables.integrations.id });
        source = { orgId, integrationId: integration.id, identity };
      },
      /** One manual order from its envelope to a confirmed local outcome. */
      async journey() {
        journeys += 1;
        const id = `GATE-${randomUUID().slice(0, 8)}`;
        const sendsBefore = sends.length;
        const envelope = buildStandaloneOrderEnvelope({
          ingestionType: 'manual',
          order: {
            externalOrderId: id,
            orderNumber: id,
            customerPhone: '+201000000777',
            customerName: 'Test Customer',
            totalPrice: '450.00',
            currency: 'EGP',
            paymentMethod: 'cod',
          },
        });
        const ingested = await producer.ingest({
          platform: 'standalone',
          jobType: WebhookJobType.ORDER_CREATE,
          idempotencyKey: `manual:${id}`,
          storeDomain: source.identity,
          rawPayload: envelope.rawPayload,
        });
        const ends = await drain();
        const [verification] = await client<{ id: string }[]>`
          SELECT v.id FROM verifications v JOIN orders o ON o.id = v.order_id
          WHERE o.integration_id = ${source.integrationId}
            AND o.external_order_id = ${id}`;
        const sent = sends.slice(sendsBefore);
        if (verification && sent[0])
          await reply(verification.id, sent[0].to, 'confirm');
        const [event] = await client<
          { status: string; last_error: string | null }[]
        >`
          SELECT status, last_error FROM webhook_events
          WHERE integration_id = ${source.integrationId}
          ORDER BY received_at DESC, id DESC LIMIT 1`;
        return {
          ingested,
          ends,
          event: { status: event.status, reason: event.last_error },
          sends: sent.length,
          status: verification
            ? await verificationStatus(verification.id)
            : null,
        };
      },
      expected() {
        return {
          ingested: { enqueued: true },
          ends: [{ kind: 'done' }],
          event: { status: 'completed', reason: null },
          sends: 1,
          status: 'confirmed',
        };
      },
      counts: () => reconcile(source),
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
    return readFileSync(resolve(__dirname, '../../drizzle', name), 'utf8')
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

  /**
   * The schema every case runs on. `migrations` are the sources' own, applied
   * in the order given after the shared ones; a name given twice is applied
   * twice. `faultTables` get the trigger the half-way install fault uses.
   */
  async function setup(options: {
    migrations: string[];
    faultTables: string[];
  }): Promise<void> {
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
      ...options.migrations,
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
    `);
    for (const table of options.faultTables)
      await client.unsafe(`
        CREATE TRIGGER ${table}_fault BEFORE INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION fail_connection_insert();
      `);
  }

  async function teardown(): Promise<void> {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  /** Before each case: every queue up and empty, every source switched on. */
  function reset(): void {
    base.queue.down = false;
    retryQueue.down = false;
    retryQueue.waiting.length = 0;
    retryQueue.delays.length = 0;
    queued.length = 0;
    for (const spoke of spokes) spoke.reset();
  }

  return {
    ...base,
    registry,
    retryWorker,
    hub,
    processor,
    verifications,
    runJob,
    drain,
    runRetries,
    runAutomation,
    reply,
    reconcile,
    historyOf,
    syncsOf,
    verificationStatus,
    eventsOf,
    sentVerification,
    shopifyBeside,
    standaloneBeside,
    setup,
    teardown,
    reset,
  };
}

export type ConformanceWorld = ReturnType<typeof assembleConformanceWorld>;

/** An order delivered, processed and sent: waiting for the customer. */
export async function sendOrder<
  M extends ConformanceMerchant,
  O extends ConformanceOrder,
  I,
>(
  world: ConformanceWorld,
  driver: SourceConformanceDriver<M, O, I>,
  merchant: M,
): Promise<SentOrder<O>> {
  const order = driver.placeOrder(merchant);
  await driver.deliverOrder(merchant, order);
  await world.drain();
  return {
    order,
    ...(await world.sentVerification(
      merchant.integrationId,
      order.externalOrderId,
    )),
  };
}

/**
 * A source with its own driver, standing beside the one under test: one
 * store, connected once, taking one order per journey to a confirmed outcome
 * at its own provider.
 */
export function conformanceBeside<
  M extends ConformanceMerchant,
  O extends ConformanceOrder,
  I,
>(
  world: ConformanceWorld,
  driver: SourceConformanceDriver<M, O, I>,
): BesideSource {
  let merchant: M;
  let journeys = 0;
  return {
    label: driver.label,
    get journeys() {
      return journeys;
    },
    async connect() {
      merchant = await driver.connect();
    },
    async journey() {
      journeys += 1;
      const sendsBefore = world.sends.length;
      const order = await sendOrder(world, driver, merchant);
      await world.reply(order.verificationId, order.phone, 'confirm');
      return {
        sends: world.sends.length - sendsBefore,
        status: await world.verificationStatus(order.verificationId),
        remote: driver.remoteStateOf(merchant, order.order),
      };
    },
    expected: () => ({ sends: 1, status: 'confirmed', remote: 'confirmed' }),
    counts: () => world.reconcile(merchant, driver.appliedWrites(merchant)),
  };
}

export interface ConformanceContext<
  M extends ConformanceMerchant,
  O extends ConformanceOrder,
> {
  /** Tenant B, connected before the first case. */
  bystander: () => M;
  bystanderOrder: () => SentOrder<O>;
  sentOrder: (merchant: M) => Promise<SentOrder<O>>;
  reconcile: (merchant: M) => Promise<Reconciliation>;
}

const REMOTE_STATE: Record<
  'customer_confirmation' | 'customer_cancellation',
  RemoteOutcomeState
> = {
  customer_confirmation: 'confirmed',
  customer_cancellation: 'cancelled',
};

// --- The matrix ---

export function defineSourceConformance<
  M extends ConformanceMerchant,
  O extends ConformanceOrder,
  I,
>(suite: {
  title: string;
  world: ConformanceWorld;
  driver: SourceConformanceDriver<M, O, I>;
  /** The sources' own migrations, after the shared ones. */
  migrations: string[];
  /** Sources that stand beside every case and must work untouched. */
  besides: BesideSource[];
  /** Cases only this provider has, inside the same describe and invariants. */
  extraCases?: (context: ConformanceContext<M, O>) => void;
}): void {
  const { world, driver, besides } = suite;
  const { client, retryQueue, queued, sends, responses, secrets, logs } = world;
  const besideLabels = besides.map((beside) => beside.label).join(', ');

  const sentOrder = (merchant: M) => sendOrder(world, driver, merchant);
  const reconcile = (merchant: M) =>
    world.reconcile(merchant, driver.appliedWrites(merchant));
  const integrationsOf = (orgId: string) =>
    client`SELECT id FROM integrations WHERE org_id = ${orgId}`;

  describe(suite.title, () => {
    /** Tenant B and the other sources stand beside every case. */
    let bystander: M;
    let bystanderOrder: SentOrder<O>;

    beforeAll(async () => {
      await world.setup({
        migrations: suite.migrations,
        faultTables: [driver.connectionTable],
      });
      bystander = await driver.connect();
      bystanderOrder = await sentOrder(bystander);
      for (const beside of besides) await beside.connect();
    });

    afterAll(() => world.teardown());

    let bystanderBefore: Awaited<ReturnType<typeof world.historyOf>>;

    beforeEach(async () => {
      world.reset();
      bystanderBefore = await world.historyOf(bystander);
    });

    /** No case may move tenant B's rows or spend tenant B's key. */
    afterEach(async () => {
      expect(await world.historyOf(bystander)).toEqual(bystanderBefore);
      expect(driver.requestsOf(bystander)).toHaveLength(0);
      expect(driver.remoteStateOf(bystander, bystanderOrder.order)).toBe(
        'untouched',
      );
    });

    describe('AC1 journey: install, order, send, customer outcome, store status', () => {
      it.each([
        ['confirm', 'confirmed', 'customer_confirmation'],
        ['cancel', 'canceled', 'customer_cancellation'],
      ] as const)(
        `a customer %s ends as %s in ${driver.label}, with every count reconciled`,
        async (action, target, outcome) => {
          const merchant = await driver.connect({ unproven: true });
          await driver.expects.justConnected(merchant);

          const order = driver.placeOrder(merchant);
          const ack = await driver.deliverOrder(merchant, order);
          expect(ack).toEqual(driver.accepted);
          expect(await world.drain()).toEqual([{ kind: 'done' }]);

          await driver.expects.firstOrderProcessed(merchant, order);
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
          expect(sent.to).toBe(order.expectedPhone);
          expect(await world.verificationStatus(sent.verificationId)).toBe(
            'sent',
          );
          expect(driver.remoteStateOf(merchant, order)).toBe('untouched');

          await world.reply(sent.verificationId, sent.to, action);

          expect(await world.verificationStatus(sent.verificationId)).toBe(
            target,
          );
          expect(driver.remoteStateOf(merchant, order)).toBe(
            REMOTE_STATE[outcome],
          );
          expect(
            await world.syncsOf(merchant, sent.verificationId),
          ).toMatchObject([
            {
              action: outcome,
              state: 'succeeded',
              provider_status: driver.providerStatusAfter(outcome),
            },
          ]);
          driver.expects.outcomeWritten(
            merchant,
            order,
            outcome,
            sent.verificationId,
          );

          // The provider tells Akeed about Akeed's own write: nothing follows.
          await driver.deliverOutcomeEcho(merchant, order, outcome);
          await world.drain();

          expect(await world.eventsOf(merchant)).toMatchObject([
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
        const merchant = await driver.connect();
        const order = driver.placeOrder(merchant);

        const acks = await Promise.all([
          driver.deliverOrder(merchant, order),
          driver.deliverOrder(merchant, order),
          driver.deliverOrder(merchant, order),
        ]);
        await world.drain();
        const late = await driver.deliverOrder(merchant, order, {
          changed: true,
        });
        await world.drain();

        expect(acks.map((ack) => ack.status)).toEqual([200, 200, 200]);
        driver.expects.repeatedDelivery(late);
        expect(await reconcile(merchant)).toMatchObject({
          events: driver.repeatedDeliveryEvents,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
        });
        const [stored] = await client<{ total_price: string }[]>`
          SELECT total_price FROM orders WHERE integration_id = ${merchant.integrationId}`;
        expect(stored.total_price).toBe(order.expectedTotal);
      });

      it('a replayed customer reply and a replayed status webhook write to the store once', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);

        await world.reply(order.verificationId, order.phone, 'confirm');
        await world.reply(order.verificationId, order.phone, 'confirm');
        await world.reply(order.verificationId, order.phone, 'cancel');
        const statusAcks = [
          await driver.deliverOutcomeEcho(
            merchant,
            order.order,
            'customer_confirmation',
          ),
          await driver.deliverOutcomeEcho(
            merchant,
            order.order,
            'customer_confirmation',
          ),
        ];
        await world.drain();

        driver.expects.repeatedEcho(statusAcks[1]);
        expect(await world.verificationStatus(order.verificationId)).toBe(
          'confirmed',
        );
        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');
        expect(await reconcile(merchant)).toMatchObject({
          events: 2,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
          appliedSyncs: 1,
          remoteWrites: 1,
        });
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toHaveLength(1);
      });

      it('a replayed install callback is refused and leaves the stored credentials as they were', async () => {
        const owner = await world.newOrganization();
        const install = await driver.beginInstall(owner);
        const attacker = driver.foreignInstall(install);
        await driver.finishInstall(install);
        const before = await driver.connectionRow(owner.orgId);

        const replay = await world.answer(
          driver.finishInstall(install, attacker),
        );

        expect(replay).toMatchObject({
          status: 401,
          code: driver.codes.installContextInvalid,
        });
        expect(before).toBeDefined();
        expect(await driver.connectionRow(owner.orgId)).toEqual(before);
        expect(driver.requestsWithInstallKeys(attacker)).toHaveLength(0);
      });
    });

    describe('AC3 wrong-store credentials', () => {
      it('one tenant’s token, secret or key never reaches another tenant’s store', async () => {
        const merchant = await driver.connect();
        const eventsBefore = (await reconcile(merchant)).events;

        const { recorded } = await driver.attemptCrossTenantDeliveries(
          merchant,
          bystander,
          bystanderOrder,
        );
        expect(await world.drain()).toEqual(
          Array.from({ length: recorded }, () => ({ kind: 'done' })),
        );

        expect(queued).toHaveLength(0);
        expect(await reconcile(merchant)).toMatchObject({
          events: eventsBefore + recorded,
          orders: 0,
          verifications: 0,
          sends: 0,
          usage: 0,
        });
        expect(
          await world.verificationStatus(bystanderOrder.verificationId),
        ).toBe('sent');
      });

      it('an outcome that names another tenant’s order is refused before any key is used', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);

        const crossed = await world.registry.dispatch({
          orgId: merchant.orgId,
          integrationId: merchant.integrationId,
          externalOrderId: bystanderOrder.order.externalOrderId,
          action: 'customer_cancellation',
          correlationId: order.verificationId,
          retryInBackground: true,
        });
        const borrowed = await world.registry.dispatch({
          orgId: merchant.orgId,
          integrationId: bystander.integrationId,
          externalOrderId: bystanderOrder.order.externalOrderId,
          action: 'customer_cancellation',
          correlationId: order.verificationId,
          retryInBackground: true,
        });

        expect(crossed.status).toBe('permanent_failure');
        expect(borrowed.status).toBe('permanent_failure');
        expect(driver.requestsOf()).toHaveLength(0);
        expect(retryQueue.waiting).toHaveLength(0);
      });

      it('a store whose key answers for a different store is not written to', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        await driver.makeStoreAnswerAsAnother(merchant, order.order);

        await world.reply(order.verificationId, order.phone, 'confirm');

        expect(await world.verificationStatus(order.verificationId)).toBe(
          'confirmed',
        );
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          { state: 'failed', error_code: driver.codes.storeMismatch },
        ]);
        expect(driver.writesOf()).toHaveLength(0);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('untouched');
      });
    });

    describe('AC3 key revocation', () => {
      it('a revoked key stops the store update at once, keeps the customer’s answer and retries nothing', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        driver.revokeKey(merchant);

        await world.reply(order.verificationId, order.phone, 'confirm');

        expect(await world.verificationStatus(order.verificationId)).toBe(
          'confirmed',
        );
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          {
            state: 'failed',
            error_code: 'source_credentials_rejected',
            requires_assistance: true,
          },
        ]);
        expect(await driver.healthOf(merchant)).toBe('credentials_rejected');
        expect(driver.requestsOf(merchant)).toEqual([
          expect.objectContaining({ method: 'GET', answered: 401 }),
        ]);
        expect(retryQueue.waiting).toHaveLength(0);
        expect(await world.runRetries()).toBe(0);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('untouched');
      });

      it('a new key from a disconnect and same-store reconnect resumes store updates', async () => {
        const merchant = await driver.connect();
        driver.revokeKey(merchant);
        await driver.disconnect(merchant);

        const reconnected = await driver.reconnect(merchant);
        const order = await sentOrder(reconnected);
        await world.reply(order.verificationId, order.phone, 'confirm');

        expect(driver.remoteStateOf(reconnected, order.order)).toBe(
          'confirmed',
        );
        expect(driver.retiredKeyRequests(merchant)).toHaveLength(0);
        expect(await driver.healthOf(merchant)).toBe('ok');
      });
    });

    describe('AC3 rate limits', () => {
      it('a 429 with Retry-After waits without spending an attempt, then writes exactly once', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        driver.failNext(merchant, 'write', {
          kind: 'rate_limited',
          retryAfterSeconds: 1,
        });

        await world.reply(order.verificationId, order.phone, 'confirm');

        expect(await world.verificationStatus(order.verificationId)).toBe(
          'confirmed',
        );
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          {
            state: 'pending',
            error_code: 'source_rate_limited',
            attempts: 0,
            deferrals: 1,
          },
        ]);
        expect(retryQueue.delays).toEqual([1_000]);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('untouched');

        await new Promise((done) => setTimeout(done, 1_100));
        expect(await world.runRetries()).toBe(1);

        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([{ state: 'succeeded', attempts: 1, deferrals: 1 }]);
        expect(
          driver.writesOf(merchant).map((request) => request.answered),
        ).toEqual([429, 200]);
      });

      it(driver.titles.throttledWithoutHint, async () => {
        const merchant = await driver.connect();
        const first = await sentOrder(merchant);
        const second = await sentOrder(merchant);
        const other = await driver.connect();
        const otherOrder = await sentOrder(other);
        driver.failNext(merchant, 'read', { kind: 'rate_limited' });

        await world.reply(first.verificationId, first.phone, 'confirm');
        const requestsWhenLimited = driver.requestsOf(merchant).length;
        await world.reply(second.verificationId, second.phone, 'confirm');
        await world.reply(
          otherOrder.verificationId,
          otherOrder.phone,
          'confirm',
        );

        expect(retryQueue.delays[0]).toBeGreaterThan(0);
        await driver.expects.throttledWithoutHint({
          merchant,
          second,
          requestsWhenLimited,
        });
        // Both answers are kept; neither order is written twice or lost.
        expect(await world.verificationStatus(first.verificationId)).toBe(
          'confirmed',
        );
        expect(await world.verificationStatus(second.verificationId)).toBe(
          'confirmed',
        );
        // The other store is not delayed.
        expect(driver.remoteStateOf(other, otherOrder.order)).toBe('confirmed');
        expect(await reconcile(other)).toMatchObject({
          appliedSyncs: 1,
          remoteWrites: 1,
        });
      });
    });

    describe('AC3 queue and provider outages', () => {
      it('a queue outage at webhook dispatch: acknowledged after the durable write, recovered by the sweep, one order', async () => {
        const merchant = await driver.connect();
        const order = driver.placeOrder(merchant);
        world.queue.down = true;

        const ack = await driver.deliverOrder(merchant, order);
        const repeat = await driver.deliverOrder(merchant, order);

        expect(ack).toEqual(driver.accepted);
        driver.expects.repeatedDelivery(repeat);
        expect(queued).toHaveLength(0);
        expect(await reconcile(merchant)).toMatchObject({
          events: driver.repeatedDeliveryEvents,
          orders: 0,
        });

        world.queue.down = false;
        await client`
          UPDATE webhook_events
          SET next_dispatch_at = now() - interval '1 second', dispatch_lease_until = NULL
          WHERE integration_id = ${merchant.integrationId}`;
        const swept = await world.reconciler.reconcileOnce();
        await world.drain();

        expect(swept.dispatched).toBe(driver.repeatedDeliveryEvents);
        expect(await reconcile(merchant)).toMatchObject({
          events: driver.repeatedDeliveryEvents,
          completedEvents: 1,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
        });
      });

      it('a queue outage at outcome retry: a visible failure the merchant retries, written once', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        driver.failNext(merchant, 'read', { kind: 'unavailable' });
        retryQueue.down = true;

        await world.reply(order.verificationId, order.phone, 'cancel');

        expect(await world.verificationStatus(order.verificationId)).toBe(
          'canceled',
        );
        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          { state: 'failed', error_code: 'retry_not_scheduled' },
        ]);

        retryQueue.down = false;
        const retried = await world.verifications.retryOutcomeSync(
          merchant.owner,
          order.verificationId,
        );
        responses.push(retried);

        expect(retried.remote_sync).toMatchObject({ state: 'succeeded' });
        expect(driver.remoteStateOf(merchant, order.order)).toBe('cancelled');
        expect(await reconcile(merchant)).toMatchObject({
          appliedSyncs: 1,
          remoteWrites: 1,
        });
      });

      it('a provider outage ends in a bounded, visible failure, and every try after a merchant retry is queued', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        for (let tries = 0; tries < OUTCOME_SYNC_MAX_ATTEMPTS; tries++)
          driver.failNext(merchant, 'read', { kind: 'unavailable' });

        await world.reply(order.verificationId, order.phone, 'confirm');
        expect(await world.runRetries()).toBe(OUTCOME_SYNC_MAX_ATTEMPTS - 1);

        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          {
            state: 'failed',
            error_code: 'source_unavailable',
            attempts: OUTCOME_SYNC_MAX_ATTEMPTS,
            requires_assistance: false,
          },
        ]);
        expect(retryQueue.waiting).toHaveLength(0);
        expect(await world.verificationStatus(order.verificationId)).toBe(
          'confirmed',
        );

        // The outage outlasts the merchant's retry: the rewound counters name
        // tries that already ran, and each one must still reach the queue.
        for (let tries = 0; tries < 2; tries++)
          driver.failNext(merchant, 'read', { kind: 'unavailable' });
        await world.verifications.retryOutcomeSync(
          merchant.owner,
          order.verificationId,
        );
        expect(retryQueue.waiting).toHaveLength(1);
        expect(await world.runRetries(1)).toBe(1);
        expect(retryQueue.waiting).toHaveLength(1);
        expect(await world.runRetries()).toBe(1);

        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([{ state: 'succeeded' }]);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');
        expect(await reconcile(merchant)).toMatchObject({
          sends: 1,
          usage: 1,
          appliedSyncs: 1,
          remoteWrites: 1,
        });
      });
    });

    describe('fault injection', () => {
      it.each(
        driver.installFaults.map((fault) => [fault.name, fault] as const),
      )(
        'install callback, %s: nothing is stored and the same link works on retry',
        async (_name, fault) => {
          const owner = await world.newOrganization();
          const install = await driver.beginInstall(owner);
          fault.inject(install);

          const first = await world.answer(driver.finishInstall(install));

          expect(first).toMatchObject(fault.refusal);
          expect(await integrationsOf(owner.orgId)).toHaveLength(0);
          await fault.expectNothingLeft?.(install);

          await driver.finishInstall(install);
          expect(await integrationsOf(owner.orgId)).toHaveLength(1);
        },
      );

      it('install callback, database write fails half-way: all of it is rolled back and the same link then connects', async () => {
        const owner = await world.newOrganization();
        const install = await driver.beginInstall(owner);

        await client`UPDATE fault_switch SET fail = true`;
        try {
          await expect(driver.finishInstall(install)).rejects.toThrow();
        } finally {
          await client`UPDATE fault_switch SET fail = false`;
        }
        expect(await integrationsOf(owner.orgId)).toHaveLength(0);

        await driver.finishInstall(install);
        expect(await driver.connectionRow(owner.orgId)).toBeDefined();
        expect(await integrationsOf(owner.orgId)).toHaveLength(1);
      });

      it('remote status timeout before the write was taken: read back, then written once', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        driver.failNext(merchant, 'write', { kind: 'timeout_before_apply' });

        await world.reply(order.verificationId, order.phone, 'confirm');

        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          { state: 'pending', error_code: 'write_unconfirmed', attempts: 1 },
        ]);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('untouched');
        expect(await world.runRetries()).toBe(1);

        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');
        expect(driver.trace(merchant)).toEqual(
          driver.traces.timeoutBeforeApply,
        );
        expect(await reconcile(merchant)).toMatchObject({
          appliedSyncs: 1,
          remoteWrites: 1,
        });
      });

      it('remote status timeout after the write was taken: read back, and never written again', async () => {
        const merchant = await driver.connect();
        const order = await sentOrder(merchant);
        driver.failNext(merchant, 'write', { kind: 'timeout_after_apply' });

        await world.reply(order.verificationId, order.phone, 'cancel');

        expect(
          await world.syncsOf(merchant, order.verificationId),
        ).toMatchObject([
          {
            state: 'succeeded',
            provider_status: driver.providerStatusAfter(
              'customer_cancellation',
            ),
          },
        ]);
        expect(driver.trace(merchant)).toEqual(driver.traces.timeoutAfterApply);
        expect(retryQueue.waiting).toHaveLength(0);
        expect(driver.remoteStateOf(merchant, order.order)).toBe('cancelled');
      });
    });

    describe('AC4 disconnect and reconnect', () => {
      it('keeps every order, verification, event, usage row and store update, on the same source', async () => {
        const merchant = await driver.connect();
        const answered = await sentOrder(merchant);
        await world.reply(answered.verificationId, answered.phone, 'confirm');
        const waiting = await sentOrder(merchant);
        const before = await world.historyOf(merchant);
        const countsBefore = await reconcile(merchant);

        await driver.disconnect(merchant);

        expect(await world.historyOf(merchant)).toEqual(before);
        await driver.expects.disconnected(merchant);
        // The old address is dead, and a late answer stays in Akeed.
        expect(
          (await driver.deliverOrder(merchant, driver.placeOrder(merchant)))
            .status,
        ).toBe(401);
        const requestsBefore = driver.requestCount();
        await world.reply(waiting.verificationId, waiting.phone, 'confirm');
        expect(await world.verificationStatus(waiting.verificationId)).toBe(
          'confirmed',
        );
        expect(driver.requestCount()).toBe(requestsBefore);
        expect(driver.remoteStateOf(merchant, waiting.order)).toBe('untouched');

        const reconnected = await driver.reconnect(merchant);

        const [source, ...others] = await client<
          { id: string; is_active: boolean }[]
        >`SELECT id, is_active FROM integrations WHERE org_id = ${merchant.orgId}`;
        expect(others).toHaveLength(0);
        expect(source).toEqual({ id: merchant.integrationId, is_active: true });
        const after = await world.historyOf(merchant);
        expect(after.orders).toEqual(before.orders);
        expect(after.events).toEqual(before.events);
        expect(after.usage).toEqual(before.usage);
        expect(after.dispatches).toEqual(before.dispatches);
        expect(JSON.parse(after.syncs)).toEqual(
          expect.arrayContaining(JSON.parse(before.syncs) as unknown[]),
        );
        expect(
          (await driver.deliverOrder(merchant, driver.placeOrder(merchant)))
            .status,
        ).toBe(401);

        const fresh = await sentOrder(reconnected);
        await world.reply(fresh.verificationId, fresh.phone, 'confirm');

        expect(driver.remoteStateOf(reconnected, fresh.order)).toBe(
          'confirmed',
        );
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
        `with remote writes %s, an unanswered order is never canceled in ${driver.label} by Akeed itself`,
        async (_label, syncEnabled) => {
          driver.switches.outcomeSync(syncEnabled);
          const merchant = await driver.connect();
          const order = await sentOrder(merchant);

          await world.runAutomation(order.verificationId, 'follow_up');
          await world.runAutomation(order.verificationId, 'no_reply');

          expect(await world.verificationStatus(order.verificationId)).toBe(
            'no_reply',
          );
          expect(driver.requestsOf(merchant)).toHaveLength(0);
          expect(driver.remoteStateOf(merchant, order.order)).toBe('untouched');
          expect(
            await world.syncsOf(merchant, order.verificationId),
          ).toMatchObject([
            { action: 'automatic_no_reply_tagging', state: 'unsupported' },
          ]);
          expect(retryQueue.waiting).toHaveLength(0);
          expect(await world.runRetries()).toBe(0);

          // Only the merchant's own action may cancel, and only with writes on.
          const cancel = await world.answer(
            world.verifications.cancelNoReplyOrder(
              merchant.owner,
              order.verificationId,
            ),
          );
          if (syncEnabled) {
            expect(cancel.status).toBe(200);
            expect(driver.remoteStateOf(merchant, order.order)).toBe(
              'cancelled',
            );
            expect(driver.writesOf(merchant)).toHaveLength(1);
          } else {
            expect(cancel.status).toBe(400);
            expect(driver.requestsOf(merchant)).toHaveLength(0);
            expect(driver.remoteStateOf(merchant, order.order)).toBe(
              'untouched',
            );
          }
        },
      );

      it(`the ${driver.label} adapter never offers an automatic or tagging action`, () => {
        const adapter = driver.newAdapter();

        expect([...adapter.capabilities].sort()).toEqual([
          'customer_cancellation',
          'customer_confirmation',
          'merchant_no_reply_cancellation',
        ]);
      });
    });

    describe(`pausing ${driver.label} without touching ${besideLabels}`, () => {
      it(`with the connect switch off: no new connection, existing stores keep working, ${besideLabels} is processed`, async () => {
        const merchant = await driver.connect();
        const owner = await world.newOrganization();
        const open = await driver.beginInstall(owner);
        driver.switches.connect(false);

        const start = await world.answer(driver.startInstall(owner));
        const callback = await world.answer(driver.finishInstall(open));

        expect(start).toMatchObject({
          status: 404,
          code: driver.codes.connectUnavailable,
        });
        expect(callback).toMatchObject({
          status: 404,
          code: driver.codes.connectUnavailable,
        });
        expect(await integrationsOf(owner.orgId)).toHaveLength(0);
        expect(driver.requestsWithInstallKeys(open)).toHaveLength(0);

        const order = await sentOrder(merchant);
        await world.reply(order.verificationId, order.phone, 'confirm');
        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');

        for (const beside of besides)
          expect(await beside.journey()).toMatchObject(beside.expected());
      });

      it(`${besideLabels} is processed the same with every ${driver.label} switch on and with every switch off`, async () => {
        const merchant = await driver.connect();
        const allOn: Record<string, unknown>[] = [];
        for (const beside of besides) allOn.push(await beside.journey());
        const requestsBefore = driver.requestCount();

        driver.switches.connect(false);
        driver.switches.ingestion(false);
        driver.switches.outcomeSync(false);
        const allOff: Record<string, unknown>[] = [];
        for (const beside of besides) allOff.push(await beside.journey());
        const refused = await driver.deliverOrder(
          merchant,
          driver.placeOrder(merchant),
        );

        expect(allOff).toEqual(allOn);
        for (const [index, beside] of besides.entries())
          expect(allOn[index]).toMatchObject(beside.expected());
        // The source itself is dark: the address answers 404 and stores nothing.
        expect(refused.status).toBe(404);
        expect(await reconcile(merchant)).toMatchObject({
          events: 0,
          orders: 0,
        });
        expect(driver.requestCount()).toBe(requestsBefore);
        for (const beside of besides)
          expect(await beside.counts()).toMatchObject({
            orders: beside.journeys,
            verifications: beside.journeys,
            sends: beside.journeys,
            usage: beside.journeys,
          });
      });
    });

    suite.extraCases?.({
      bystander: () => bystander,
      bystanderOrder: () => bystanderOrder,
      sentOrder,
      reconcile,
    });

    // Last: it reads what every case before it logged, answered and stored.
    describe('secrets', () => {
      it('no key, token or webhook secret is logged, returned or stored in clear', async () => {
        const scanned = [
          'webhook_events',
          'commerce_outcome_syncs',
          ...driver.secretTables,
          'integrations',
          'orders',
          'verifications',
        ];
        const stored = await client.unsafe<{ row: string }[]>(
          scanned
            .map((table) => `SELECT to_jsonb(t)::text AS row FROM ${table} t`)
            .join(' UNION ALL '),
        );
        const haystack = [
          ...logs,
          JSON.stringify(responses),
          ...stored.map((item) => item.row),
        ].join('\n');

        expect(secrets.size).toBeGreaterThan(driver.minimums.secrets);
        expect(logs.length).toBeGreaterThan(driver.minimums.logs);
        expect(stored.length).toBeGreaterThan(driver.minimums.storedRows);
        for (const value of secrets) {
          expect(haystack).not.toContain(value);
          // A token is stored only as its hash; the hash is never logged or
          // returned either.
          expect(
            `${logs.join('\n')}\n${JSON.stringify(responses)}`,
          ).not.toContain(driver.hashToken(value));
        }
      });

      it('the fixtures hold no key, token or secret, and say they were not captured', () => {
        for (const name of driver.fixtures.files) {
          const text = readFileSync(
            resolve(driver.fixtures.directory, name),
            'utf8',
          );
          const fixture = JSON.parse(text) as { _fixture: { source: string } };

          expect(fixture._fixture.source).toBe('documented, not captured');
          expect(text).not.toMatch(driver.fixtures.forbidden);
          for (const value of secrets) expect(text).not.toContain(value);
        }
      });
    });
  });
}
