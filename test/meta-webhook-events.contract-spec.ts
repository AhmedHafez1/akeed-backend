import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { MetaWebhookEventsRepository } from '../src/infrastructure/database/repositories/meta-webhook-events.repository';
import { MetaTemplateWebhookHandler } from '../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { MetaWebhookEventsService } from '../src/infrastructure/spokes/meta/meta-webhook-events.service';
import { META_WEBHOOK_MAX_ATTEMPTS } from '../src/infrastructure/spokes/meta/meta-webhook-queue.constants';
import { parseWhatsappTemplateConfig } from '../src/shared/config/whatsapp-template.config';
import type { TemplateProviderEvent } from '../src/shared/messaging/template-provider.types';

/**
 * Stored Meta webhook events against real PostgreSQL: migration 0082, the
 * repository, and the service that runs them. The queue is a recording fake:
 * no Redis, and no request leaves the process.
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
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username !== 'e01_test'
  ) {
    throw new Error('NOT RUN: this suite needs the disposable test database.');
  }
  return value;
}

const ACCOUNT_ID = '100000000000001';
const LARGE_TEMPLATE_ID = '1234567890123456789';

// Rows are backdated in SQL by a minute: the repository compares against the
// app's clock, and the database container's can run slightly ahead of it.
const databaseUrl = isolatedDatabaseUrl();
const namespace = `e09_meta_webhooks_${randomUUID().replaceAll('-', '')}`;

function messageChange(wamid: string) {
  return { field: 'messages', value: { messages: [{ id: wamid }] } };
}

function templateBody(time: number): Buffer {
  return Buffer.from(
    `{"object":"whatsapp_business_account","entry":[{"id":"${ACCOUNT_ID}","time":${time},"changes":[{"field":"message_template_status_update","value":{"event":"PAUSED","message_template_id":${LARGE_TEMPLATE_ID},"message_template_name":"cod_confirm","message_template_language":"ar"}}]}]}`,
  );
}

describe('Meta webhook events contract', () => {
  const client = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
    connection: { search_path: `${namespace},public` },
  });
  const repository = new MetaWebhookEventsRepository(
    drizzle(client, { schema }) as never,
  );
  const templates = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: ACCOUNT_ID,
  });
  const queue = { addBulk: jest.fn() };
  const messages = { processIncomingOrThrow: jest.fn() };
  const templateStatus = { applyEvents: jest.fn() };
  const service = new MetaWebhookEventsService(
    queue as never,
    repository,
    messages as never,
    new MetaTemplateWebhookHandler(
      { get: () => templates } as never,
      templateStatus as never,
    ),
  );
  let created = false;

  const rows = () =>
    client<
      {
        id: string;
        status: string;
        attempts: number;
        payload: string | null;
        dedupe_hash: string;
        field: string | null;
        last_error: string | null;
      }[]
    >`SELECT * FROM meta_webhook_events ORDER BY received_at, id`;
  const post = (value: unknown) =>
    service.accept(Buffer.from(JSON.stringify(value)));
  const queuedIds = () =>
    (
      queue.addBulk.mock.calls as [
        { data: { eventId: string }; opts: { jobId: string } }[],
      ][]
    ).flatMap(([jobs]) => jobs.map((job) => job.data.eventId));

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0082_meta_webhook_events.sql'),
      'utf8',
    );
    // Twice, to prove the migration re-runs.
    for (let run = 0; run < 2; run += 1) {
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client`DELETE FROM meta_webhook_events`;
    queue.addBulk.mockReset().mockResolvedValue([]);
    messages.processIncomingOrThrow.mockReset().mockResolvedValue(undefined);
    templateStatus.applyEvents.mockReset().mockResolvedValue({});
  });

  it('is locked to the API: RLS on, no policy, nothing granted', async () => {
    const [table] = await client<{ relrowsecurity: boolean }[]>`
      SELECT c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${namespace} AND c.relname = 'meta_webhook_events'`;
    expect(table.relrowsecurity).toBe(true);

    const policies = await client`
      SELECT 1 FROM pg_policies
      WHERE schemaname = ${namespace} AND tablename = 'meta_webhook_events'`;
    expect(policies).toHaveLength(0);

    const [grants] = await client<{ allowed: boolean }[]>`
      SELECT has_table_privilege('authenticated', ${`${namespace}.meta_webhook_events`}, 'SELECT')
          OR has_table_privilege('anon', ${`${namespace}.meta_webhook_events`}, 'SELECT') AS allowed`;
    expect(grants.allowed).toBe(false);
  });

  it('stores a POST of several entries and changes as one row each', async () => {
    await post({
      entry: [
        { id: 'waba', changes: [messageChange('a'), messageChange('b')] },
        { id: 'waba', changes: [messageChange('c')] },
      ],
    });

    await expect(rows()).resolves.toHaveLength(3);
    expect(queuedIds()).toHaveLength(3);
  });

  it('stores a POST whole or not at all', async () => {
    const event = {
      field: null,
      wabaId: null,
      phoneNumberId: null,
      payload: 'x',
    };

    // The second row breaks a constraint, in the same statement as a good one.
    await expect(
      repository.insertMany(
        [
          { ...event, dedupeHash: 'good' },
          { ...event, dedupeHash: null as never },
        ],
        new Date().toISOString(),
      ),
    ).rejects.toThrow();

    await expect(rows()).resolves.toHaveLength(0);
  });

  it('processes a duplicate delivery once and keeps recognising it after success', async () => {
    const body = { entry: [{ id: 'waba', changes: [messageChange('a')] }] };
    await post(body);
    await post(body);
    await expect(rows()).resolves.toHaveLength(1);
    expect(queuedIds()).toHaveLength(1);

    const [{ id, dedupe_hash }] = await rows();
    await service.process(id);
    await post(body);

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      status: 'succeeded',
      payload: null,
      dedupe_hash,
    });
    expect(messages.processIncomingOrThrow).toHaveBeenCalledTimes(1);
  });

  it('runs a POST whose changes fail apart: only the failed one retries', async () => {
    await post({
      entry: [
        {
          id: 'waba',
          changes: [messageChange('a'), messageChange('b'), messageChange('c')],
        },
      ],
    });
    const ids = (await rows()).map((row) => row.id);
    messages.processIncomingOrThrow.mockImplementation(
      (dto: {
        entry: { changes: { value: { messages: { id: string }[] } }[] }[];
      }) =>
        dto.entry[0].changes[0].value.messages[0].id === 'b'
          ? Promise.reject(new Error('handler failed'))
          : Promise.resolve(),
    );

    const results = await Promise.allSettled(
      ids.map((id) => service.process(id)),
    );

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await rows();
    expect(after.map((row) => row.status).sort()).toEqual([
      'pending',
      'succeeded',
      'succeeded',
    ]);
    const failed = after.find((row) => row.status === 'pending');
    expect(failed).toMatchObject({
      attempts: 1,
      last_error: 'handler failed',
    });
    expect(failed?.payload).toEqual(expect.any(String));

    messages.processIncomingOrThrow.mockReset().mockResolvedValue(undefined);
    await service.process(failed!.id);

    expect(messages.processIncomingOrThrow).toHaveBeenCalledWith(
      expect.anything(),
      { isRetry: true },
    );
    await expect(rows()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failed!.id, status: 'succeeded' }),
      ]),
    );
  });

  it('keeps a template id over 2^53 exact through storage and replay', async () => {
    await service.accept(templateBody(1767268800));
    const [row] = await rows();
    expect(row.payload).toContain(LARGE_TEMPLATE_ID);

    await service.process(row.id);

    const [[events]] = templateStatus.applyEvents.mock.calls as [
      [TemplateProviderEvent[]],
    ];
    expect(events[0].providerTemplateId).toBe(LARGE_TEMPLATE_ID);
  });

  it('gives a template event the identity the inline path gives it', async () => {
    const raw = templateBody(1767268800);
    const handler = new MetaTemplateWebhookHandler(
      { get: () => templates } as never,
      templateStatus as never,
    );
    const [inline] = handler.extract(raw);

    await service.accept(raw);
    const [row] = await rows();

    expect(row.dedupe_hash).toBe(inline.identityKey);
  });

  it('stores an unsplittable body and leaves it failed and visible', async () => {
    await post({ object: 'whatsapp_business_account' });
    const [row] = await rows();
    expect(row.field).toBeNull();

    await expect(service.process(row.id)).rejects.toThrow('unsplittable_body');

    await expect(rows()).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        last_error: 'unsplittable_body',
        payload: expect.any(String) as string,
      }),
    ]);
    expect(messages.processIncomingOrThrow).not.toHaveBeenCalled();
  });

  describe('claims', () => {
    async function storedEvent(): Promise<string> {
      await post({ entry: [{ id: 'w', changes: [messageChange('a')] }] });
      return (await rows())[0].id;
    }

    it('lets only one of two runs have an event', async () => {
      const id = await storedEvent();

      const claims = await Promise.all([
        repository.claim(id, 60_000, META_WEBHOOK_MAX_ATTEMPTS),
        repository.claim(id, 60_000, META_WEBHOOK_MAX_ATTEMPTS),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it('recovers an event from a worker that crashed mid-run', async () => {
      const id = await storedEvent();
      await repository.claim(id, 60_000, META_WEBHOOK_MAX_ATTEMPTS);
      await expect(
        repository.claim(id, 60_000, META_WEBHOOK_MAX_ATTEMPTS),
      ).resolves.toBeUndefined();

      await client`
        UPDATE meta_webhook_events SET lease_until = now() - interval '1 minute'`;
      await service.sweep();

      expect(queuedIds()).toEqual([id, id]);
      const [row] = await rows();
      expect(row.status).toBe('pending');

      await service.process(id);

      expect(messages.processIncomingOrThrow).toHaveBeenCalledWith(
        expect.anything(),
        { isRetry: true },
      );
      await expect(rows()).resolves.toEqual([
        expect.objectContaining({ status: 'succeeded', attempts: 2 }),
      ]);
    });

    it('stops a stalled worker overwriting a newer run', async () => {
      const id = await storedEvent();
      const first = await repository.claim(id, 60_000, 10);
      await client`
        UPDATE meta_webhook_events SET lease_until = now() - interval '1 minute'`;
      await repository.claim(id, 60_000, 10);

      await repository.markSucceeded(id, first!.attempts);

      const [row] = await rows();
      expect(row).toMatchObject({ status: 'processing', attempts: 2 });
      expect(row.payload).not.toBeNull();
    });

    it('fails an event that crashed on its last attempt', async () => {
      const id = await storedEvent();
      await client`
        UPDATE meta_webhook_events
        SET status = 'processing',
            attempts = ${META_WEBHOOK_MAX_ATTEMPTS},
            lease_until = now() - interval '1 minute'`;

      await expect(service.sweep()).resolves.toMatchObject({ failed: 1 });

      await expect(rows()).resolves.toEqual([
        expect.objectContaining({
          id,
          status: 'failed',
          last_error: 'attempts_exhausted',
        }),
      ]);
    });
  });

  describe('the sweep', () => {
    it('recovers a row Redis never took, once it is due', async () => {
      queue.addBulk.mockRejectedValueOnce(new Error('redis down'));
      await post({ entry: [{ id: 'w', changes: [messageChange('a')] }] });
      await new Promise(setImmediate);
      const [{ id }] = await rows();

      await expect(service.sweep()).resolves.toEqual({ failed: 0, queued: 0 });

      await client`UPDATE meta_webhook_events SET next_attempt_at = now() - interval '1 minute'`;
      await expect(service.sweep()).resolves.toEqual({ failed: 0, queued: 1 });
      expect(queuedIds().at(-1)).toBe(id);
    });

    it('leaves a row alone after queueing it', async () => {
      await post({ entry: [{ id: 'w', changes: [messageChange('a')] }] });
      await client`UPDATE meta_webhook_events SET next_attempt_at = now() - interval '1 minute'`;

      await service.sweep();
      await expect(service.sweep()).resolves.toMatchObject({ queued: 0 });
    });

    it('gives each row to one of two sweeps', async () => {
      await post({
        entry: [{ id: 'w', changes: [messageChange('a'), messageChange('b')] }],
      });
      await client`UPDATE meta_webhook_events SET next_attempt_at = now() - interval '1 minute'`;

      const [first, second] = await Promise.all([
        repository.claimDue(10, 60_000),
        repository.claimDue(10, 60_000),
      ]);

      expect(first.length + second.length).toBe(2);
      expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(2);
    });

    it('leaves a failed or finished row alone', async () => {
      await post({ object: 'x' });
      const [{ id }] = await rows();
      await service.process(id).catch(() => undefined);

      await expect(service.sweep()).resolves.toEqual({ failed: 0, queued: 0 });
    });
  });

  it('replays a failed event with the documented SQL, as a retry', async () => {
    await post({ entry: [{ id: 'w', changes: [messageChange('a')] }] });
    const [{ id }] = await rows();
    await client`
      UPDATE meta_webhook_events
      SET status = 'failed', attempts = ${META_WEBHOOK_MAX_ATTEMPTS}, failed_at = now()`;

    await client`
      UPDATE meta_webhook_events
      SET status = 'pending', attempts = 1, next_attempt_at = now() - interval '1 minute',
          failed_at = NULL, last_error = NULL
      WHERE id = ${id} AND payload IS NOT NULL`;
    await expect(service.sweep()).resolves.toMatchObject({ queued: 1 });
    await service.process(id);

    expect(messages.processIncomingOrThrow).toHaveBeenCalledWith(
      expect.anything(),
      { isRetry: true },
    );
    await expect(rows()).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded', payload: null }),
    ]);
  });

  describe('retention', () => {
    async function insert(
      status: string,
      ages: { failedDays?: number; receivedDays?: number },
      hash = randomUUID(),
    ) {
      const failedAt =
        ages.failedDays === undefined
          ? null
          : new Date(Date.now() - ages.failedDays * 86_400_000).toISOString();
      const receivedAt = new Date(
        Date.now() - (ages.receivedDays ?? 0) * 86_400_000,
      ).toISOString();
      const [row] = await client<{ id: string }[]>`
        INSERT INTO meta_webhook_events (dedupe_hash, payload, status, failed_at, received_at)
        VALUES (${hash}, 'payload', ${status}, ${failedAt}, ${receivedAt})
        RETURNING id`;
      return row.id;
    }

    it('keeps a failed payload for 14 days, then clears it', async () => {
      const young = await insert('failed', { failedDays: 13 });
      const old = await insert('failed', { failedDays: 15 });

      await service.purge();

      const after = await rows();
      expect(after.find((row) => row.id === young)?.payload).toBe('payload');
      expect(after.find((row) => row.id === old)?.payload).toBeNull();
    });

    it('deletes finished rows after 30 days', async () => {
      const young = await insert('succeeded', { receivedDays: 29 });
      await insert('succeeded', { receivedDays: 31 });
      await insert('failed', { receivedDays: 31, failedDays: 31 });

      await service.purge();

      await expect(rows()).resolves.toEqual([
        expect.objectContaining({ id: young }),
      ]);
    });

    it('does not delete work the sweep still owns', async () => {
      await insert('pending', { receivedDays: 31 });
      await insert('processing', { receivedDays: 31 });

      await service.purge();

      await expect(rows()).resolves.toHaveLength(2);
    });
  });
});
