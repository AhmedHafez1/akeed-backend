import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { VerificationAutoCancellationsRepository } from '../src/infrastructure/database/repositories/verification-auto-cancellations.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { AutoCancellationService } from '../src/modules/auto-cancellation/auto-cancellation.service';

/**
 * Automatic cancellation over PostgreSQL: the migration and its constraints,
 * one claim per row under concurrent workers, the guarded finish, the
 * customer-message hook and the needs-action reasons it adds.
 */

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

const namespace = `auto_cancel_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 6,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const repo = new VerificationAutoCancellationsRepository(db as never);
const verificationsRepo = new VerificationsRepository(db as never);

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
    .split('--> statement-breakpoint')
    .filter((part) => part.trim());
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

const orgId = randomUUID();
const integrationId = randomUUID();
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An unanswered order whose two messages were delivered a day ago. */
async function seedNoReply(
  overrides: {
    phone?: string;
    verification?: Partial<typeof tables.verifications.$inferInsert>;
  } = {},
): Promise<string> {
  const orderId = randomUUID();
  const verificationId = randomUUID();
  await db.insert(tables.orders).values({
    id: orderId,
    orgId,
    integrationId,
    externalOrderId: `ext-${orderId}`,
    orderNumber: '1001',
    customerPhone: overrides.phone ?? '+201000000001',
    customerName: 'Customer',
    totalPrice: '100.00',
    currency: 'EGP',
  });
  await db.insert(tables.verifications).values({
    id: verificationId,
    orgId,
    orderId,
    status: 'no_reply',
    lastSentAt: ago(30 * HOUR),
    deliveredAt: ago(30 * HOUR),
    followUpAttempts: 1,
    followUpSentAt: ago(24 * HOUR),
    ...overrides.verification,
  });
  for (const [kind, at] of [
    ['initial', ago(30 * HOUR)],
    ['follow_up', ago(24 * HOUR)],
  ] as const) {
    await db.insert(tables.verificationMessageDispatches).values({
      orgId,
      integrationId,
      verificationId,
      dispatchKey: `${verificationId}:${kind}:1`,
      kind,
      state: 'accepted',
      acceptedAt: at,
      deliveredAt: at,
    });
  }
  return verificationId;
}

function service(options: {
  inspect?: () => Promise<unknown>;
  dispatch?: () => Promise<unknown>;
}) {
  const registry = {
    inspectForCancellation: jest.fn(
      options.inspect ?? (() => Promise.resolve({ state: 'cancellable' })),
    ),
    dispatch: jest.fn(async (command: { action: string }) =>
      command.action === 'automatic_no_reply_cancellation'
        ? ((await options.dispatch?.()) ?? { status: 'applied' })
        : { status: 'applied' },
    ),
    resolveOperation: jest.fn(() => Promise.resolve({ state: 'done' })),
  };
  const producer = {
    enqueueExecute: jest.fn(() => Promise.resolve()),
    enqueueConfirm: jest.fn(() => Promise.resolve()),
  };
  return {
    registry,
    producer,
    service: new AutoCancellationService(
      repo,
      registry as never,
      producer as never,
    ),
  };
}

beforeAll(async () => {
  await client`CREATE SCHEMA ${client(namespace)}`;
  await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  for (const candidate of Object.values(tables)) {
    if (
      typeof candidate === 'function' &&
      'enumName' in candidate &&
      'enumValues' in candidate
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
    tables.verificationMessageDispatches,
    tables.commerceOutcomeSyncs,
  ])
    await scaffold(table);
  // The new columns came from the scaffold; drop them so the migration adds
  // them, then apply it twice to prove it re-runs.
  await client.unsafe(`
    ALTER TABLE integrations DROP COLUMN auto_cancel_enabled, DROP COLUMN auto_cancel_restock, DROP COLUMN auto_cancel_notify_customer;
    ALTER TABLE verifications DROP COLUMN customer_last_message_at, DROP COLUMN auto_cancel_excluded_at, DROP COLUMN auto_cancel_excluded_by;
  `);
  await migrate('0075_auto_cancel_unanswered.sql');
  await migrate('0075_auto_cancel_unanswered.sql');

  await db
    .insert(tables.organizations)
    .values({ id: orgId, name: 'Store', slug: `store-${orgId}` });
  await db.insert(tables.integrations).values({
    id: integrationId,
    orgId,
    platformType: 'shopify',
    platformStoreUrl: 'auto-cancel.myshopify.com',
    isActive: true,
    autoCancelEnabled: true,
    quietHoursEnabled: false,
  });
});

afterAll(async () => {
  await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`;
  await client.end();
});

