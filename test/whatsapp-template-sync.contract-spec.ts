import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { WhatsappTemplateSyncRepository } from '../src/infrastructure/database/repositories/whatsapp-template-sync.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { MetaTemplateCatalogAdapter } from '../src/infrastructure/spokes/meta/meta-template-catalog.adapter';
import { MetaTemplateWebhookHandler } from '../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { templateHealthSql } from '../src/modules/admin/admin-template-health.sql';
import { TemplateAlertService } from '../src/modules/template-registry/template-alert.service';
import { TemplateStatusService } from '../src/modules/template-registry/template-status.service';
import { WhatsappTemplateSyncService } from '../src/modules/template-registry/whatsapp-template-sync.service';
import { parseWhatsappTemplateConfig } from '../src/shared/config/whatsapp-template.config';
import { selectTemplateForSend } from '../src/shared/messaging/template-selector';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
} from './contracts/meta-template-api-fake';

/**
 * US-08-04 against real PostgreSQL: migrations 0056 and 0057, the sync and event
 * repository, and the template health SQL the admin store list embeds.
 *
 * Meta is the in-process fake from `contracts/meta-template-api-fake.ts`; no
 * request leaves the process.
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

const namespace = `e08_template_sync_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 4,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const syncRepository = new WhatsappTemplateSyncRepository(database);
const registryRepository = new WhatsappTemplatesRepository(database);
let created = false;

const MIGRATIONS = [
  '0054_whatsapp_templates_registry.sql',
  '0055_integration_template_keys.sql',
  '0056_dispatch_template_fallback.sql',
  '0057_whatsapp_template_sync.sql',
];
const SYNC_MIGRATION = '0057_whatsapp_template_sync.sql';

async function migrate(name: string): Promise<void> {
  await client.begin(async (tx) => {
    for (const statement of readFileSync(
      resolve(__dirname, '../drizzle', name),
      'utf8',
    ).split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.unsafe(statement);
    }
  });
}

/** The rollback written in the 0057 header, as one script. */
function rollbackStatements(): string {
  const header = readFileSync(
    resolve(__dirname, '../drizzle', SYNC_MIGRATION),
    'utf8',
  );
  const start = header.indexOf('--   DROP TABLE');
  const end = header.indexOf('-- The synced values');
  return header
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^--\s{3}/, '').replace(/^--\s+/, ' '))
    .join('\n');
}

const config = parseWhatsappTemplateConfig({
  WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
  WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
});
const configValues: Record<string, unknown> = {
  WA_ACCESS_TOKEN: FAKE_TOKEN,
  whatsappTemplates: config,
};
const configService = { get: (key: string) => configValues[key] };
const api = new FakeMetaTemplateApi();
const registry = {
  listTemplates: () => registryRepository.findAll(),
  invalidate: () => undefined,
};
const alerts = new TemplateAlertService(syncRepository);
const syncService = new WhatsappTemplateSyncService(
  syncRepository,
  new MetaTemplateCatalogAdapter(
    api.httpService as never,
    configService as never,
  ),
  registry,
  alerts,
  configService as never,
);
const producer = { requestSyncSoon: jest.fn().mockResolvedValue(undefined) };
const statusService = new TemplateStatusService(
  syncRepository,
  registry,
  alerts,
  producer as never,
);
const webhook = new MetaTemplateWebhookHandler(
  configService as never,
  statusService,
);

function delivery(
  field: string,
  time: number,
  value: Record<string, unknown>,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: FAKE_ACCOUNT_ID,
          time,
          changes: [
            {
              field,
              value: {
                message_template_id: 900000000000001,
                message_template_name: 'akeed_cod_verification_friendly',
                message_template_language: 'ar',
                ...value,
              },
            },
          ],
        },
      ],
    }),
  );
}

async function row(key: string) {
  const [found] = await client<
    {
      review_status: string | null;
      category: string | null;
      quality: string | null;
      status_event_at: string | null;
      last_synced_at: string | null;
      components_drift_at: string | null;
      meta_template_id: string | null;
    }[]
  >`
    SELECT review_status, category, quality, status_event_at, last_synced_at,
      components_drift_at, meta_template_id
    FROM whatsapp_templates WHERE "key" = ${key}`;
  return found;
}

async function insertStore(store: {
  arKey?: string | null;
  enKey?: string | null;
  language?: string;
}): Promise<string> {
  const [inserted] = await client<{ id: string }[]>`
    INSERT INTO integrations (cod_template_ar_key, cod_template_en_key, default_language)
    VALUES (${store.arKey ?? null}, ${store.enKey ?? null}, ${store.language ?? 'auto'})
    RETURNING id`;
  return inserted.id;
}

