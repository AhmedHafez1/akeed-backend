import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job } from 'bullmq';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../../src/infrastructure/database/schema';
import * as schema from '../../src/infrastructure/database';
import { CreditAccountingRepository } from '../../src/infrastructure/database/repositories/credit-accounting.repository';
import { IntegrationMonthlyUsageRepository } from '../../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { IntegrationsRepository } from '../../src/infrastructure/database/repositories/integrations.repository';
import { ManualOrderIngestionRepository } from '../../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import { OrderImportReleaseRepository } from '../../src/infrastructure/database/repositories/order-import-release.repository';
import { OrderImportsRepository } from '../../src/infrastructure/database/repositories/order-imports.repository';
import { OrdersRepository } from '../../src/infrastructure/database/repositories/orders.repository';
import { PeriodicPlanAccounting } from '../../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../../src/infrastructure/database/repositories/usage-accounting.router';
import { VerificationMessageDispatchesRepository } from '../../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationsRepository } from '../../src/infrastructure/database/repositories/verifications.repository';
import { WebhookEventsRepository } from '../../src/infrastructure/database/repositories/webhook-events.repository';
import { WhatsAppWebhookService } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { StandaloneOrderEligibilityStrategy } from '../../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneOutcomeAdapter } from '../../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import { CommerceOutcomeRegistryService } from '../../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { OrderImportCommitProcessor } from '../../src/modules/order-imports/order-import-commit.processor';
import { OrderImportCommitService } from '../../src/modules/order-imports/order-import-commit.service';
import { OrderImportDetailService } from '../../src/modules/order-imports/order-import-detail.service';
import { OrderImportMappingService } from '../../src/modules/order-imports/order-import-mapping.service';
import { OrderImportRowsService } from '../../src/modules/order-imports/order-import-rows.service';
import { OrderImportsService } from '../../src/modules/order-imports/order-imports.service';
import { ImportFileParser } from '../../src/modules/order-imports/parsers/import-file-parser';
import { OrderImportReleaseTickService } from '../../src/modules/order-imports/release/order-import-release-tick.service';
import { OrderImportReleaseService } from '../../src/modules/order-imports/release/order-import-release.service';
import { RowValidationService } from '../../src/modules/order-imports/validation/row-validation.service';
import { StandaloneOrderIngestionService } from '../../src/modules/order-ingestion/standalone-order-ingestion.service';
import { StandaloneSendReadinessService } from '../../src/modules/order-ingestion/standalone-send-readiness.service';
import {
  IMPORT_SOURCE_CODES,
  StandaloneSourceResolver,
} from '../../src/modules/order-ingestion/standalone-source-resolver';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { VerificationAutomationProcessor } from '../../src/modules/verification-automation/verification-automation.processor';
import { VerificationAutomationJobType } from '../../src/modules/verification-automation/verification-automation.constants';
import { BillingEntitlementService } from '../../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../../src/modules/verification-core/order-eligibility.service';
import { VerificationHubService } from '../../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../../src/modules/verification-core/verification-send.service';
import { VerificationsService } from '../../src/modules/verifications/verifications.service';
import { StandaloneManualOrderNormalizer } from '../../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookDispatchReconciler } from '../../src/modules/webhook-queue/webhook-dispatch-reconciler.service';
import { WebhookDispatchService } from '../../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookQueueProcessor } from '../../src/modules/webhook-queue/webhook-queue.processor';
import type { AuthenticatedUser } from '../../src/modules/auth/guards/dual-auth.guard';
import {
  ConfirmedMessageRejection,
  type MessagingPort,
} from '../../src/shared/ports/messaging.port';
import { PhoneService } from '../../src/shared/services/phone.service';
import type { WebhookJobPayload } from '../../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { standaloneCreditBillingConfigService } from './standalone-credit-billing-config';

export const QUOTE_SECRET = 'release-gate-quote-secret-0123456789abcdef';

