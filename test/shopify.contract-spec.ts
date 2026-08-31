import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../src/infrastructure/database';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import { shopifyOrderFixture } from '../src/modules/webhook-queue/normalizers/fixtures/shopify-order.fixture';

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

  function setup() {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'synthetic-job' }) };
    const integrations = {
      findByPlatformDomain: jest.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        orgId: '00000000-0000-4000-8000-000000000002',
      }),
    };
    const producer = new WebhookQueueProducer(
      queue as never,
      repository,
      integrations as never,
    );
    const input = {
      platform: 'shopify' as const,
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: 'delivery-1',
      storeDomain: 'synthetic.myshopify.com',
      rawPayload: shopifyOrderFixture(),
    };
    return { producer, queue, input };
  }

  it('uses the actual platform/delivery unique constraint from the application schema and migration', async () => {
    const constraint = getTableConfig(
      schema.webhookEvents,
    ).uniqueConstraints.find(
      (entry) => entry.name === 'webhook_events_platform_idempotency_key',
    );
    expect(constraint?.columns.map((column) => column.name)).toEqual([
      'platform',
      'idempotency_key',
    ]);
    const rows = await client<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ${`${namespace}.webhook_events`}::regclass AND conname = 'webhook_events_platform_idempotency_key'`;
    expect(rows[0].definition).toBe('UNIQUE (platform, idempotency_key)');
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

  it('US-02-06: the real pending row survives failed enqueue, and redelivery does not recover it', async () => {
    const { producer, queue, input } = setup();
    queue.add.mockRejectedValueOnce(new Error('synthetic queue outage'));
    await expect(producer.ingest(input)).rejects.toThrow(
      'synthetic queue outage',
    );
    await expect(producer.ingest(input)).resolves.toEqual({
      enqueued: false,
      duplicate: true,
    });
    expect(await db.select().from(schema.webhookEvents)).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 0 }),
    ]);
    expect(queue.add).toHaveBeenCalledTimes(1);
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
