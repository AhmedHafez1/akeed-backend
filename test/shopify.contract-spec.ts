import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../src/infrastructure/database';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import { shopifyOrderFixture } from '../src/modules/webhook-queue/normalizers/fixtures/shopify-order.fixture';
import { ConfigService } from '@nestjs/config';

function testDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NOT RUN: invalid test database URL (value withheld).');
  }
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

const databaseUrl = testDatabaseUrl();
const namespace = `e01_${randomUUID().replaceAll('-', '')}`;
const client = postgres(databaseUrl, {
  max: 4,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const repository = new WebhookEventsRepository(db);
let createdSchema = false;

describe('Shopify isolated PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    createdSchema = true;
    await client.unsafe(
      `CREATE FUNCTION "${namespace}".uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()'`,
    );
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0007_crazy_violations.sql'),
      'utf8',
    );
    const statements = migration.split('--> statement-breakpoint').slice(0, 2);
    for (const statement of statements)
      await client.unsafe(statement.replaceAll('"public".', `"${namespace}".`));

    const recoveryMigration = readFileSync(
      resolve(__dirname, '../drizzle/0025_recoverable_webhook_dispatch.sql'),
      'utf8',
    );
    for (const statement of recoveryMigration.split(
      '--> statement-breakpoint',
    )) {
      await client.unsafe(statement.replaceAll('"public".', `"${namespace}".`));
    }
    // The current repository selects the additive E04 linkage column. This
    // Shopify-only fixture has no orders table and deliberately leaves it null.
    await client.unsafe(
      `ALTER TABLE "${namespace}"."webhook_events" ADD COLUMN "order_id" uuid`,
    );
  });

  afterAll(async () => {
    try {
      if (createdSchema) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client`DELETE FROM ${client(namespace)}.webhook_events`;
  });

  function setup(storeDomain = 'synthetic.myshopify.com') {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'synthetic-job' }) };
    const integrations = {
      findByPlatformDomain: jest.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        orgId: '00000000-0000-4000-8000-000000000002',
      }),
    };
    const dispatcher = new WebhookDispatchService(
      queue as never,
      repository,
      new ConfigService({ WEBHOOK_DISPATCH_MAX_ATTEMPTS: 3 }),
    );
    const producer = new WebhookQueueProducer(
      repository,
      integrations as never,
      dispatcher,
    );
    const input = {
      platform: 'shopify' as const,
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: 'delivery-1',
      storeDomain,
      rawPayload: shopifyOrderFixture(),
    };
    return { producer, queue, input };
  }

  it('uses the source-scoped delivery constraint from the application schema and migration', async () => {
    const constraint = getTableConfig(
      schema.webhookEvents,
    ).uniqueConstraints.find(
      (entry) => entry.name === 'webhook_events_source_idempotency_key',
    );
    expect(constraint?.columns.map((column) => column.name)).toEqual([
      'platform',
      'store_domain',
      'idempotency_key',
    ]);
    const rows = await client<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ${`${namespace}.webhook_events`}::regclass AND conname = 'webhook_events_source_idempotency_key'`;
    expect(rows[0].definition).toBe(
      'UNIQUE (platform, store_domain, idempotency_key)',
    );
  });

  it('rehearses the additive commerce platform constraints with existing Shopify rows', async () => {
    await client.unsafe(
      `CREATE TABLE "${namespace}"."integrations" ("platform_type" text NOT NULL, CONSTRAINT "integrations_platform_type_check" CHECK ("platform_type" = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text])))`,
    );
    await client.unsafe(
      `CREATE TABLE "${namespace}"."billing_free_plan_claims" ("platform_type" text NOT NULL, CONSTRAINT "billing_free_plan_claims_platform_type_check" CHECK ("platform_type" = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text])))`,
    );
    await client`INSERT INTO ${client(namespace)}.integrations (platform_type) VALUES ('shopify')`;
    await client`INSERT INTO ${client(namespace)}.billing_free_plan_claims (platform_type) VALUES ('shopify')`;

    const migration = readFileSync(
      resolve(
        __dirname,
        '../drizzle/0023_expand_commerce_platform_contracts.sql',
      ),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await client.unsafe(statement);
    }

    for (const platform of ['standalone', 'easyorders']) {
      await client`INSERT INTO ${client(namespace)}.integrations (platform_type) VALUES (${platform})`;
      await client`INSERT INTO ${client(namespace)}.billing_free_plan_claims (platform_type) VALUES (${platform})`;
    }
    await expect(
      client`INSERT INTO ${client(namespace)}.integrations (platform_type) VALUES ('magento')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client`INSERT INTO ${client(namespace)}.billing_free_plan_claims (platform_type) VALUES ('magento')`,
    ).rejects.toMatchObject({ code: '23514' });

    const retained = await client<
      { platform_type: string }[]
    >`SELECT platform_type FROM ${client(namespace)}.integrations ORDER BY platform_type`;
    expect(retained.map((row) => row.platform_type)).toEqual([
      'easyorders',
      'shopify',
      'standalone',
    ]);
  });

  it('concurrent identical producer deliveries insert one row and enqueue once', async () => {
    const { producer, queue, input } = setup();
    const results = await Promise.all([
      producer.ingest(input),
      producer.ingest(input),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { enqueued: true },
        { enqueued: false, duplicate: true },
      ]),
    );
    const rows = await db.select().from(schema.webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      idempotencyKey: 'delivery-1',
      rawPayload: input.rawPayload,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('different delivery IDs for the same order produce two events and two enqueues', async () => {
    const { producer, queue, input } = setup();
    await Promise.all([
      producer.ingest(input),
      producer.ingest({ ...input, idempotencyKey: 'delivery-2' }),
    ]);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('recovers a durable pending row after Redis becomes available', async () => {
    const { producer, queue, input } = setup();
    queue.add.mockRejectedValueOnce(new Error('synthetic queue outage'));
    await expect(producer.ingest(input)).resolves.toEqual({ enqueued: false });
    await client`UPDATE ${client(namespace)}.webhook_events SET next_dispatch_at = NOW() - INTERVAL '1 second'`;
    await expect(producer.ingest(input)).resolves.toEqual({
      enqueued: true,
      duplicate: true,
    });
    expect(await db.select().from(schema.webhookEvents)).toEqual([
      expect.objectContaining({
        status: 'pending',
        attempts: 0,
        dispatchAttempts: 2,
        lastDispatchError: null,
      }),
    ]);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('allows identical provider delivery IDs for different source stores', async () => {
    const first = setup('one.myshopify.com');
    const second = setup('two.myshopify.com');
    await expect(
      Promise.all([
        first.producer.ingest(first.input),
        second.producer.ingest(second.input),
      ]),
    ).resolves.toEqual([{ enqueued: true }, { enqueued: true }]);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(2);
  });

  it('atomically fences concurrent processing and keeps completion replay-safe', async () => {
    const { producer, queue, input } = setup();
    await producer.ingest(input);
    const [persisted] = await db.select().from(schema.webhookEvents);

    const claims = await Promise.all([
      repository.claimForProcessing(
        persisted.id,
        new Date(Date.now() + 60_000).toISOString(),
      ),
      repository.claimForProcessing(
        persisted.id,
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ]);
    expect(claims).toEqual(expect.arrayContaining(['claimed', 'busy']));

    await repository.markCompleted(persisted.id);
    await expect(
      repository.claimForProcessing(
        persisted.id,
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).resolves.toBe('terminal');
    queue.add.mockClear();
    const dispatcher = new WebhookDispatchService(
      queue as never,
      repository,
      new ConfigService(),
    );
    await expect(dispatcher.dispatchById(persisted.id)).resolves.toBe(
      'not_claimed',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reclaims an expired processing lease with a new dispatch generation', async () => {
    const { producer, queue, input } = setup();
    await producer.ingest(input);
    const [persisted] = await db.select().from(schema.webhookEvents);
    await repository.claimForProcessing(
      persisted.id,
      new Date(Date.now() - 1_000).toISOString(),
    );
    queue.add.mockClear();
    const dispatcher = new WebhookDispatchService(
      queue as never,
      repository,
      new ConfigService(),
    );

    await expect(dispatcher.dispatchById(persisted.id)).resolves.toBe(
      'dispatched',
    );
    // The job id ends in the claim's lease timestamp so a redispatch after
    // `resetForRedispatch` never collides with a retained completed job.
    expect(queue.add).toHaveBeenCalledWith(
      WebhookJobType.ORDER_CREATE,
      expect.objectContaining({ webhookEventId: persisted.id }),
      expect.objectContaining({
        jobId: expect.stringMatching(
          new RegExp(`^webhook-event-${persisted.id}-dispatch-2-\\d+$`),
        ) as unknown,
      }),
    );
    await expect(repository.findById(persisted.id)).resolves.toMatchObject({
      status: 'pending',
      dispatchAttempts: 2,
      processingLeaseUntil: null,
    });
  });

  it('actual persistence rejects an absent store domain', async () => {
    await expect(
      repository.insertIfNew({
        platform: 'shopify',
        jobType: WebhookJobType.ORDER_CREATE,
        idempotencyKey: 'missing-domain',
        storeDomain: undefined as unknown as string,
        rawPayload: {},
      }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });
});