/** The bulk-import settings and prepaid credit billing, as the app parses them. */
export function releaseGateConfig(overrides: Record<string, string> = {}) {
  return standaloneCreditBillingConfigService({
    STANDALONE_CREDIT_BILLING_ENABLED: 'true',
    PAYMOB_MODE: 'test',
    PAYMOB_BASE_URL: 'http://localhost:9000',
    PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
    PAYMOB_RETURN_URL: 'http://localhost:9000',
    PAYMOB_SECRET_KEY: 'sandbox-secret',
    PAYMOB_PUBLIC_KEY: 'sandbox-public',
    PAYMOB_HMAC_SECRET: 'sandbox-hmac',
    PAYMOB_CARD_INTEGRATION_ID: 'card1',
    PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
    PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
    STANDALONE_BULK_IMPORT_ENABLED: 'true',
    BULK_IMPORT_QUOTE_SECRET: QUOTE_SECRET,
    BULK_IMPORT_RELEASE_PER_MINUTE: '20',
    ...overrides,
  });
}

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e01_test' ||
    url.username !== 'e01_test' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  return value;
}

/** One send the fake messaging port accepted, as Meta would. */
export interface RecordedSend {
  to: string;
  verificationId: string;
  orderNumber: string;
  totalPrice: string;
}

/** A follow-up or no-reply job the hub asked the automation queue for. */
export interface RecordedAutomationJob {
  kind: 'initial' | 'follow_up' | 'no_reply';
  verificationId: string;
  orgId: string;
  dueAt: Date;
}

/**
 * US-04.6-10 release gate: the whole Standalone confirmation path over
 * PostgreSQL. Real repositories, real ingestion, real import services, the
 * real dispatcher and queue processor, the real hub, send service, credit
 * ledger and WhatsApp webhook service. Only the edges are fakes: the messaging
 * port (never Meta), the BullMQ queues (jobs are recorded and run in process),
 * the clock-driven automation queue and the release scheduler's registration.
 */