async function storeHealth(
  id: string,
): Promise<{ unavailable: boolean; degraded: boolean }> {
  const health = templateHealthSql(sql`i`);
  const [result] = await database.execute<{
    unavailable: boolean;
    degraded: boolean;
  }>(
    sql`SELECT ${health.unavailable} AS unavailable, ${health.degraded} AS degraded FROM integrations i WHERE i.id = ${id}`,
  );
  return result;
}

async function setStatus(
  key: string,
  status: string | null,
  category = 'utility',
) {
  await client`
    UPDATE whatsapp_templates
    SET review_status = ${status}, category = ${status === null ? null : category},
      last_synced_at = ${status === null ? null : new Date().toISOString()}
    WHERE "key" = ${key}`;
}

describe('WhatsApp template sync against PostgreSQL', () => {
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        is_active boolean DEFAULT true,
        default_language text DEFAULT 'auto',
        cod_template_ar_variant text DEFAULT 'standard' NOT NULL,
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL
      );
      CREATE TABLE verification_message_dispatches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);
    for (const name of MIGRATIONS) await migrate(name);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('0056 and 0057', () => {
    it('adds the event, run and dispatch columns and tables, service-role only', async () => {
      const columns = await client<
        { table_name: string; column_name: string }[]
      >`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = ${namespace}
          AND (
            (table_name = 'whatsapp_templates' AND column_name IN ('pending_category', 'status_event_at', 'quality_event_at', 'category_event_at', 'components_drift_at'))
            OR (table_name = 'verification_message_dispatches' AND column_name IN ('template_fallback_reason', 'template_skipped_key'))
          )`;
      expect(columns).toHaveLength(7);
      const secured = await client<
        { relname: string; relrowsecurity: boolean }[]
      >`
        SELECT c.relname, c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${namespace}
          AND c.relname IN ('whatsapp_template_events', 'whatsapp_template_sync_runs')
        ORDER BY c.relname`;
      expect(secured).toEqual([
        { relname: 'whatsapp_template_events', relrowsecurity: true },
        { relname: 'whatsapp_template_sync_runs', relrowsecurity: true },
      ]);
    });

    it('replays as a no-op and writes no provider data', async () => {
      await migrate(SYNC_MIGRATION);

      const [filled] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM whatsapp_templates
        WHERE review_status IS NOT NULL OR status_event_at IS NOT NULL
          OR last_synced_at IS NOT NULL`;
      expect(filled.count).toBe(0);
    });

    it('lets only one run be running at a time', async () => {
      const first = await syncRepository.startRun('scheduled', null);
      const second = await syncRepository.startRun('manual', null);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      await syncRepository.failRun(first!.id, 'test');
    });

    it('closes a run left running past the abandon limit', async () => {
      await client`
        INSERT INTO whatsapp_template_sync_runs (trigger, status, started_at)
        VALUES ('scheduled', 'running', now() - interval '1 hour')`;

      const run = await syncRepository.startRun('scheduled', null);

      expect(run).not.toBeNull();
      const [abandoned] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM whatsapp_template_sync_runs
        WHERE error_code = 'abandoned'`;
      expect(abandoned.count).toBe(1);
      await syncRepository.failRun(run!.id, 'test');
    });
  });

  describe('sync', () => {
    it('fills the provider columns, and the send path reads them', async () => {
      const result = await syncService.runSync('scheduled');

      expect(result).toMatchObject({
        outcome: 'succeeded',
        run: { updatedCount: 8, missingKeys: [], unknownAtProvider: [] },
      });
      expect(await row('cod_confirm.ar.egyptian')).toMatchObject({
        review_status: 'approved',
        category: 'utility',
        quality: 'high',
        meta_template_id: '900000000000002',
        last_synced_at: expect.any(String) as string,
        status_event_at: expect.any(String) as string,
      });
      const templates = await registryRepository.findAll();
      expect(templates.every((t) => t.reviewStatus === 'approved')).toBe(true);
      expect(
        selectTemplateForSend(templates, {
          preferredLanguage: 'ar',
          phoneNumber: '+201001112223',
          arKey: 'cod_confirm.ar.egyptian',
          guardrail: { enabled: true },
        }).template?.variantKey,
      ).toBe('ar.egyptian');
    });

    it('is idempotent', async () => {
      await client`UPDATE whatsapp_template_sync_runs SET finished_at = now() - interval '1 hour'`;

      const result = await syncService.runSync('scheduled');

      expect(result).toMatchObject({
        run: { updatedCount: 0, unchangedCount: 8 },
      });
    });

    it('changes no row during a Meta outage, and records the failure', async () => {
      const before =
        await client`SELECT * FROM whatsapp_templates ORDER BY "key"`;
      api.failOnPage(api.requests.length + 1, {
        kind: 'server_error',
        httpStatus: 503,
      });

      const result = await syncService.runSync('scheduled');

      expect(result).toMatchObject({
        outcome: 'failed',
        run: { status: 'failed', errorCode: 'provider_error' },
      });
      const after =
        await client`SELECT * FROM whatsapp_templates ORDER BY "key"`;
      expect(after).toEqual(before);
      api.clearFailures();
    });
  });

  describe('template webhooks', () => {
    const later = Math.floor(Date.now() / 1000) + 3600;

    it('applies a newer event, drops a duplicate, and ignores an older one', async () => {
      const paused = delivery('message_template_status_update', later, {
        event: 'PAUSED',
      });

      await webhook.handle(paused);
      await webhook.handle(paused);
      await webhook.handle(
        delivery('message_template_status_update', later - 60, {
          event: 'APPROVED',
        }),
      );

      expect((await row('cod_confirm.ar.standard')).review_status).toBe(
        'paused',
      );
      const events = await client<{ outcome: string }[]>`
        SELECT outcome FROM whatsapp_template_events ORDER BY received_at`;
      expect(events.map((event) => event.outcome)).toEqual([
        'applied',
        'stale',
      ]);
    });

    it('does not let an event older than the last sync overwrite it', async () => {
      await webhook.handle(
        delivery('message_template_status_update', 1767268800, {
          event: 'REJECTED',
        }),
      );

      expect((await row('cod_confirm.ar.standard')).review_status).toBe(
        'paused',
      );
    });

    it('reports a template with no registry row and creates none', async () => {
      await webhook.handle(
        delivery('message_template_quality_update', later, {
          message_template_name: 'not_in_akeed',
          new_quality_score: 'RED',
        }),
      );

      const [counts] = await client<
        { templates: number; unregistered: number }[]
      >`
        SELECT (SELECT count(*)::int FROM whatsapp_templates) AS templates,
          (SELECT count(*)::int FROM whatsapp_template_events WHERE outcome = 'unregistered') AS unregistered`;
      expect(counts).toEqual({ templates: 8, unregistered: 1 });
    });
  });

  describe('health SQL', () => {
    beforeAll(async () => {
      await client`UPDATE whatsapp_templates SET review_status = 'approved', category = 'utility', pending_category = NULL`;
    });

    afterEach(async () => {
      await client`UPDATE whatsapp_templates SET review_status = 'approved', category = 'utility', pending_category = NULL`;
    });

    it('is healthy while every template it sends is approved', async () => {
      const store = await insertStore({ arKey: 'cod_confirm.ar.egyptian' });

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: false,
        degraded: false,
      });
    });

    it('is degraded when its selection is paused and the default stands in', async () => {
      const store = await insertStore({ arKey: 'cod_confirm.ar.egyptian' });
      await setStatus('cod_confirm.ar.egyptian', 'paused');

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: false,
        degraded: true,
      });
    });

    it('is unavailable when the selection and the default are both down', async () => {
      const store = await insertStore({ arKey: 'cod_confirm.ar.egyptian' });
      await setStatus('cod_confirm.ar.egyptian', 'paused');
      await setStatus('cod_confirm.ar.standard', 'missing');

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: true,
        degraded: false,
      });
    });

    it('ignores the language a store never sends in', async () => {
      const store = await insertStore({ language: 'en' });
      await setStatus('cod_confirm.ar.standard', 'disabled');

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: false,
        degraded: false,
      });
    });

    it('reads a store with no key from its old variant column', async () => {
      const store = await insertStore({});
      await client`UPDATE integrations SET cod_template_en_variant = 'direct' WHERE id = ${store}`;
      await setStatus('cod_confirm.en.direct', 'rejected');

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: false,
        degraded: true,
      });
    });

    it('is degraded, not unavailable, when the template it sends was re-categorized', async () => {
      const store = await insertStore({});
      await setStatus('cod_confirm.ar.standard', 'approved', 'marketing');

      await expect(storeHealth(store)).resolves.toEqual({
        unavailable: false,
        degraded: true,
      });
    });

    it('counts active stores per key for the alert', async () => {
      const counts = await syncRepository.activeStoreCountsByKey([
        'cod_confirm.ar.egyptian',
        'cod_confirm.en.direct',
      ]);

      expect(counts.get('cod_confirm.ar.egyptian')).toBeGreaterThanOrEqual(3);
      expect(counts.get('cod_confirm.en.direct')).toBe(1);
    });
  });

  describe('rollback', () => {
    it('runs the statements in the 0057 header and reapplies cleanly', async () => {
      await client.unsafe(rollbackStatements());

      const [gone] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = ${namespace}
          AND table_name IN ('whatsapp_template_events', 'whatsapp_template_sync_runs')`;
      expect(gone.count).toBe(0);
      expect(await registryRepository.findAll()).toHaveLength(8);

      await migrate(SYNC_MIGRATION);

      expect(await syncRepository.recentRuns(5)).toEqual([]);
    });
  });
});