describe('auto-cancellation against PostgreSQL', () => {
  it('ships the defaults and the widened outcome action check', async () => {
    const [store] = await client`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = ${namespace} AND table_name = 'integrations'
        AND column_name = 'auto_cancel_enabled'`;
    expect(store.column_default).toBe('false');

    const verificationId = await seedNoReply();
    const [order] = await client<{ order_id: string }[]>`
      SELECT order_id FROM verifications WHERE id = ${verificationId}`;
    const insert = (action: string) => client`
      INSERT INTO commerce_outcome_syncs (org_id, integration_id, order_id, external_order_id, correlation_id, action, state)
      VALUES (${orgId}, ${integrationId}, ${order.order_id}, 'ext', ${verificationId}, ${action}, 'pending')`;
    await expect(
      insert('automatic_no_reply_cancellation'),
    ).resolves.toBeDefined();
    await expect(insert('automatic_cancel_everything')).rejects.toThrow(
      /commerce_outcome_syncs_action_check/,
    );
  });

  it('keeps one cancellation row per verification', async () => {
    const verificationId = await seedNoReply();
    const [{ order_id: orderId }] = await client`
      SELECT order_id FROM verifications WHERE id = ${verificationId}`;
    const values = {
      orgId,
      verificationId,
      orderId: orderId as string,
      integrationId,
      status: 'scheduled' as const,
    };
    expect(await repo.insert(db as never, values)).not.toBeNull();
    expect(await repo.insert(db as never, values)).toBeNull();
    await expect(
      client`UPDATE verification_auto_cancellations SET status = 'exploded' WHERE verification_id = ${verificationId}`,
    ).rejects.toThrow(/verification_auto_cancellations_status_check/);
  });

  it('cancels once when two workers run the same due row at the same time', async () => {
    const verificationId = await seedNoReply();
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { service: worker, registry } = service({
      inspect: async () => {
        await held;
        return { state: 'cancellable' };
      },
    });
    await worker.scheduleAfterNoReply(verificationId);
    const row = await repo.findByVerification(verificationId, orgId);
    expect(row?.status).toBe('scheduled');

    const first = worker.execute(row!.id);
    const second = worker.execute(row!.id);
    await new Promise((done) => setTimeout(done, 200));
    release();
    await Promise.all([first, second]);

    expect(
      registry.dispatch.mock.calls.filter(
        ([command]) => command.action === 'automatic_no_reply_cancellation',
      ),
    ).toHaveLength(1);
    const [verification] = await client`
      SELECT status, cancellation_source FROM verifications WHERE id = ${verificationId}`;
    expect(verification).toEqual({
      status: 'canceled',
      cancellation_source: 'automatic_no_reply',
    });
    const events = await client`
      SELECT event FROM verification_auto_cancellation_events
      WHERE verification_id = ${verificationId} ORDER BY created_at, event`;
    expect(events.map(({ event }) => event as string)).toEqual(
      expect.arrayContaining(['scheduled', 'dispatch_started', 'succeeded']),
    );
  });

  it('leaves an order the customer confirmed first as confirmed', async () => {
    const verificationId = await seedNoReply();
    const result = await db.transaction((tx) =>
      repo.markVerificationCanceled(tx as never, verificationId, {
        status: 'applied',
      }),
    );
    expect(result).toBe(true);

    const confirmedId = await seedNoReply({
      verification: { status: 'confirmed', confirmedAt: ago(HOUR) },
    });
    const lost = await db.transaction((tx) =>
      repo.markVerificationCanceled(tx as never, confirmedId, {
        status: 'applied',
      }),
    );
    expect(lost).toBe(false);
    const [row] =
      await client`SELECT status FROM verifications WHERE id = ${confirmedId}`;
    expect(row.status).toBe('confirmed');
  });

  it('stops a scheduled cancellation on any message from the number, and flags one already sent', async () => {
    const phone = '+201000009999';
    const scheduledId = await seedNoReply({ phone });
    const committedId = await seedNoReply({ phone });
    const { service: worker } = service({
      dispatch: () =>
        Promise.resolve({
          status: 'pending_provider_operation',
          providerOperationId: 'job-1',
        }),
    });
    await worker.scheduleAfterNoReply(scheduledId);
    await worker.scheduleAfterNoReply(committedId);
    const committedRow = await repo.findByVerification(committedId, orgId);
    await worker.execute(committedRow!.id);
    expect((await repo.findById(committedRow!.id))?.status).toBe(
      'awaiting_platform',
    );

    const result = await repo.recordCustomerMessage({
      phoneE164: phone,
      verificationIds: [],
      receivedAt: new Date().toISOString(),
    });
    expect(new Set(result.matched)).toEqual(
      new Set([scheduledId, committedId]),
    );
    expect(result.committed).toEqual([committedId]);

    expect(await repo.findByVerification(scheduledId, orgId)).toMatchObject({
      status: 'stopped',
      reason: 'customer_reply',
    });
    expect(
      (await repo.findByVerification(committedId, orgId))?.lateReplyAt,
    ).not.toBeNull();
    expect(
      await verificationsRepo.findNeedsActionReason(scheduledId, orgId),
    ).toBe('customer_replied');
  });

  it('names a failed cancellation and a late reply for the merchant', async () => {
    const failedId = await seedNoReply();
    const { service: failing } = service({
      dispatch: () =>
        Promise.resolve({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
        }),
    });
    await failing.scheduleAfterNoReply(failedId);
    await failing.execute((await repo.findByVerification(failedId, orgId))!.id);
    expect(await verificationsRepo.findNeedsActionReason(failedId, orgId)).toBe(
      'auto_cancel_failed',
    );

    const canceledId = await seedNoReply({ phone: '+201000008888' });
    const { service: worker } = service({});
    await worker.scheduleAfterNoReply(canceledId);
    await worker.execute(
      (await repo.findByVerification(canceledId, orgId))!.id,
    );
    await repo.recordCustomerMessage({
      phoneE164: '+201000008888',
      verificationIds: [],
      receivedAt: new Date().toISOString(),
    });
    expect(
      await verificationsRepo.findNeedsActionReason(canceledId, orgId),
    ).toBe('late_reply_after_auto_cancel');
  });

  it('stops every pending cancellation of a store that switched it off', async () => {
    const verificationId = await seedNoReply();
    const { service: worker } = service({});
    await worker.scheduleAfterNoReply(verificationId);
    await repo.stopPendingForIntegration(
      orgId,
      integrationId,
      'feature_disabled',
      null,
    );
    expect(await repo.findByVerification(verificationId, orgId)).toMatchObject({
      status: 'stopped',
      reason: 'feature_disabled',
    });
  });
});