export function releaseGateHarness(
  configOverrides: Record<string, string> = {},
) {
  const namespace = `e046_gate_${randomUUID().replaceAll('-', '')}`;
  const client = postgres(isolatedDatabaseUrl(), {
    max: 10,
    connect_timeout: 5,
    onnotice: () => undefined,
    connection: { search_path: `${namespace},public` },
  });
  const db = drizzle(client, { schema });
  const config = releaseGateConfig(configOverrides);

  const sends: RecordedSend[] = [];
  /** While set, Meta refuses every send, as it does for a paused template. */
  const provider = { rejecting: false };
  const messaging: MessagingPort = {
    sendVerificationTemplate(params) {
      if (provider.rejecting)
        return Promise.reject(
          new ConfirmedMessageRejection('provider_rejected'),
        );
      sends.push({
        to: params.to,
        verificationId: params.verificationId,
        orderNumber: params.orderNumber,
        totalPrice: params.totalPrice,
      });
      return Promise.resolve({
        messages: [{ id: `wamid-gate-${sends.length}` }],
      });
    },
  };

  const automationJobs: RecordedAutomationJob[] = [];
  const automation = {
    enqueueInitialSend: (params: {
      verificationId: string;
      orgId: string;
      dueAt: Date;
    }) => {
      automationJobs.push({ kind: 'initial', ...params });
      return Promise.resolve();
    },
    enqueueFollowUp: (params: {
      verificationId: string;
      orgId: string;
      dueAt: Date;
    }) => {
      automationJobs.push({ kind: 'follow_up', ...params });
      return Promise.resolve();
    },
    enqueueNoReplyEscalation: (params: {
      verificationId: string;
      orgId: string;
      dueAt: Date;
    }) => {
      automationJobs.push({ kind: 'no_reply', ...params });
      return Promise.resolve();
    },
  };

  const credits = new CreditAccountingRepository(db);
  const router = new UsageAccountingRouter(
    new PrepaidCreditAccounting(credits),
    new PeriodicPlanAccounting(),
    config,
  );
  const ordersRepo = new OrdersRepository(db);
  const verificationsRepo = new VerificationsRepository(db);
  const events = new WebhookEventsRepository(db);
  // Typed against the bare schema module; the same tables at runtime.
  const integrations = new IntegrationsRepository(db as never, config);
  const dispatches = new VerificationMessageDispatchesRepository(db, router);
  const imports = new OrderImportsRepository(db);
  const releases = new OrderImportReleaseRepository(db);

  const billing = new BillingEntitlementService(
    new IntegrationMonthlyUsageRepository(db),
    router,
  );
  const creditEligibility = new CreditEligibilityService(credits, config);
  const eligibility = new OrderEligibilityService([
    new StandaloneOrderEligibilityStrategy(),
  ]);
  const outcomes = new CommerceOutcomeRegistryService(ordersRepo, [
    new StandaloneOutcomeAdapter(),
  ]);
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
    outcomes,
    eligibility,
    send,
    billing,
    creditEligibility,
    automation as never,
  );
  const processor = new WebhookQueueProcessor(
    [new StandaloneManualOrderNormalizer()],
    events,
    integrations,
    hub,
  );
  const automationProcessor = new VerificationAutomationProcessor(
    verificationsRepo,
    ordersRepo,
    send,
    hub,
    outcomes,
    billing,
  );
  const whatsapp = new WhatsAppWebhookService(
    verificationsRepo,
    hub,
    dispatches,
  );

  /** Jobs BullMQ would have received; `drain` runs them in order. */
  const queued: WebhookJobPayload[] = [];
  const dispatchedIds: string[] = [];
  const dispatcher = new WebhookDispatchService(
    {
      add: (_name: string, payload: WebhookJobPayload) => {
        queued.push(payload);
        dispatchedIds.push(payload.webhookEventId);
        return Promise.resolve();
      },
    } as never,
    events,
    { get: () => undefined } as never,
  );
  async function drain(): Promise<void> {
    while (queued.length > 0) {
      const payload = queued.shift()!;
      await processor.process({
        id: `job-${payload.webhookEventId}`,
        data: payload,
      } as Job<WebhookJobPayload>);
    }
  }

  const resolver = new StandaloneSourceResolver(integrations);
  const ingestion = new StandaloneOrderIngestionService(
    new ManualOrderIngestionRepository(db),
    dispatcher,
    verificationsRepo,
    resolver,
  );
  const readiness = new StandaloneSendReadinessService(
    billing,
    creditEligibility,
    eligibility,
  );
  const orders = new OrdersService(
    ordersRepo,
    ingestion,
    new PhoneService(),
    readiness,
    dispatcher,
    events,
  );

  const validation = new RowValidationService(
    imports,
    new PhoneService(),
    eligibility,
    config,
  );
  const mapping = new OrderImportMappingService(imports, validation);
  const uploads = new OrderImportsService(
    imports,
    new ImportFileParser(),
    config,
    mapping,
  );
  const detail = new OrderImportDetailService(
    imports,
    mapping,
    releases,
    ordersRepo,
    config,
  );
  const commitJobs: { batchId: string; orgId: string }[] = [];
  const commits = new OrderImportCommitService(imports, detail, {
    enqueue: (job: { batchId: string; orgId: string }) => {
      commitJobs.push(job);
      return Promise.resolve();
    },
  } as never);
  const commitProcessor = new OrderImportCommitProcessor(
    imports,
    ingestion,
    config,
  );
  const scheduler = {
    ensure: jest.fn(() => Promise.resolve()),
    remove: jest.fn(() => Promise.resolve()),
  };
  const starts = new OrderImportReleaseService(
    releases,
    events,
    readiness,
    scheduler as never,
    detail,
    config,
  );
  const ticks = new OrderImportReleaseTickService(
    releases,
    integrations,
    readiness,
    events,
    dispatcher,
    scheduler as never,
    config,
  );
  const rows = new OrderImportRowsService(imports);
  const reconciler = new WebhookDispatchReconciler(events, dispatcher, {
    get: () => undefined,
  } as never);
  const verifications = new VerificationsService(
    verificationsRepo,
    billing,
    integrations,
    ordersRepo,
    outcomes,
  );

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
    await client.begin(async (tx) => {
      for (const statement of migrationStatements(name))
        await tx.unsafe(statement);
    });
  }

  async function setup() {
    await client`CREATE SCHEMA ${client(namespace)}`;
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
      tables.adminAccessAudit,
      tables.webhookEvents,
      tables.memberships,
      tables.billingFreePlanClaims,
    ])
      await scaffold(table);
    // What the scaffold cannot derive: the partial one-order-per-event index
    // and the hold guards from 0036 (its columns are already in the schema).
    await client.unsafe(`
      CREATE UNIQUE INDEX webhook_events_order_id_key ON webhook_events (order_id) WHERE order_id IS NOT NULL;
      ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_hold_state_check CHECK (hold_state IN ('none', 'held', 'released', 'withdrawn'));
      ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_held_not_dispatchable_check CHECK (hold_state <> 'held' OR dispatch_required = false);
    `);
    const dispatchDdl = migrationStatements(
      '0028_manual_order_lifecycle_dispatch_ledger.sql',
    ).find((part) =>
      part.includes(
        `CREATE TABLE IF NOT EXISTS "${namespace}"."verification_message_dispatches"`,
      ),
    )!;
    await client.unsafe(dispatchDdl);
    await migrate('0032_credit_and_payment_domain_foundation.sql');
    await migrate('0033_dispatch_accounting_mode.sql');
    await migrate('0035_standalone_auto_activation.sql');
    for (const name of [
      '0037_order_import_batches.sql',
      '0038_order_import_validation_version.sql',
      '0039_order_import_release.sql',
      '0040_order_import_row_retention.sql',
    ])
      await migrate(name);
  }

  async function teardown() {
    try {
      await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  /**
   * A Standalone merchant ready to confirm: onboarding done, auto-verify on,
   * follow-up after 60 min and no-reply after 180 min, no quiet hours, and a
   * prepaid credit balance.
   */
  async function merchant(
    options: {
      credits?: number;
      settings?: Partial<typeof tables.integrations.$inferInsert>;
    } = {},
  ) {
    const orgId = randomUUID();
    await db
      .insert(tables.organizations)
      .values({ id: orgId, name: 'Release gate merchant', slug: orgId });
    const [integration] = await db
      .insert(tables.integrations)
      .values({
        orgId,
        platformType: 'standalone',
        platformStoreUrl: `standalone:${orgId}`,
        storeName: 'Gate Store',
        isActive: true,
        onboardingStatus: 'completed',
        isAutoVerifyEnabled: true,
        followUpEnabled: true,
        followUpDelayMinutes: 60,
        escalationEnabled: true,
        escalationDelayMinutes: 180,
        quietHoursEnabled: false,
        sendDelayMinutes: 0,
        timezone: 'Africa/Cairo',
        countryCode: 'EG',
        shippingCurrency: 'EGP',
        assumeCodWhenPaymentMissing: false,
        ...options.settings,
      })
      .returning();
    const quantity = options.credits ?? 100;
    await db.transaction(async (tx) => {
      await tx
        .insert(tables.creditAccounts)
        .values({ orgId })
        .onConflictDoNothing();
      const account = await credits.lockAccount(tx, orgId);
      await credits.insertLedgerEntry(tx, {
        orgId,
        type: 'free_grant',
        quantity,
        idempotencyKey: `gate-grant:${orgId}`,
        actorId: randomUUID(),
        reason: 'Release gate opening balance',
        postedBalanceBefore: 0,
        postedBalanceAfter: quantity,
      });
      await credits.updateProjection(tx, {
        orgId,
        expectedVersion: account.version,
        postedBalance: quantity,
        heldCredits: 0,
        status: 'active',
      });
    });
    const user: AuthenticatedUser = {
      userId: randomUUID(),
      orgId,
      role: 'owner',
      source: 'supabase',
    } as AuthenticatedUser;
    const source = await resolver.resolveWritable(user, IMPORT_SOURCE_CODES);
    return { orgId, integrationId: integration.id, user, source };
  }

  /** A customer tapping a quick-reply button, as Meta posts it. */
  async function reply(
    verificationId: string,
    phone: string,
    action: 'confirm' | 'cancel',
  ) {
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

  /** Runs a recorded follow-up or no-reply job, as the automation worker would. */
  async function runAutomation(job: RecordedAutomationJob) {
    const name =
      job.kind === 'follow_up'
        ? VerificationAutomationJobType.FOLLOW_UP
        : job.kind === 'no_reply'
          ? VerificationAutomationJobType.ESCALATE_NO_REPLY
          : VerificationAutomationJobType.INITIAL_SEND;
    await automationProcessor.process({
      id: `${job.kind}-${job.verificationId}`,
      name,
      data: {
        verificationId: job.verificationId,
        orgId: job.orgId,
        scheduledAt: job.dueAt.toISOString(),
      },
    } as Parameters<typeof automationProcessor.process>[0]);
  }

  return {
    client,
    db,
    config,
    setup,
    teardown,
    merchant,
    reply,
    runAutomation,
    drain,
    sends,
    provider,
    automationJobs,
    dispatchedIds,
    commitJobs,
    scheduler,
    services: {
      orders,
      uploads,
      mapping,
      validation,
      detail,
      rows,
      reconciler,
      commits,
      commitProcessor,
      starts,
      ticks,
      verifications,
      ingestion,
      readiness,
      dispatcher,
      hub,
    },
    repositories: {
      orders: ordersRepo,
      verifications: verificationsRepo,
      events,
      dispatches,
      credits,
      imports,
      releases,
      integrations,
    },
  };
}

export type ReleaseGateHarness = ReturnType<typeof releaseGateHarness>;
