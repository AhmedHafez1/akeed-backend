import { Logger, type LoggerService } from '@nestjs/common';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import {
  ORDER_IMPORT_ROW_CHUNK,
  OrderImportDraftLimitError,
  OrderImportShortCodeError,
  OrderImportsRepository,
  type NewDraftBatch,
  type CommitRowLink,
  type NewImportRow,
} from '../src/infrastructure/database/repositories/order-imports.repository';
import { ManualOrderIngestionRepository } from '../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import { OrderImportReleaseRepository } from '../src/infrastructure/database/repositories/order-import-release.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import { OrderImportExpireService } from '../src/modules/order-imports/release/order-import-expire.service';
import { OrderImportPurgeService } from '../src/modules/order-imports/release/order-import-purge.service';
import { OrderImportReleaseService } from '../src/modules/order-imports/release/order-import-release.service';
import { OrderImportCommitProcessor } from '../src/modules/order-imports/order-import-commit.processor';
import { OrderImportCommitService } from '../src/modules/order-imports/order-import-commit.service';
import { OrderImportDetailService } from '../src/modules/order-imports/order-import-detail.service';
import { OrderImportMappingService } from '../src/modules/order-imports/order-import-mapping.service';
import { OrderImportsService } from '../src/modules/order-imports/order-imports.service';
import { ImportFileParser } from '../src/modules/order-imports/parsers/import-file-parser';
import { OrderImportReleaseTickService } from '../src/modules/order-imports/release/order-import-release-tick.service';
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneOrderIngestionService } from '../src/modules/order-ingestion/standalone-order-ingestion.service';
import { FileImportChannelAdapter } from '../src/modules/order-imports/file-import.channel-adapter';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
} from '../src/shared/config/bulk-import.config';
import { PhoneService } from '../src/shared/services/phone.service';
import { generateShortCode } from '../src/modules/order-imports/short-code';
import { dateInTimezone } from '../src/modules/order-imports/validation/date';
import {
  isIncludable,
  outcomeOf,
  type RowIssue,
} from '../src/modules/order-imports/validation/issue-codes';
import { RowValidationService } from '../src/modules/order-imports/validation/row-validation.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';

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

const namespace = `e046_order_imports_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new OrderImportsRepository(database);
let created = false;

const HOUR = 3_600_000;
const NOW = new Date();

async function createSource(): Promise<{
  orgId: string;
  integrationId: string;
}> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES ('Org', ${`org-${randomUUID()}`})
    RETURNING id`;
  const [integration] = await client<{ id: string }[]>`
    INSERT INTO integrations (org_id, platform_type, platform_store_url)
    VALUES (${organization.id}, 'standalone', ${`standalone:${organization.id}`})
    RETURNING id`;
  return { orgId: organization.id, integrationId: integration.id };
}

function batch(
  source: { orgId: string; integrationId: string },
  overrides: Partial<NewDraftBatch> = {},
): NewDraftBatch {
  return {
    orgId: source.orgId,
    integrationId: source.integrationId,
    createdBy: randomUUID(),
    fileName: 'طلبات.xlsx',
    fileSha256: 'a'.repeat(64),
    fileSize: 1_024,
    fileFormat: 'xlsx',
    encoding: null,
    delimiter: null,
    sheetName: 'Orders',
    headers: ['order_id', 'الاسم'],
    expiresAt: new Date(NOW.getTime() + 24 * HOUR),
    mapping: null,
    options: null,
    mappingProfileId: null,
    ...overrides,
  };
}

function rows(count: number): NewImportRow[] {
  return Array.from({ length: count }, (_, index) => ({
    rowNumber: index + 2,
    raw: { order_id: `A-${index}`, الاسم: `عميل ${index}` },
    issues: index === 0 ? [{ code: 'FIELD_TOO_LONG', field: 'الاسم' }] : [],
  }));
}

const options = {
  maxOpenDrafts: 3,
  duplicateSince: new Date(NOW.getTime() - 24 * HOUR),
  now: NOW,
  generateShortCode: () => generateShortCode(),
};

async function batchCount(orgId: string): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM order_import_batches WHERE org_id = ${orgId}`;
  return row.count;
}

describe('order imports PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE FUNCTION get_user_org_id() RETURNS uuid LANGUAGE sql STABLE
        AS $fn$ SELECT nullif(current_setting('akeed.test_org', true), '')::uuid $fn$;
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE
      );
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        timezone text NOT NULL DEFAULT 'Asia/Riyadh',
        UNIQUE (platform_type, platform_store_url),
        UNIQUE (id, org_id)
      );
      -- The orders columns the L1/L3 lookups read, with the real unique key.
      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        integration_id uuid NOT NULL,
        external_order_id text NOT NULL,
        order_number text,
        customer_phone text NOT NULL,
        total_price numeric(12, 2),
        created_at timestamptz DEFAULT now(),
        CONSTRAINT unique_external_order_per_integration UNIQUE (integration_id, external_order_id)
      );
      -- The rest of the columns a commit writes (US-04.6-06).
      ALTER TABLE orders
        ADD COLUMN customer_name text,
        ADD COLUMN customer_email text,
        ADD COLUMN currency text DEFAULT 'SAR',
        ADD COLUMN payment_method text,
        ADD COLUMN raw_payload jsonb,
        ADD COLUMN is_test boolean NOT NULL DEFAULT false,
        ADD COLUMN updated_at timestamptz DEFAULT now();
      -- webhook_events with the hold columns and the two constraints the
      -- acceptance relies on: the source idempotency key, and the guard that
      -- a held event can never be dispatchable (US-04.6-01).
      CREATE TYPE webhook_event_status AS ENUM
        ('pending', 'processing', 'completed', 'failed', 'skipped');
      CREATE TABLE webhook_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        platform text NOT NULL,
        job_type text,
        idempotency_key text NOT NULL,
        store_domain text NOT NULL,
        org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
        integration_id uuid,
        order_id uuid REFERENCES orders(id),
        status webhook_event_status NOT NULL DEFAULT 'pending',
        raw_payload jsonb NOT NULL,
        dispatch_required boolean NOT NULL DEFAULT false,
        dispatch_attempts integer NOT NULL DEFAULT 0,
        last_dispatch_error text,
        next_dispatch_at timestamptz,
        dispatch_lease_until timestamptz,
        dispatched_at timestamptz,
        processing_lease_until timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        processed_at timestamptz,
        received_at timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        hold_state text NOT NULL DEFAULT 'none',
        hold_group_id uuid,
        held_at timestamptz,
        released_at timestamptz,
        withdrawn_at timestamptz,
        CONSTRAINT webhook_events_source_idempotency_key
          UNIQUE (platform, store_domain, idempotency_key),
        CONSTRAINT webhook_events_hold_state_check CHECK
          (hold_state IN ('none', 'held', 'released', 'withdrawn')),
        CONSTRAINT webhook_events_held_not_dispatchable_check CHECK
          (hold_state <> 'held' OR dispatch_required = false)
      );
      CREATE UNIQUE INDEX webhook_events_order_id_key
        ON webhook_events (order_id) WHERE order_id IS NOT NULL;
      -- Empty throughout: the commit must not write a single row here.
      CREATE TABLE verifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid,
        order_id uuid
      );
      CREATE TABLE verification_message_dispatches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        verification_id uuid
      );
      CREATE TABLE credit_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid
      );
    `);
    // Layer the real migration on the hand-written base, twice, to prove it is
    // re-runnable and ships exactly the constraints the repository relies on.
    for (let pass = 0; pass < 2; pass++) {
      for (const migration of [
        '0037_order_import_batches.sql',
        '0038_order_import_validation_version.sql',
        '0039_order_import_release.sql',
        '0040_order_import_row_retention.sql',
        '0044_order_import_payment_classifications.sql',
      ]) {
        for (const statement of readFileSync(
          resolve(__dirname, '../drizzle', migration),
          'utf8',
        ).split('--> statement-breakpoint')) {
          if (statement.trim()) await client.unsafe(statement);
        }
      }
    }
    await client.unsafe(`
      GRANT USAGE ON SCHEMA ${namespace} TO authenticated;
      GRANT SELECT ON order_import_batches, order_import_rows, order_import_mapping_profiles, order_import_payment_classifications TO authenticated;
    `);
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('stores a 5,000-row draft and its rows in one transaction', async () => {
    const source = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source),
      rows(5_000),
      options,
    );

    expect(draft.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(draft.duplicateFileOf).toBeNull();
    const [stored] = await client<
      {
        status: string;
        row_count: number;
        headers: string[];
        file_name: string;
        expires_at: Date;
      }[]
    >`SELECT status, row_count, headers, file_name, expires_at FROM order_import_batches WHERE id = ${draft.batchId}`;
    expect(stored).toMatchObject({
      status: 'draft',
      row_count: 5_000,
      headers: ['order_id', 'الاسم'],
      file_name: 'طلبات.xlsx',
    });
    const [summary] = await client<
      { count: number; first: number; last: number }[]
    >`
      SELECT count(*)::int AS count, min(row_number) AS first, max(row_number) AS last
      FROM order_import_rows WHERE batch_id = ${draft.batchId} AND org_id = ${source.orgId}`;
    expect(summary).toEqual({ count: 5_000, first: 2, last: 5_001 });
    const [first] = await client<
      { raw: unknown; issues: unknown; outcome: null }[]
    >`
      SELECT raw, issues, outcome FROM order_import_rows
      WHERE batch_id = ${draft.batchId} AND row_number = 2`;
    expect(first).toEqual({
      raw: { order_id: 'A-0', الاسم: 'عميل 0' },
      issues: [{ code: 'FIELD_TOO_LONG', field: 'الاسم' }],
      outcome: null,
    });
    expect(ORDER_IMPORT_ROW_CHUNK).toBe(500);
  });

  it('leaves nothing behind when a row insert fails mid-transaction', async () => {
    const source = await createSource();
    const broken = rows(1_200);
    broken[1_100] = { ...broken[1_100], rowNumber: broken[10].rowNumber };

    await expect(
      repository.createDraftWithRows(batch(source), broken, options),
    ).rejects.toThrow();
    expect(await batchCount(source.orgId)).toBe(0);
    const [orphans] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM order_import_rows WHERE org_id = ${source.orgId}`;
    expect(orphans.count).toBe(0);
  });

  it('flags the same file uploaded again within 24 hours, never itself', async () => {
    const source = await createSource();
    const first = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    const second = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );

    expect(first.duplicateFileOf).toBeNull();
    expect(second.duplicateFileOf).toEqual({
      batchId: first.batchId,
      createdAt: first.createdAt,
      status: 'draft',
    });
    const other = await repository.createDraftWithRows(
      batch(source, { fileSha256: 'b'.repeat(64) }),
      rows(1),
      options,
    );
    expect(other.duplicateFileOf).toBeNull();
  });

  it('ignores expired batches, older uploads and other organizations for duplicates', async () => {
    const source = await createSource();
    const otherOrg = await createSource();
    const sha = 'c'.repeat(64);
    const expired = await repository.createDraftWithRows(
      batch(source, { fileSha256: sha }),
      rows(1),
      options,
    );
    await client`UPDATE order_import_batches SET status = 'expired' WHERE id = ${expired.batchId}`;
    const old = await repository.createDraftWithRows(
      batch(source, { fileSha256: sha }),
      rows(1),
      options,
    );
    await client`
      UPDATE order_import_batches SET created_at = now() - interval '25 hours'
      WHERE id = ${old.batchId}`;
    await repository.createDraftWithRows(
      batch(otherOrg, { fileSha256: sha }),
      rows(1),
      options,
    );

    const fresh = await repository.findRecentDuplicate(
      source.orgId,
      sha,
      new Date(Date.now() - 24 * HOUR),
    );
    expect(fresh).toBeNull();

    await client`UPDATE order_import_batches SET status = 'completed' WHERE id = ${expired.batchId}`;
    await expect(
      repository.findRecentDuplicate(
        source.orgId,
        sha,
        new Date(Date.now() - 24 * HOUR),
      ),
    ).resolves.toMatchObject({ batchId: expired.batchId, status: 'completed' });
  });

  it('holds at most three open drafts, even under concurrent uploads', async () => {
    const source = await createSource();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        repository.createDraftWithRows(batch(source), rows(50), options),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(3);
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(refused).toHaveLength(3);
    for (const refusal of refused) {
      expect(refusal.reason).toBeInstanceOf(OrderImportDraftLimitError);
      expect(
        (refusal.reason as OrderImportDraftLimitError).drafts,
      ).toHaveLength(3);
    }
    expect(await batchCount(source.orgId)).toBe(3);
  });

  it('does not count expired or non-draft batches against the cap', async () => {
    const source = await createSource();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++)
      ids.push(
        (await repository.createDraftWithRows(batch(source), rows(1), options))
          .batchId,
      );
    await client`UPDATE order_import_batches SET expires_at = now() - interval '1 minute' WHERE id = ${ids[0]}`;
    await client`UPDATE order_import_batches SET status = 'awaiting_start' WHERE id = ${ids[1]}`;

    await expect(
      repository.listOpenDrafts(source.orgId, new Date()),
    ).resolves.toHaveLength(1);
    await expect(
      repository.createDraftWithRows(batch(source), rows(1), {
        ...options,
        now: new Date(),
      }),
    ).resolves.toMatchObject({ batchId: expect.any(String) as string });
  });

  it('retries a colliding short code and gives up cleanly after five collisions', async () => {
    const source = await createSource();
    await repository.createDraftWithRows(batch(source), rows(1), {
      ...options,
      generateShortCode: () => 'AAAAAA',
    });
    const codes = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    const retried = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      {
        ...options,
        generateShortCode: () => codes.shift() ?? 'ZZZZZZ',
      },
    );
    expect(retried.shortCode).toBe('BBBBBB');

    const before = await batchCount(source.orgId);
    await expect(
      repository.createDraftWithRows(batch(source), rows(1), {
        ...options,
        maxOpenDrafts: 10,
        generateShortCode: () => 'AAAAAA',
      }),
    ).rejects.toBeInstanceOf(OrderImportShortCodeError);
    expect(await batchCount(source.orgId)).toBe(before);

    // The same code is free in another organization.
    const otherOrg = await createSource();
    await expect(
      repository.createDraftWithRows(batch(otherOrg), rows(1), {
        ...options,
        generateShortCode: () => 'AAAAAA',
      }),
    ).resolves.toMatchObject({ shortCode: 'AAAAAA' });
  });

  it('discards only a draft of the caller organization, purging its rows', async () => {
    const source = await createSource();
    const otherOrg = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source),
      rows(700),
      options,
    );

    await expect(
      repository.discardDraft(otherOrg.orgId, draft.batchId),
    ).resolves.toEqual({
      outcome: 'not_found',
    });
    await expect(
      repository.discardDraft(source.orgId, draft.batchId),
    ).resolves.toEqual({
      outcome: 'discarded',
    });
    const [remaining] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM order_import_rows WHERE batch_id = ${draft.batchId}`;
    expect(remaining.count).toBe(0);
    await expect(
      repository.discardDraft(source.orgId, draft.batchId),
    ).resolves.toEqual({
      outcome: 'not_found',
    });

    const committed = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    await client`UPDATE order_import_batches SET status = 'committing' WHERE id = ${committed.batchId}`;
    await expect(
      repository.discardDraft(source.orgId, committed.batchId),
    ).resolves.toEqual({
      outcome: 'state_conflict',
      status: 'committing',
    });
  });

  it.each([
    'committing',
    'awaiting_start',
    'releasing',
    'paused',
    'completed',
    'stopped',
    'not_started',
    'expired',
    'failed',
  ])('never discards a %s batch or its rows', async (status) => {
    const source = await createSource();
    const created = await repository.createDraftWithRows(
      batch(source),
      rows(3),
      options,
    );
    // Straight to the status: only the delete's own guard is under test.
    await client`UPDATE order_import_batches SET status = ${status} WHERE id = ${created.batchId}`;

    await expect(
      repository.discardDraft(source.orgId, created.batchId),
    ).resolves.toEqual({ outcome: 'state_conflict', status });
    await expect(batchCount(source.orgId)).resolves.toBe(1);
    const [remaining] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM order_import_rows WHERE batch_id = ${created.batchId}`;
    expect(remaining.count).toBe(3);
  });

  it("keeps the organization's mapping profile when its draft is discarded", async () => {
    const source = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    await repository.saveMapping({
      orgId: source.orgId,
      batchId: draft.batchId,
      userId: randomUUID(),
      headerSignature: 'c'.repeat(64),
      mapping: { confirmed: true, columns: { phone: 'order_id' } },
      options: { country: 'EG' },
      profile: {
        mapping: { columns: { phone: 'order_id' } },
        options: { country: 'EG' },
      },
      paymentClassifications: {},
      now: NOW,
    });

    await expect(
      repository.discardDraft(source.orgId, draft.batchId),
    ).resolves.toEqual({ outcome: 'discarded' });
    await expect(batchCount(source.orgId)).resolves.toBe(0);
    const [profiles] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM order_import_mapping_profiles WHERE org_id = ${source.orgId}`;
    expect(profiles.count).toBe(1);
  });

  it("replaces only the uploader's own drafts on a new upload", async () => {
    const source = await createSource();
    const otherOrg = await createSource();
    const uploader = randomUUID();
    // Each seeding upload runs as a stranger, then is handed to the uploader:
    // uploading as the uploader would already replace the previous one.
    const seed = async (
      target: { orgId: string; integrationId: string },
      count: number,
      overrides: Partial<NewDraftBatch> = {},
      status = 'draft',
    ) => {
      const created = await repository.createDraftWithRows(
        batch(target, overrides),
        rows(count),
        { ...options, maxOpenDrafts: 10 },
      );
      await client`UPDATE order_import_batches SET created_by = ${uploader}, status = ${status} WHERE id = ${created.batchId}`;
      return created;
    };
    const mine = await seed(source, 50);
    const alsoMine = await seed(source, 1, { fileSha256: 'd'.repeat(64) });
    const mineStarted = await seed(source, 1, {}, 'awaiting_start');
    const elsewhere = await seed(otherOrg, 1);
    const theirs = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );

    // Before the delete, three drafts would fill a cap of two; after it, only
    // the colleague's one counts, so the upload fits.
    const replacement = await repository.createDraftWithRows(
      batch(source, { createdBy: uploader }),
      rows(2),
      { ...options, maxOpenDrafts: 2 },
    );

    expect(replacement.supersededDrafts).toBe(2);
    const survivors = await client<{ id: string; status: string }[]>`
      SELECT id, status FROM order_import_batches WHERE org_id = ${source.orgId} ORDER BY id`;
    expect(survivors.map((row) => row.id).sort()).toEqual(
      [theirs.batchId, mineStarted.batchId, replacement.batchId].sort(),
    );
    const [orphanRows] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM order_import_rows
      WHERE batch_id IN (${mine.batchId}, ${alsoMine.batchId})`;
    expect(orphanRows.count).toBe(0);
    // The same file as the replaced draft points at the started batch, which
    // still exists, never at the draft that is gone.
    expect([theirs.batchId, mineStarted.batchId]).toContain(
      replacement.duplicateFileOf?.batchId,
    );
    await expect(batchCount(otherOrg.orgId)).resolves.toBe(1);
    const [kept] = await client<{ status: string }[]>`
      SELECT status FROM order_import_batches WHERE id = ${elsewhere.batchId}`;
    expect(kept.status).toBe('draft');
  });

  it("still refuses an upload when other members' drafts fill the cap", async () => {
    const source = await createSource();
    for (let index = 0; index < 3; index++)
      await repository.createDraftWithRows(batch(source), rows(1), options);

    await expect(
      repository.createDraftWithRows(batch(source), rows(1), options),
    ).rejects.toBeInstanceOf(OrderImportDraftLimitError);
    await expect(batchCount(source.orgId)).resolves.toBe(3);
  });

  it('enforces the status, format, outcome and short-code checks', async () => {
    const source = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    await expect(
      client`UPDATE order_import_batches SET status = 'bogus' WHERE id = ${draft.batchId}`,
    ).rejects.toThrow(/order_import_batches_status_check/);
    await expect(
      client`UPDATE order_import_batches SET file_format = 'xls' WHERE id = ${draft.batchId}`,
    ).rejects.toThrow(/order_import_batches_file_format_check/);
    await expect(
      client`UPDATE order_import_batches SET short_code = 'ILOU01' WHERE id = ${draft.batchId}`,
    ).rejects.toThrow(/order_import_batches_short_code_check/);
    await expect(
      client`UPDATE order_import_rows SET outcome = 'maybe' WHERE batch_id = ${draft.batchId}`,
    ).rejects.toThrow(/order_import_rows_outcome_check/);
    // A row cannot claim another organization than its batch.
    const otherOrg = await createSource();
    await expect(
      client`
        INSERT INTO order_import_rows (batch_id, org_id, row_number, raw)
        VALUES (${draft.batchId}, ${otherOrg.orgId}, 99, '{}'::jsonb)`,
    ).rejects.toThrow(/order_import_rows_batch_id_fkey/);
  });

  it('stores the suggested mapping on the draft at upload', async () => {
    const source = await createSource();
    const mapping = { dictionaryVersion: 1, confirmed: false, columns: {} };
    const draft = await repository.createDraftWithRows(
      batch(source, { mapping, options: { country: 'EG' } }),
      rows(1),
      options,
    );
    await expect(
      repository.findBatchForMapping(source.orgId, draft.batchId),
    ).resolves.toMatchObject({ status: 'draft', mapping });
    const otherOrg = await createSource();
    await expect(
      repository.findBatchForMapping(otherOrg.orgId, draft.batchId),
    ).resolves.toBeNull();
  });

  it('counts the values of one column, org-scoped, treating a missing cell as blank', async () => {
    const source = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source, { headers: ['payment'] }),
      [
        { rowNumber: 2, raw: { payment: 'COD' }, issues: [] },
        { rowNumber: 3, raw: { payment: 'COD' }, issues: [] },
        { rowNumber: 4, raw: { payment: 'Paid' }, issues: [] },
        { rowNumber: 5, raw: {}, issues: [] },
      ],
      options,
    );
    const counts = await repository.columnValueCounts(
      source.orgId,
      draft.batchId,
      'payment',
    );
    expect(counts.sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: '', count: 1 },
      { value: 'COD', count: 2 },
      { value: 'Paid', count: 1 },
    ]);
    const otherOrg = await createSource();
    await expect(
      repository.columnValueCounts(otherOrg.orgId, draft.batchId, 'payment'),
    ).resolves.toEqual([]);
  });

  it('reads a batch detail, its first rows and an issue count, org-scoped (US-04.6-05)', async () => {
    const source = await createSource();
    const draft = await repository.createDraftWithRows(
      batch(source, { headers: ['payment'] }),
      [
        {
          rowNumber: 3,
          raw: { payment: 'Paid' },
          issues: [{ code: 'ORDER_TOO_OLD', field: 'orderDate' }],
        },
        { rowNumber: 2, raw: { payment: 'COD' }, issues: [] },
        {
          rowNumber: 4,
          raw: { payment: 'COD' },
          issues: [
            { code: 'PHONE_MISSING', field: 'phone' },
            { code: 'ORDER_TOO_OLD', field: 'orderDate' },
          ],
        },
      ],
      options,
    );

    await expect(
      repository.findBatchDetail(source.orgId, draft.batchId),
    ).resolves.toMatchObject({
      batchId: draft.batchId,
      shortCode: draft.shortCode,
      status: 'draft',
      fileSha256: 'a'.repeat(64),
      headers: ['payment'],
      orderDateMin: null,
    });
    const sample = await repository.readSampleRows(
      source.orgId,
      draft.batchId,
      2,
    );
    expect(sample.map((row) => row.rowNumber)).toEqual([2, 3]);
    await expect(
      repository.countRowsWithIssue(
        source.orgId,
        draft.batchId,
        'ORDER_TOO_OLD',
      ),
    ).resolves.toBe(2);

    const otherOrg = await createSource();
    await expect(
      repository.findBatchDetail(otherOrg.orgId, draft.batchId),
    ).resolves.toBeNull();
    await expect(
      repository.readSampleRows(otherOrg.orgId, draft.batchId, 5),
    ).resolves.toEqual([]);
    await expect(
      repository.countRowsWithIssue(
        otherOrg.orgId,
        draft.batchId,
        'ORDER_TOO_OLD',
      ),
    ).resolves.toBe(0);
  });

  it('finds the upload a batch duplicates, looking back from that batch only', async () => {
    const source = await createSource();
    const sha = 'd'.repeat(64);
    const first = await repository.createDraftWithRows(
      batch(source, { fileSha256: sha }),
      rows(1),
      options,
    );
    await client`
      UPDATE order_import_batches SET created_at = now() - interval '10 minutes'
      WHERE id = ${first.batchId}`;
    const second = await repository.createDraftWithRows(
      batch(source, { fileSha256: sha }),
      rows(1),
      options,
    );
    const since = new Date(Date.now() - 24 * HOUR);

    await expect(
      repository.findRecentDuplicate(source.orgId, sha, since, undefined, {
        batchId: second.batchId,
        createdAt: second.createdAt,
      }),
    ).resolves.toMatchObject({ batchId: first.batchId });
    const [firstRow] = await client<{ created_at: string }[]>`
      SELECT created_at::text FROM order_import_batches WHERE id = ${first.batchId}`;
    await expect(
      repository.findRecentDuplicate(source.orgId, sha, since, undefined, {
        batchId: first.batchId,
        createdAt: new Date(firstRow.created_at).toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('saves a mapping once per header signature and only on a live draft', async () => {
    const source = await createSource();
    const userId = randomUUID();
    const first = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    const second = await repository.createDraftWithRows(
      batch(source),
      rows(1),
      options,
    );
    const save = (batchId: string, country: string, orgId = source.orgId) =>
      repository.saveMapping({
        orgId,
        batchId,
        userId,
        headerSignature: 'b'.repeat(64),
        mapping: { confirmed: true, columns: { phone: 'order_id' } },
        options: { country },
        profile: {
          mapping: { columns: { phone: 'order_id' } },
          options: { country },
        },
        paymentClassifications: {},
        now: NOW,
      });

    const saved = await save(first.batchId, 'EG');
    expect(saved.outcome).toBe('saved');
    // Same body again: same profile, same state.
    await expect(save(first.batchId, 'EG')).resolves.toEqual(saved);
    // Another batch with the same headers updates the one profile.
    await expect(save(second.batchId, 'SA')).resolves.toEqual(saved);
    const profiles = await client<{ count: number; options: unknown }[]>`
      SELECT count(*) OVER ()::int AS count, options FROM order_import_mapping_profiles
      WHERE org_id = ${source.orgId}`;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].options).toEqual({ country: 'SA' });
    await expect(
      repository.findMappingProfile(source.orgId, 'b'.repeat(64)),
    ).resolves.toMatchObject({
      id: (saved as { mappingProfileId: string }).mappingProfileId,
    });
    const [stored] = await client<
      { mapping_profile_id: string; options: unknown }[]
    >`
      SELECT mapping_profile_id, options FROM order_import_batches WHERE id = ${first.batchId}`;
    expect(stored).toEqual({
      mapping_profile_id: (saved as { mappingProfileId: string })
        .mappingProfileId,
      options: { country: 'EG' },
    });

    // Another organization, a non-draft and an expired draft write nothing.
    const otherOrg = await createSource();
    await expect(save(first.batchId, 'AE', otherOrg.orgId)).resolves.toEqual({
      outcome: 'not_draft',
    });
    await client`UPDATE order_import_batches SET status = 'committing' WHERE id = ${first.batchId}`;
    await expect(save(first.batchId, 'AE')).resolves.toEqual({
      outcome: 'not_draft',
    });
    await client`UPDATE order_import_batches SET expires_at = ${new Date(NOW.getTime() - HOUR).toISOString()} WHERE id = ${second.batchId}`;
    await expect(save(second.batchId, 'AE')).resolves.toEqual({
      outcome: 'not_draft',
    });
    const [after] = await client<{ options: unknown }[]>`
      SELECT options FROM order_import_mapping_profiles WHERE org_id = ${source.orgId}`;
    expect(after.options).toEqual({ country: 'SA' });
    await expect(
      repository.findMappingProfile(otherOrg.orgId, 'b'.repeat(64)),
    ).resolves.toBeNull();
  });

  it('remembers payment choices per organization across header sets', async () => {
    const source = await createSource();
    const otherOrg = await createSource();
    const userId = randomUUID();
    const save = async (
      orgId: string,
      signature: string,
      paymentClassifications: Record<string, 'cod' | 'not_cod'>,
    ) => {
      const draft = await repository.createDraftWithRows(
        batch(orgId === source.orgId ? source : otherOrg),
        rows(1),
        options,
      );
      return repository.saveMapping({
        orgId,
        batchId: draft.batchId,
        userId,
        headerSignature: signature,
        mapping: { confirmed: true, columns: { phone: 'order_id' } },
        options: { country: 'EG' },
        profile: { mapping: {}, options: {} },
        paymentClassifications,
        now: NOW,
      });
    };

    await save(source.orgId, 'c'.repeat(64), { cash: 'cod', visa: 'not_cod' });
    // A file with other headers changes one choice and adds another.
    await save(source.orgId, 'd'.repeat(64), {
      visa: 'cod',
      wallet: 'not_cod',
      ['x'.repeat(256)]: 'cod',
    });
    await save(otherOrg.orgId, 'c'.repeat(64), { cash: 'not_cod' });

    await expect(
      repository.findPaymentClassifications(source.orgId, [
        'cash',
        'visa',
        'wallet',
        'unseen',
        'x'.repeat(256),
      ]),
    ).resolves.toEqual({ cash: 'cod', visa: 'cod', wallet: 'not_cod' });
    await expect(
      repository.findPaymentClassifications(otherOrg.orgId, ['cash', 'visa']),
    ).resolves.toEqual({ cash: 'not_cod' });
    await expect(
      repository.findPaymentClassifications(source.orgId, []),
    ).resolves.toEqual({});
    await expect(
      client`INSERT INTO order_import_payment_classifications (org_id, normalized_value, classification) VALUES (${source.orgId}, 'bank', 'maybe')`,
    ).rejects.toThrow(/classification_check/);
  });

  it('lists started imports: sending, paused, or finished since the cutoff', async () => {
    const source = await createSource();
    const other = await createSource();
    const ids: string[] = [];
    // Five drafts at once: above the default cap of three.
    for (let i = 0; i < 5; i++)
      ids.push(
        (
          await repository.createDraftWithRows(batch(source), rows(1), {
            ...options,
            maxOpenDrafts: 10,
          })
        ).batchId,
      );
    const foreign = (
      await repository.createDraftWithRows(batch(other), rows(1), options)
    ).batchId;
    const at = (hoursAgo: number) =>
      new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
    const set = (id: string, status: string, startedAt: string | null) =>
      client`UPDATE order_import_batches SET status = ${status}, started_at = ${startedAt} WHERE id = ${id}`;
    await set(ids[0], 'releasing', at(1));
    await set(ids[1], 'paused', at(30));
    await set(ids[2], 'completed', at(2));
    await set(ids[3], 'completed', at(30));
    await set(ids[4], 'awaiting_start', null);
    await set(foreign, 'releasing', at(1));

    const started = await repository.listStartedBatches(
      source.orgId,
      new Date(NOW.getTime() - 24 * HOUR),
      10,
    );
    expect(started.map((entry) => [entry.batchId, entry.status])).toEqual([
      [ids[0], 'releasing'],
      [ids[2], 'completed'],
      [ids[1], 'paused'],
    ]);
  });

  it('limits a signed-in member to their own organization through RLS', async () => {
    const mine = await createSource();
    const theirs = await createSource();
    await repository.createDraftWithRows(batch(mine), rows(2), options);
    await repository.createDraftWithRows(batch(theirs), rows(3), options);

    const visible = await client.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('akeed.test_org', $1, true)`, [
        mine.orgId,
      ]);
      await tx.unsafe('SET LOCAL ROLE authenticated');
      const [batches] = await tx.unsafe<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM order_import_batches',
      );
      const [importRows] = await tx.unsafe<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM order_import_rows',
      );
      return { batches: batches.count, rows: importRows.count };
    });
    expect(visible).toEqual({ batches: 1, rows: 2 });

    const [policies] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies
      WHERE schemaname = ${namespace}
        AND tablename IN ('order_import_batches', 'order_import_rows', 'order_import_mapping_profiles', 'order_import_payment_classifications')
        AND qual = '(org_id = get_user_org_id())'`;
    expect(policies.count).toBe(4);
  });

  describe('row validation (US-04.6-04)', () => {
    const DAY = 24 * HOUR;
    const cairo = 'Africa/Cairo';
    const columns = {
      phone: 'phone',
      customerName: ['name'],
      amount: 'total',
      orderReference: 'ref',
      currency: null,
      paymentMethod: 'payment',
      orderDate: 'date',
      city: null,
      address: null,
      notes: null,
    };
    const validator = new RowValidationService(
      repository,
      new PhoneService(),
      new OrderEligibilityService([new StandaloneOrderEligibilityStrategy()]),
      {
        get: (key: string) =>
          key === BULK_IMPORT_CONFIG ? parseBulkImportConfig({}) : undefined,
      } as never,
    );

    async function seedOrder(
      source: { orgId: string; integrationId: string },
      order: {
        externalOrderId: string;
        orderNumber?: string;
        phone: string;
        total: string;
        ageDays: number;
      },
    ): Promise<string> {
      const [row] = await client<{ id: string }[]>`
        INSERT INTO orders (org_id, integration_id, external_order_id, order_number, customer_phone, total_price, created_at)
        VALUES (${source.orgId}, ${source.integrationId}, ${order.externalOrderId}, ${order.orderNumber ?? null},
                ${order.phone}, ${order.total}, now() - make_interval(secs => ${order.ageDays * 86_400}))
        RETURNING id`;
      return row.id;
    }

    async function draftWithRows(
      source: { orgId: string; integrationId: string },
      cells: Record<string, string>[],
    ): Promise<string> {
      const draft = await repository.createDraftWithRows(
        batch(source, {
          headers: ['phone', 'name', 'total', 'ref', 'payment', 'date'],
        }),
        cells.map((raw, index) => ({ rowNumber: index + 2, raw, issues: [] })),
        options,
      );
      await client`
        UPDATE order_import_batches
        SET mapping = ${JSON.stringify({ confirmed: true, columns })}::jsonb,
            options = ${JSON.stringify({ country: 'EG', defaultCurrency: 'EGP', dateFormat: 'auto', paymentValueMap: {} })}::jsonb
        WHERE id = ${draft.batchId}`;
      return draft.batchId;
    }

    const standaloneSource = (source: {
      orgId: string;
      integrationId: string;
    }) =>
      ({
        id: source.integrationId,
        orgId: source.orgId,
        platformType: 'standalone',
        timezone: cairo,
        assumeCodWhenPaymentMissing: false,
      }) as never;

    async function storedRows(batchId: string) {
      return client<
        {
          row_number: number;
          outcome: string | null;
          issues: { code: string; params?: Record<string, unknown> }[];
          include_override: boolean;
          dedupe_key: string | null;
          collapsed_into: number | null;
          raw: Record<string, string>;
        }[]
      >`
        SELECT row_number, outcome, issues, include_override, dedupe_key, collapsed_into, raw
        FROM order_import_rows WHERE batch_id = ${batchId} ORDER BY row_number`;
    }

    const today = () => dateInTimezone(new Date(), cairo);
    const daysAgo = (days: number) =>
      dateInTimezone(new Date(Date.now() - days * DAY), cairo);
    const cod = (cells: Record<string, string>) => ({
      name: 'Ahmed',
      payment: 'COD',
      date: today(),
      ...cells,
    });

    it('applies L1 and L3 against the source orders and summarizes from rows', async () => {
      const source = await createSource();
      const other = await createSource();
      const importedId = await seedOrder(source, {
        externalOrderId: 'ref:1001',
        orderNumber: '#1001',
        phone: '+201099999999',
        total: '1.00',
        ageDays: 40,
      });
      await seedOrder(source, {
        externalOrderId: 'manual-a',
        orderNumber: 'M-1',
        phone: '+201112345678',
        total: '300.00',
        ageDays: 3,
      });
      await seedOrder(source, {
        externalOrderId: 'manual-b',
        orderNumber: 'M-2',
        phone: '+201212345678',
        total: '400.00',
        ageDays: 8, // Outside the 7-day phone window.
      });
      await seedOrder(source, {
        externalOrderId: 'manual-c',
        orderNumber: 'ORD-77',
        phone: '+201099999998',
        total: '1.00',
        ageDays: 20,
      });
      await seedOrder(source, {
        externalOrderId: 'manual-d',
        orderNumber: 'ORD-88',
        phone: '+201099999997',
        total: '1.00',
        ageDays: 31, // Outside the 30-day order-number window.
      });
      // Another organization's orders never match.
      await seedOrder(other, {
        externalOrderId: 'ref:1002',
        orderNumber: '#1002',
        phone: '+201112345678',
        total: '300.00',
        ageDays: 1,
      });

      const batchId = await draftWithRows(source, [
        cod({ phone: '01000000001', total: '10', ref: '#1001' }),
        cod({ phone: '01112345678', total: '300', ref: '', date: daysAgo(1) }),
        cod({ phone: '01212345678', total: '400', ref: '', date: daysAgo(2) }),
        cod({ phone: '01000000002', total: '10', ref: 'ord-77' }),
        cod({ phone: '01000000003', total: '10', ref: 'ORD-88' }),
        cod({ phone: '01000000004', total: '10', ref: '#1002' }),
        cod({ phone: '0223456789', total: '10', ref: '#9' }),
      ]);
      await validator.validateBatch(
        { orgId: source.orgId, source: standaloneSource(source) },
        batchId,
      );

      const stored = await storedRows(batchId);
      expect(stored.map((row) => [row.row_number, row.outcome])).toEqual([
        [2, 'duplicate'],
        [3, 'excluded'],
        [4, 'ready'],
        [5, 'excluded'],
        [6, 'ready'],
        [7, 'ready'],
        [8, 'invalid'],
      ]);
      expect(stored[0].issues).toEqual([
        {
          code: 'ALREADY_IMPORTED',
          field: 'orderReference',
          params: { orderId: importedId },
        },
      ]);
      expect(stored[1].issues).toEqual([
        {
          code: 'POSSIBLE_DUPLICATE',
          params: {
            orderNumber: 'M-1',
            date: daysAgo(3),
            match: 'phone_amount',
          },
        },
      ]);
      expect(stored[3].issues[0]).toMatchObject({
        code: 'POSSIBLE_DUPLICATE',
        params: { orderNumber: 'ORD-77', match: 'order_number' },
      });
      expect(stored[0].dedupe_key).toBe('ref:1001');

      const [summary] = await client<
        {
          counts: Record<string, number>;
          order_date_min: string;
          order_date_max: string;
          validation_version: number;
        }[]
      >`
        SELECT counts, order_date_min::text, order_date_max::text, validation_version
        FROM order_import_batches WHERE id = ${batchId}`;
      expect(summary).toEqual({
        counts: {
          total: 7,
          ready: 3,
          invalid: 1,
          duplicate: 1,
          excluded: 2,
          // Zero until the commit job runs; the key is always present so the
          // progress view never has to distinguish missing from none.
          imported: 0,
        },
        order_date_min: daysAgo(2),
        order_date_max: today(),
        validation_version: 1,
      });
    });

    it('collapses line items and flags conflicting references across chunks', async () => {
      const source = await createSource();
      const cells = Array.from({ length: ORDER_IMPORT_ROW_CHUNK + 5 }, (_, i) =>
        cod({ phone: '01012345678', total: `${i + 1}`, ref: `#${i}` }),
      );
      // Row 507 repeats row 2's order; row 508 reuses row 3's reference.
      cells.push(cod({ phone: '01012345678', total: '1', ref: '#0' }));
      cells.push(cod({ phone: '01112345678', total: '2', ref: '#1' }));
      const batchId = await draftWithRows(source, cells);
      await validator.validateBatch(
        { orgId: source.orgId, source: standaloneSource(source) },
        batchId,
      );
      const byRow = new Map(
        (await storedRows(batchId)).map((row) => [row.row_number, row]),
      );
      expect(byRow.get(ORDER_IMPORT_ROW_CHUNK + 7)).toMatchObject({
        outcome: 'duplicate',
        collapsed_into: 2,
      });
      expect(byRow.get(3)?.outcome).toBe('invalid');
      expect(byRow.get(ORDER_IMPORT_ROW_CHUNK + 8)?.issues).toContainEqual({
        code: 'ORDER_REF_CONFLICT_IN_FILE',
        field: 'orderReference',
      });
    });

    it('keeps an include override through re-validation and refuses other rows', async () => {
      const source = await createSource();
      await seedOrder(source, {
        externalOrderId: 'manual-a',
        orderNumber: 'M-1',
        phone: '+201112345678',
        total: '300.00',
        ageDays: 1,
      });
      const batchId = await draftWithRows(source, [
        cod({ phone: '01112345678', total: '300', ref: '' }),
        cod({ phone: '01000000001', total: '10', ref: '', payment: 'Paid' }),
      ]);
      const scope = { orgId: source.orgId, source: standaloneSource(source) };
      await validator.validateBatch(scope, batchId);

      const include = (rowNumber: number) =>
        repository.setIncludeOverride({
          orgId: source.orgId,
          batchId,
          rowNumber,
          include: true,
          now: new Date(),
          decide: (row) => {
            const issues = row.issues as RowIssue[];
            return isIncludable(issues) ? outcomeOf(issues, true) : null;
          },
        });
      await expect(include(2)).resolves.toEqual({ outcome: 'saved' });
      await expect(include(3)).resolves.toEqual({ outcome: 'not_includable' });
      await expect(include(99)).resolves.toEqual({ outcome: 'row_not_found' });
      await expect(
        repository.readCounts(source.orgId, batchId),
      ).resolves.toMatchObject({ ready: 1, excluded: 1 });

      await validator.validateBatch(scope, batchId);
      const [included] = await storedRows(batchId);
      expect(included).toMatchObject({
        outcome: 'ready',
        include_override: true,
        issues: [{ code: 'POSSIBLE_DUPLICATE' }],
      });
      await expect(
        repository.readCounts(source.orgId, batchId),
      ).resolves.toMatchObject({ ready: 1, excluded: 1 });
    });

    it('replaces a phone cell on a live draft and re-validation readies the row', async () => {
      const source = await createSource();
      const other = await createSource();
      const batchId = await draftWithRows(source, [
        cod({ phone: 'x', total: '10', ref: '#1' }),
        cod({ phone: '01000000002', total: '10', ref: '#2' }),
      ]);
      const scope = { orgId: source.orgId, source: standaloneSource(source) };
      await validator.validateBatch(scope, batchId);
      const setPhone = (orgId: string, rowNumber: number) =>
        repository.setRowCell({
          orgId,
          batchId,
          rowNumber,
          column: 'phone',
          value: '+201000000001',
          now: new Date(),
          editable: (row) =>
            (row.issues as RowIssue[]).some((issue) => issue.field === 'phone'),
        });

      await expect(setPhone(other.orgId, 2)).resolves.toEqual({
        outcome: 'not_draft',
      });
      await expect(setPhone(source.orgId, 3)).resolves.toEqual({
        outcome: 'not_editable',
      });
      await expect(setPhone(source.orgId, 99)).resolves.toEqual({
        outcome: 'row_not_found',
      });
      await expect(setPhone(source.orgId, 2)).resolves.toEqual({
        outcome: 'saved',
      });

      await validator.validateBatch(scope, batchId);
      const [fixed] = await storedRows(batchId);
      expect(fixed).toMatchObject({ outcome: 'ready', issues: [] });
      expect(fixed.raw).toMatchObject({ phone: '+201000000001', ref: '#1' });
      await expect(
        repository.readCounts(source.orgId, batchId),
      ).resolves.toMatchObject({ ready: 2 });
    });

    it('pages rows in row order, filtered and org-scoped', async () => {
      const source = await createSource();
      const other = await createSource();
      const batchId = await draftWithRows(source, [
        cod({ phone: '01000000001', total: '10', ref: '#1' }),
        cod({ phone: 'x', total: '10', ref: '#2' }),
        cod({ phone: '01000000003', total: '10', ref: '#3' }),
      ]);
      await validator.validateBatch(
        { orgId: source.orgId, source: standaloneSource(source) },
        batchId,
      );
      const page = (
        outcome: string | null,
        afterRowNumber: number,
        orgId = source.orgId,
      ) =>
        repository.pageRows({
          orgId,
          batchId,
          outcome,
          afterRowNumber,
          limit: 10,
        });
      const numbers = async (rows: Promise<{ rowNumber: number }[]>) =>
        (await rows).map((row) => row.rowNumber);

      await expect(numbers(page(null, 0))).resolves.toEqual([2, 3, 4]);
      await expect(numbers(page(null, 2))).resolves.toEqual([3, 4]);
      await expect(numbers(page('ready', 0))).resolves.toEqual([2, 4]);
      await expect(page(null, 0, other.orgId)).resolves.toEqual([]);
      await expect(
        repository.findRow(other.orgId, batchId, 2),
      ).resolves.toBeNull();
    });

    it('writes nothing once the batch has left draft', async () => {
      const source = await createSource();
      const batchId = await draftWithRows(source, [
        cod({ phone: '01000000001', total: '10', ref: '#1' }),
      ]);
      await client`UPDATE order_import_batches SET status = 'committing' WHERE id = ${batchId}`;
      await expect(
        validator.validateBatch(
          { orgId: source.orgId, source: standaloneSource(source) },
          batchId,
        ),
      ).rejects.toMatchObject({
        response: { code: 'IMPORT_BATCH_STATE_CONFLICT' },
      });
      const [row] = await storedRows(batchId);
      expect(row.outcome).toBeNull();
    });
  });

  /**
   * Commit against real Postgres, because every guarantee this story makes is
   * a database guarantee: the two unique indexes, the savepoint rollback and
   * the recount from rows. A fake cannot prove any of them.
   */
  describe('idempotent commit (US-04.6-06)', () => {
    const acceptance = new ManualOrderIngestionRepository(database);
    const ingestion = new StandaloneOrderIngestionService(
      acceptance,
      { dispatchById: jest.fn() } as never,
      { findByOrderId: jest.fn() } as never,
      {} as never,
    );

    async function committingBatch(
      source: { orgId: string; integrationId: string },
      references: Array<string | null>,
    ): Promise<string> {
      const draft = await repository.createDraftWithRows(
        batch(source, { headers: ['ref', 'phone'] }),
        references.map((_, index) => ({
          rowNumber: index + 2,
          raw: {},
          issues: [],
        })),
        { ...options, generateShortCode: () => generateShortCode() },
      );
      for (const [index, reference] of references.entries()) {
        await client`
          UPDATE order_import_rows
          SET outcome = 'ready',
              dedupe_key = ${reference ? `ref:${reference}` : null},
              normalized = ${JSON.stringify({
                orderNumber: reference ?? undefined,
                customerPhone: '+201012345678',
                customerName: 'Ahmed Ali',
                totalPrice: '750.00',
                currency: 'EGP',
                paymentMethod: 'cash_on_delivery',
              })}::jsonb
          WHERE batch_id = ${draft.batchId} AND row_number = ${index + 2}`;
      }
      await client`
        UPDATE order_import_batches
        SET status = 'committing',
            commit_idempotency_key = ${`commit-${draft.batchId}`},
            counts = counts || jsonb_build_object('readyAtCommit', ${references.length}::int)
        WHERE id = ${draft.batchId}`;
      return draft.batchId;
    }

    /** Runs the commit loop the processor runs, without BullMQ in the way. */
    async function runCommit(
      source: { orgId: string; integrationId: string },
      batchId: string,
      opts: { stopAfterChunks?: number; chunk?: number } = {},
    ): Promise<{ imported: number; alreadyImported: number }> {
      const record = await repository.findBatchForCommit(source.orgId, batchId);
      if (!record) throw new Error('batch missing');
      let imported = 0;
      let alreadyImported = 0;
      let after = 0;
      let chunks = 0;
      for (;;) {
        const pending = await repository.listRowsForCommit({
          orgId: source.orgId,
          batchId,
          afterRowNumber: after,
          limit: opts.chunk ?? 200,
        });
        if (pending.length === 0) break;
        const results = await ingestion.acceptMany(
          {
            orgId: source.orgId,
            source: {
              id: source.integrationId,
              platformStoreUrl: record.platformStoreUrl,
            },
          },
          pending.map((row) =>
            FileImportChannelAdapter.toAcceptManyInput(
              {
                rowNumber: row.rowNumber,
                normalized: { paymentMethod: '', ...row.normalized },
                dedupeKey: row.dedupeKey,
              },
              { id: batchId, shortCode: record.shortCode },
            ),
          ),
          { channel: 'bulk_import', hold: { groupId: batchId } },
        );
        const links: CommitRowLink[] = [];
        const losers: number[] = [];
        for (const [index, result] of results.entries()) {
          if (result.status === 'accepted') {
            links.push({
              rowNumber: pending[index].rowNumber,
              orderId: result.orderId,
              eventId: result.eventId,
            });
          } else {
            losers.push(pending[index].rowNumber);
          }
        }
        await repository.writeCommitChunk({
          orgId: source.orgId,
          batchId,
          imported: links,
          alreadyImported: losers,
          now: new Date(),
        });
        imported += links.length;
        alreadyImported += losers.length;
        after = pending[pending.length - 1].rowNumber;
        chunks += 1;
        // The crash: the worker dies between chunks, having committed the
        // chunks before it.
        if (opts.stopAfterChunks && chunks >= opts.stopAfterChunks) {
          return { imported, alreadyImported };
        }
      }
      await repository.finishCommit({
        orgId: source.orgId,
        batchId,
        now: new Date(),
        startWindowHours: 72,
      });
      return { imported, alreadyImported };
    }

    async function heldEvents(batchId: string) {
      return client<
        { id: string; order_id: string | null; dispatch_required: boolean }[]
      >`
        SELECT id, order_id, dispatch_required FROM webhook_events
        WHERE hold_group_id = ${batchId}`;
    }

    it('creates one held order and one held event per ready row', async () => {
      const source = await createSource();
      const batchId = await committingBatch(source, ['1001', '1002']);

      const result = await runCommit(source, batchId);

      expect(result).toEqual({ imported: 2, alreadyImported: 0 });
      const events = await heldEvents(batchId);
      expect(events).toHaveLength(2);
      // Invariant 2: a held event is never dispatchable.
      expect(events.every((event) => event.dispatch_required === false)).toBe(
        true,
      );
      expect(events.every((event) => event.order_id !== null)).toBe(true);

      const stored = await client<
        { outcome: string; order_id: string; webhook_event_id: string }[]
      >`
        SELECT outcome, order_id, webhook_event_id FROM order_import_rows
        WHERE batch_id = ${batchId} ORDER BY row_number`;
      expect(stored.every((row) => row.outcome === 'imported')).toBe(true);
      expect(stored.every((row) => row.order_id && row.webhook_event_id)).toBe(
        true,
      );

      const [summary] = await client<
        { status: string; counts: Record<string, number>; deadline: string }[]
      >`
        SELECT status, counts, start_deadline_at::text AS deadline
        FROM order_import_batches WHERE id = ${batchId}`;
      expect(summary.status).toBe('awaiting_start');
      expect(summary.counts).toMatchObject({ imported: 2, ready: 0 });
      expect(summary.deadline).not.toBeNull();
    });

    it('creates no dispatch, no credit reservation and no verification', async () => {
      // Epic invariant 1 and the story's hardest promise: importing is not
      // sending, and nothing downstream may treat it as though it were.
      const source = await createSource();
      const batchId = await committingBatch(source, ['2001', '2002']);

      await runCommit(source, batchId);

      const [counts] = await client<
        { verifications: number; dispatches: number; reservations: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM verifications WHERE org_id = ${source.orgId}) AS verifications,
          (SELECT count(*)::int FROM verification_message_dispatches) AS dispatches,
          (SELECT count(*)::int FROM credit_reservations) AS reservations`;
      expect(counts).toEqual({
        verifications: 0,
        dispatches: 0,
        reservations: 0,
      });
    });

    it('gives one order per reference when two batches commit the same refs', async () => {
      // Two merchants' tabs, or one merchant twice: the winner keeps the
      // order and the loser's row is a duplicate with nothing left behind.
      const source = await createSource();
      const first = await committingBatch(source, ['3001', '3002']);
      const second = await committingBatch(source, ['3002', '3003']);

      const [a, b] = await Promise.all([
        runCommit(source, first),
        runCommit(source, second),
      ]);

      expect(a.imported + b.imported).toBe(3);
      expect(a.alreadyImported + b.alreadyImported).toBe(1);

      const [orders] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM orders
        WHERE integration_id = ${source.integrationId}`;
      expect(orders.count).toBe(3);

      // AC4: the losing row's event was discarded with its order insert, so
      // no event is left pointing at nothing.
      const [orphans] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM webhook_events
        WHERE hold_group_id IN (${first}, ${second}) AND order_id IS NULL`;
      expect(orphans.count).toBe(0);

      const [loser] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM order_import_rows
        WHERE batch_id IN (${first}, ${second})
          AND outcome = 'duplicate'
          AND issues @> '[{"code":"ALREADY_IMPORTED"}]'::jsonb`;
      expect(loser.count).toBe(1);
    });

    it('resumes after a crash without creating anything twice', async () => {
      const source = await createSource();
      const batchId = await committingBatch(source, [
        '4001',
        '4002',
        '4003',
        '4004',
      ]);

      // Dies after the first chunk of two.
      const partial = await runCommit(source, batchId, {
        chunk: 2,
        stopAfterChunks: 1,
      });
      expect(partial.imported).toBe(2);

      // The re-run only sees rows that still have no order id.
      const resumed = await runCommit(source, batchId, { chunk: 2 });
      expect(resumed.imported).toBe(2);

      const [orders] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM orders
        WHERE integration_id = ${source.integrationId}`;
      expect(orders.count).toBe(4);
      expect(await heldEvents(batchId)).toHaveLength(4);

      const [summary] = await client<
        { status: string; counts: Record<string, number> }[]
      >`
        SELECT status, counts FROM order_import_batches WHERE id = ${batchId}`;
      expect(summary.status).toBe('awaiting_start');
      expect(summary.counts).toMatchObject({ imported: 4, readyAtCommit: 4 });
    });

    it('re-links a row whose event exists but whose row was never written', async () => {
      // The narrower crash: the acceptance committed, the row update did not.
      const source = await createSource();
      const batchId = await committingBatch(source, ['5001']);
      await runCommit(source, batchId);
      await client`
        UPDATE order_import_rows
        SET order_id = NULL, webhook_event_id = NULL, outcome = 'ready'
        WHERE batch_id = ${batchId}`;

      const again = await runCommit(source, batchId);

      expect(again).toEqual({ imported: 1, alreadyImported: 0 });
      const [orders] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM orders
        WHERE integration_id = ${source.integrationId}`;
      expect(orders.count).toBe(1);
      expect(await heldEvents(batchId)).toHaveLength(1);
    });

    it('claims a draft for exactly one of two concurrent commits', async () => {
      const source = await createSource();
      const draft = await repository.createDraftWithRows(
        batch(source),
        rows(1),
        options,
      );
      const now = new Date();

      const claims = await Promise.all([
        repository.claimForCommit({
          orgId: source.orgId,
          batchId: draft.batchId,
          key: 'commit-tab-one',
          now,
        }),
        repository.claimForCommit({
          orgId: source.orgId,
          batchId: draft.batchId,
          key: 'commit-tab-two',
          now,
        }),
      ]);

      expect(claims.filter((claim) => claim === 'claimed')).toHaveLength(1);
      expect(claims.filter((claim) => claim === 'not_draft')).toHaveLength(1);
    });

    it('refuses a commit key already spent on another batch', async () => {
      const source = await createSource();
      const first = await repository.createDraftWithRows(
        batch(source),
        rows(1),
        options,
      );
      const second = await repository.createDraftWithRows(
        batch(source),
        rows(1),
        options,
      );
      const now = new Date();
      const key = 'commit-shared-key';

      expect(
        await repository.claimForCommit({
          orgId: source.orgId,
          batchId: first.batchId,
          key,
          now,
        }),
      ).toBe('claimed');
      // The unique index is the authority, not the service's pre-check.
      expect(
        await repository.claimForCommit({
          orgId: source.orgId,
          batchId: second.batchId,
          key,
          now,
        }),
      ).toBe('key_taken');
    });

    it('leaves a failed commit with its imported rows still held', async () => {
      const source = await createSource();
      const batchId = await committingBatch(source, ['6001', '6002', '6003']);
      await runCommit(source, batchId, { chunk: 1, stopAfterChunks: 1 });

      await repository.failCommit({
        orgId: source.orgId,
        batchId,
        now: new Date(),
      });

      const [summary] = await client<
        { status: string; counts: Record<string, number> }[]
      >`
        SELECT status, counts FROM order_import_batches WHERE id = ${batchId}`;
      expect(summary.status).toBe('failed');
      expect(summary.counts).toMatchObject({ imported: 1, ready: 2 });
      // The one order that made it stays held, and so stays startable.
      const events = await heldEvents(batchId);
      expect(events).toHaveLength(1);
      expect(events[0].dispatch_required).toBe(false);
    });

    it('gives a reference-less row a batch-scoped identity', async () => {
      const source = await createSource();
      const batchId = await committingBatch(source, [null, null]);

      const result = await runCommit(source, batchId);

      expect(result.imported).toBe(2);
      const created = await client<
        { external_order_id: string; order_number: string }[]
      >`
        SELECT external_order_id, order_number FROM orders
        WHERE integration_id = ${source.integrationId}
        ORDER BY external_order_id`;
      expect(created.map((row) => row.external_order_id)).toEqual([
        `imp:${batchId}:2`,
        `imp:${batchId}:3`,
      ]);
      expect(
        created.every((row) =>
          /^IMP-[0-9A-HJKMNP-TV-Z]{6}-\d+$/.test(row.order_number),
        ),
      ).toBe(true);
    });

    it('stores the bulk envelope with its batch and row metadata', async () => {
      const source = await createSource();
      const batchId = await committingBatch(source, ['7001']);

      await runCommit(source, batchId);

      const [order] = await client<{ raw_payload: Record<string, unknown> }[]>`
        SELECT raw_payload FROM orders
        WHERE integration_id = ${source.integrationId}`;
      expect(order.raw_payload).toMatchObject({
        ingestionType: 'bulk_import',
        schemaVersion: 1,
        importBatchId: batchId,
        importRowNumber: 2,
      });
      expect(order.raw_payload).toHaveProperty('submissionFingerprint');
    });

    describe('start and paced release (US-04.6-07)', () => {
      const releases = new OrderImportReleaseRepository(database);
      const events = new WebhookEventsRepository(database);
      const claims = new Map<string, number>();
      /**
       * The dispatcher without BullMQ: the real claim, so "at most once" is
       * the database's guarantee, not the fake's. A fake messaging port; no
       * provider is ever called.
       */
      const dispatcher = {
        dispatchById: async (id: string) => {
          const claimed = await events.claimForDispatch(
            id,
            new Date(Date.now() + 60_000).toISOString(),
            new Date(Date.now() - 300_000).toISOString(),
            5,
          );
          if (!claimed) return 'not_claimed';
          claims.set(id, (claims.get(id) ?? 0) + 1);
          await events.markDispatched(id);
          return 'dispatched';
        },
      };
      const scheduler = { ensure: jest.fn(), remove: jest.fn() };
      const ready = {
        evaluate: () =>
          Promise.resolve({
            ready: true,
            blockers: [],
            snapshot: {
              accountingMode: 'prepaid_credit',
              creditsAvailable: 10_000,
              slotsRemaining: null,
            },
          }),
      };
      const config = {
        get: (key: string) =>
          key === BULK_IMPORT_CONFIG
            ? parseBulkImportConfig({ BULK_IMPORT_RELEASE_PER_MINUTE: '20' })
            : undefined,
      };

      function ticker(source: { orgId: string; integrationId: string }) {
        return new OrderImportReleaseTickService(
          releases,
          {
            findByOrg: () =>
              Promise.resolve([
                {
                  id: source.integrationId,
                  orgId: source.orgId,
                  quietHoursEnabled: false,
                  quietHoursStart: null,
                  quietHoursEnd: null,
                  timezone: 'Africa/Cairo',
                },
              ]),
          } as never,
          ready as never,
          events,
          dispatcher as never,
          scheduler as never,
          config as never,
        );
      }

      async function awaitingBatch(count: number) {
        const source = await createSource();
        const batchId = await committingBatch(
          source,
          Array.from({ length: count }, (_, index) => `S${index + 1}`),
        );
        await runCommit(source, batchId);
        return { source, batchId };
      }

      async function start(
        source: { orgId: string },
        batchId: string,
        key = `start-${batchId}`,
      ) {
        return releases.claimForStart({
          orgId: source.orgId,
          batchId,
          key,
          startedBy: randomUUID(),
          orders: 0,
          now: new Date(),
        });
      }

      async function holdStates(batchId: string) {
        return client<
          {
            id: string;
            hold_state: string;
            dispatch_required: boolean;
            dispatched_at: Date | null;
            status: string;
          }[]
        >`
          SELECT id, hold_state, dispatch_required, dispatched_at, status
          FROM webhook_events WHERE hold_group_id = ${batchId}`;
      }

      it('starts atomically once and keeps who started it immutable', async () => {
        const { source, batchId } = await awaitingBatch(3);

        await expect(start(source, batchId)).resolves.toBe('claimed');
        await expect(start(source, batchId)).resolves.toBe('not_startable');

        const [stored] = await client<
          {
            status: string;
            attested_by: string;
            attestation_version: string | null;
            started_at: Date;
            start_idempotency_key: string;
            events: Array<{ type: string; orders?: number }>;
          }[]
        >`
          SELECT status, attested_by, attestation_version, started_at,
                 start_idempotency_key, events
          FROM order_import_batches WHERE id = ${batchId}`;
        expect(stored).toMatchObject({
          status: 'releasing',
          attestation_version: null,
          start_idempotency_key: `start-${batchId}`,
        });
        expect(stored.events.map((event) => event.type)).toEqual(['started']);

        await expect(
          client`UPDATE order_import_batches SET attested_by = ${randomUUID()} WHERE id = ${batchId}`,
        ).rejects.toThrow(/order_import_attestation_immutable/);
        await expect(
          client`UPDATE order_import_batches SET attestation_version = 'x' WHERE id = ${batchId}`,
        ).rejects.toThrow(/order_import_attestation_immutable/);
        // Everything else about the batch still moves.
        await expect(
          releases.markStopped({
            orgId: source.orgId,
            batchId,
            now: new Date(),
          }),
        ).resolves.toBe(true);
      });

      it('refuses a start key another batch of the org already used', async () => {
        const first = await awaitingBatch(1);
        const secondBatch = await committingBatch(first.source, ['K2']);
        await runCommit(first.source, secondBatch);

        await start(first.source, first.batchId, 'shared-key-0001');
        await expect(
          start(first.source, secondBatch, 'shared-key-0001'),
        ).resolves.toBe('key_taken');
      });

      it('refuses a start past the start window', async () => {
        const { source, batchId } = await awaitingBatch(1);
        await client`
          UPDATE order_import_batches
          SET start_deadline_at = now() - interval '1 second'
          WHERE id = ${batchId}`;

        await expect(start(source, batchId)).resolves.toBe('not_startable');
      });

      it('releases at the pace, dispatches each event exactly once, then completes', async () => {
        const { source, batchId } = await awaitingBatch(25);
        await start(source, batchId);
        const tick = ticker(source);

        await tick.tick(source.orgId);
        let states = await holdStates(batchId);
        expect(
          states.filter((row) => row.hold_state === 'released'),
        ).toHaveLength(10);

        // Overlapping ticks (a slow tick running into the next) cannot send
        // an order twice.
        await Promise.all([tick.tick(source.orgId), tick.tick(source.orgId)]);
        await tick.tick(source.orgId);

        states = await holdStates(batchId);
        expect(states.every((row) => row.hold_state === 'released')).toBe(true);
        expect(states.every((row) => row.dispatch_required)).toBe(true);
        expect(states.every((row) => row.dispatched_at !== null)).toBe(true);
        for (const row of states) expect(claims.get(row.id)).toBe(1);

        const [batchRow] = await client<
          {
            status: string;
            completed_at: Date | null;
            events: Array<{ type: string }>;
          }[]
        >`
          SELECT status, completed_at, events FROM order_import_batches
          WHERE id = ${batchId}`;
        expect(batchRow.status).toBe('completed');
        expect(batchRow.completed_at).not.toBeNull();
        expect(batchRow.events.map((event) => event.type)).toEqual([
          'started',
          'completed',
        ]);
        await expect(releases.listReleasing(source.orgId)).resolves.toEqual([]);
      });

      it('shares one rate budget across two batches, earliest start first', async () => {
        const first = await awaitingBatch(8);
        const second = await committingBatch(first.source, [
          'T1',
          'T2',
          'T3',
          'T4',
          'T5',
          'T6',
          'T7',
          'T8',
        ]);
        await runCommit(first.source, second);
        await start(first.source, first.batchId);
        await client`
          UPDATE order_import_batches SET started_at = now() - interval '1 minute'
          WHERE id = ${first.batchId}`;
        await start(first.source, second);

        await ticker(first.source).tick(first.source.orgId);

        const releasedFirst = (await holdStates(first.batchId)).filter(
          (row) => row.hold_state === 'released',
        );
        const releasedSecond = (await holdStates(second)).filter(
          (row) => row.hold_state === 'released',
        );
        expect(releasedFirst).toHaveLength(8);
        expect(releasedSecond).toHaveLength(2);
      });

      it('leaves each event released or withdrawn when stop races a tick, and bills none of the withdrawn', async () => {
        const { source, batchId } = await awaitingBatch(25);
        await start(source, batchId);

        await Promise.all([
          ticker(source).tick(source.orgId),
          (async () => {
            await releases.markStopped({
              orgId: source.orgId,
              batchId,
              now: new Date(),
            });
            await events.withdrawHeld(source.orgId, { groupId: batchId });
          })(),
        ]);
        // A second stop repairs nothing because nothing is left.
        await expect(
          events.withdrawHeld(source.orgId, { groupId: batchId }),
        ).resolves.toEqual([]);

        const states = await holdStates(batchId);
        expect(states).toHaveLength(25);
        expect(states.filter((row) => row.hold_state === 'held')).toHaveLength(
          0,
        );
        const withdrawn = states.filter(
          (row) => row.hold_state === 'withdrawn',
        );
        for (const row of withdrawn) {
          expect(row.status).toBe('skipped');
          expect(row.dispatch_required).toBe(false);
          expect(row.dispatched_at).toBeNull();
          expect(claims.has(row.id)).toBe(false);
        }
        // A withdrawn order never reaches the send path, so nothing reserved
        // credit or created a dispatch for it.
        const [billing] = await client<
          { dispatches: number; reservations: number }[]
        >`
          SELECT (SELECT count(*)::int FROM verification_message_dispatches) AS dispatches,
                 (SELECT count(*)::int FROM credit_reservations) AS reservations`;
        expect(billing).toEqual({ dispatches: 0, reservations: 0 });
        // Released events can never be withdrawn afterwards.
        const released = states
          .filter((row) => row.hold_state === 'released')
          .map((row) => row.id);
        await expect(
          events.withdrawHeld(source.orgId, { eventIds: released }),
        ).resolves.toEqual([]);
      });

      it('expires never-started and paused batches past their window, and only those', async () => {
        const waiting = await awaitingBatch(3);
        const paused = await committingBatch(waiting.source, ['P1', 'P2']);
        await runCommit(waiting.source, paused);
        await client`
          UPDATE order_import_batches SET status = 'paused', paused_reason = 'INSUFFICIENT_CREDITS'
          WHERE id = ${paused}`;

        const expirer = new OrderImportExpireService(releases, events);
        // 72 hours later, give or take a minute.
        const before = new Date(Date.now() + 72 * HOUR - 60_000);
        const after = new Date(Date.now() + 72 * HOUR + 60_000);
        await expirer.run(before);
        expect((await holdStates(waiting.batchId))[0].hold_state).toBe('held');

        await expirer.run(after);
        const statuses = await client<{ id: string; status: string }[]>`
          SELECT id, status FROM order_import_batches
          WHERE id IN ${client([waiting.batchId, paused])}`;
        const byId = Object.fromEntries(
          statuses.map((row) => [row.id, row.status]),
        );
        expect(byId[waiting.batchId]).toBe('not_started');
        expect(byId[paused]).toBe('not_started');
        for (const id of [waiting.batchId, paused])
          expect(
            (await holdStates(id)).every(
              (row) => row.hold_state === 'withdrawn',
            ),
          ).toBe(true);
        // A batch that was started is never touched, whatever its deadline.
        const started = await committingBatch(waiting.source, ['X1']);
        await runCommit(waiting.source, started);
        await start(waiting.source, started);
        await expirer.run(after);
        const [startedRow] = await client<{ status: string }[]>`
          SELECT status FROM order_import_batches WHERE id = ${started}`;
        expect(startedRow.status).toBe('releasing');
      });

      it('finds every organization with a releasing batch for worker boot', async () => {
        const { source, batchId } = await awaitingBatch(1);
        await start(source, batchId);

        await expect(releases.listOrgsWithReleasing()).resolves.toContain(
          source.orgId,
        );
      });

      it('reports hold counts and pauses every releasing batch of the org at once', async () => {
        const { source, batchId } = await awaitingBatch(4);
        await start(source, batchId);
        await events.releaseHeld(
          source.orgId,
          (await holdStates(batchId)).slice(0, 1).map((row) => row.id),
          new Date().toISOString(),
        );

        await expect(
          releases.holdCounts(source.orgId, batchId),
        ).resolves.toEqual({
          held: 3,
          released: 1,
          withdrawn: 0,
        });
        await expect(
          releases.pauseReleasing(
            source.orgId,
            'INSUFFICIENT_CREDITS',
            new Date(),
          ),
        ).resolves.toEqual([batchId]);
        await expect(
          releases.resume({ orgId: source.orgId, batchId, now: new Date() }),
        ).resolves.toBe(true);
        const [row] = await client<
          { events: Array<{ type: string; from?: string }> }[]
        >`
          SELECT events FROM order_import_batches WHERE id = ${batchId}`;
        expect(row.events.map((event) => event.type)).toEqual([
          'started',
          'paused',
          'resumed',
        ]);
        expect(row.events[2].from).toBe('INSUFFICIENT_CREDITS');
      });

      /**
       * US-04.6-09 AC3: the whole path a merchant's file takes, with the real
       * parser worker, validation, commit job, start checkpoint and release
       * tick over PostgreSQL, while every byte any logger writes is captured.
       * None of the customer data in the file, nor the file's name, may be in
       * it. Only the messaging port and the credit gate are fakes.
       */
      it('logs no phone, name, address or file name from upload to release', async () => {
        const markers = {
          phones: [
            '01098765431',
            '+201098765431',
            '201098765431',
            '1098765431',
            '1098765432',
          ],
          names: ['Zubaydah', 'Quxmarker'],
          addresses: [
            '77 Marker Lane',
            '78 Marker Lane',
            'Qx9Z',
            'Markerville',
          ],
          fileName: 'pii-marker-طلبات-Q7.csv',
        };
        const csv = [
          'order_id,customer_name,phone,address,city,amount,payment',
          'PII-1,Zubaydah Quxmarker,01098765431,77 Marker Lane Qx9Z,Markerville,750,cod',
          'PII-2,Zubaydah Quxmarker Jr,+201098765432,78 Marker Lane Qx9Z,Markerville,120.50,cod',
        ].join('\r\n');

        const captured: string[] = [];
        const keep = (...parts: unknown[]): void => {
          captured.push(
            parts
              .map((part) =>
                typeof part === 'string' ? part : JSON.stringify(part),
              )
              .join(' '),
          );
        };
        const capture: LoggerService = {
          log: keep,
          error: keep,
          warn: keep,
          debug: keep,
          verbose: keep,
          fatal: keep,
        };
        const writeTo = (chunk: unknown): boolean => {
          keep(String(chunk));
          return true;
        };
        const spies = [
          jest.spyOn(process.stdout, 'write').mockImplementation(writeTo),
          jest.spyOn(process.stderr, 'write').mockImplementation(writeTo),
          ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
            jest.spyOn(console, level).mockImplementation(keep),
          ),
        ];
        Logger.overrideLogger(capture);

        try {
          const org = await createSource();
          const source = {
            id: org.integrationId,
            orgId: org.orgId,
            platformType: 'standalone',
            platformStoreUrl: `standalone:${org.orgId}`,
            isActive: true,
            onboardingStatus: 'completed',
            isAutoVerifyEnabled: true,
            followUpEnabled: false,
            quietHoursEnabled: false,
            quietHoursStart: null,
            quietHoursEnd: null,
            timezone: 'Africa/Cairo',
            countryCode: 'EG',
            shippingCurrency: 'EGP',
            assumeCodWhenPaymentMissing: false,
          } as never;
          const user = {
            userId: randomUUID(),
            orgId: org.orgId,
            role: 'owner',
            source: 'supabase',
          } as never;
          const importConfig = {
            get: (key: string) =>
              key === BULK_IMPORT_CONFIG
                ? parseBulkImportConfig({
                    STANDALONE_BULK_IMPORT_ENABLED: 'true',
                    BULK_IMPORT_QUOTE_SECRET:
                      'test-quote-secret-0123456789abcdef',
                    BULK_IMPORT_RELEASE_PER_MINUTE: '20',
                  })
                : undefined,
          } as never;
          const validation = new RowValidationService(
            repository,
            new PhoneService(),
            new OrderEligibilityService([
              new StandaloneOrderEligibilityStrategy(),
            ]),
            importConfig,
          );
          const mapping = new OrderImportMappingService(repository, validation);
          const uploads = new OrderImportsService(
            repository,
            new ImportFileParser(),
            importConfig,
            mapping,
          );
          const detail = new OrderImportDetailService(
            repository,
            mapping,
            releases,
            { countLifecycleByImportBatch: () => Promise.resolve([]) } as never,
            importConfig,
          );
          const jobs: Array<{ batchId: string; orgId: string }> = [];
          const commits = new OrderImportCommitService(repository, detail, {
            enqueue: (job: { batchId: string; orgId: string }) => {
              jobs.push(job);
              return Promise.resolve();
            },
          } as never);
          const commitJob = new OrderImportCommitProcessor(
            repository,
            ingestion,
          );
          const starts = new OrderImportReleaseService(
            releases,
            events,
            ready as never,
            scheduler as never,
            detail,
            importConfig,
          );

          const uploaded = await uploads.upload(user, source, {
            buffer: Buffer.from(csv, 'utf8'),
            size: Buffer.byteLength(csv),
            originalname: markers.fileName,
          });
          const batchId = uploaded.batchId;
          await mapping.save(user, source, batchId, {
            mapping: {
              orderReference: 'order_id',
              customerName: ['customer_name'],
              phone: 'phone',
              address: 'address',
              city: 'city',
              amount: 'amount',
              paymentMethod: 'payment',
            },
            options: {
              country: 'EG',
              defaultCurrency: 'EGP',
              dateFormat: 'auto',
              paymentValueMap: { cod: 'cod' },
            },
          } as never);
          await commits.commit(user, source, batchId, `commit-${batchId}`);
          expect(jobs).toEqual([{ batchId, orgId: org.orgId }]);
          await commitJob.process({ data: jobs[0] } as Job<{
            batchId: string;
            orgId: string;
          }>);
          const quote = await starts.quote(user, source, batchId);
          expect(quote.orders).toBe(2);
          await starts.start(user, source, batchId, `start-${batchId}`, {
            quoteToken: quote.quoteToken,
          });
          const tick = ticker(org);
          for (let attempt = 0; attempt < 5; attempt++)
            await tick.tick(org.orgId);

          const [finished] = await client<{ status: string }[]>`
            SELECT status FROM order_import_batches WHERE id = ${batchId}`;
          expect(finished.status).toBe('completed');
          const released = await holdStates(batchId);
          expect(released.map((event) => event.hold_state)).toEqual([
            'released',
            'released',
          ]);
        } finally {
          for (const spy of spies) spy.mockRestore();
          Logger.overrideLogger(new Logger());
        }

        const output = captured.join('\n');
        // The flow did log: actions, ids and counts reached the capture.
        expect(output).toContain('order-import-upload');
        expect(output).toContain('order-import-start');
        const leaked = [
          ...markers.phones,
          ...markers.names,
          ...markers.addresses,
          markers.fileName,
          'pii-marker',
        ].filter((marker) => output.includes(marker));
        expect(leaked).toEqual([]);
      });
    });

    describe('retention purge (US-04.6-09)', () => {
      const purge = new OrderImportPurgeService(repository);
      const DAY = 24 * HOUR;

      /** A committed batch whose commit is `days` old, rows still holding data. */
      async function committedDaysAgo(days: number, rowCount = 3) {
        const source = await createSource();
        const batchId = await committingBatch(
          source,
          Array.from({ length: rowCount }, (_, index) => `R${days}-${index}`),
        );
        await runCommit(source, batchId);
        await client`
          UPDATE order_import_rows
          SET raw = jsonb_build_object('phone', '01098765431', 'name', 'Zubaydah')
          WHERE batch_id = ${batchId}`;
        await client`
          UPDATE order_import_batches
          SET status = 'completed',
              committed_at = ${new Date(NOW.getTime() - days * DAY).toISOString()}
          WHERE id = ${batchId}`;
        return batchId;
      }

      async function rowsOf(batchId: string) {
        return client<
          {
            row_number: number;
            raw: unknown;
            normalized: unknown;
            outcome: string;
            issues: unknown;
            order_id: string | null;
          }[]
        >`
          SELECT row_number, raw, normalized, outcome, issues, order_id
          FROM order_import_rows WHERE batch_id = ${batchId}
          ORDER BY row_number`;
      }

      it('clears raw and normalized on day 91 but not on day 89, keeping outcome, issues, order and row number', async () => {
        const recent = await committedDaysAgo(89);
        const old = await committedDaysAgo(91);
        const before = await rowsOf(old);

        await purge.run(NOW);

        const kept = await rowsOf(recent);
        expect(kept.every((row) => row.raw !== null)).toBe(true);
        expect(kept.every((row) => row.normalized !== null)).toBe(true);
        const purged = await rowsOf(old);
        expect(purged).toEqual(
          before.map((row) => ({ ...row, raw: null, normalized: null })),
        );
        expect(purged.every((row) => row.outcome === 'imported')).toBe(true);
        expect(purged.every((row) => row.order_id !== null)).toBe(true);
        // The orders themselves are untouched: retention is the import copy.
        const [orders] = await client<{ count: number }[]>`
          SELECT count(*)::int AS count FROM orders
          WHERE id IN (SELECT order_id FROM order_import_rows WHERE batch_id = ${old})`;
        expect(orders.count).toBe(3);
      });

      it('is idempotent: a second run the same day purges nothing and does not fail', async () => {
        const old = await committedDaysAgo(120);

        const first = await purge.run(NOW);
        expect(first.rowsPurged).toBeGreaterThanOrEqual(3);
        const snapshot = await rowsOf(old);
        await expect(purge.run(NOW)).resolves.toEqual({
          draftsDeleted: 0,
          rowsPurged: 0,
        });
        expect(await rowsOf(old)).toEqual(snapshot);
      });

      it('works through more than one 1,000-row statement', async () => {
        const source = await createSource();
        const draft = await repository.createDraftWithRows(
          batch(source),
          rows(2_345),
          options,
        );
        await client`
          UPDATE order_import_batches
          SET status = 'completed', committed_at = ${new Date(NOW.getTime() - 100 * DAY).toISOString()}
          WHERE id = ${draft.batchId}`;

        const result = await purge.run(NOW);

        expect(result.rowsPurged).toBeGreaterThanOrEqual(2_345);
        const [left] = await client<{ count: number }[]>`
          SELECT count(*)::int AS count FROM order_import_rows
          WHERE batch_id = ${draft.batchId} AND (raw IS NOT NULL OR normalized IS NOT NULL)`;
        expect(left.count).toBe(0);
      });

      it('purges a batch that failed mid-commit once its last update is 90 days old', async () => {
        const source = await createSource();
        const draft = await repository.createDraftWithRows(
          batch(source),
          rows(2),
          options,
        );
        await client`
          UPDATE order_import_batches
          SET status = 'failed', updated_at = ${new Date(NOW.getTime() - 91 * DAY).toISOString()}
          WHERE id = ${draft.batchId}`;

        await purge.run(NOW);

        expect(
          (await rowsOf(draft.batchId)).every((row) => row.raw === null),
        ).toBe(true);
      });

      it('deletes expired drafts with their rows, and nothing else', async () => {
        const source = await createSource();
        const expired = await repository.createDraftWithRows(
          batch(source, { expiresAt: new Date(NOW.getTime() - HOUR) }),
          rows(2),
          options,
        );
        const live = await repository.createDraftWithRows(
          batch(source, { fileSha256: 'b'.repeat(64) }),
          rows(2),
          options,
        );
        const committed = await committedDaysAgo(1);

        const result = await purge.run(NOW);

        expect(result.draftsDeleted).toBeGreaterThanOrEqual(1);
        const remaining = await client<{ id: string }[]>`
          SELECT id FROM order_import_batches
          WHERE id IN (${expired.batchId}, ${live.batchId}, ${committed})`;
        expect(remaining.map((row) => row.id).sort()).toEqual(
          [live.batchId, committed].sort(),
        );
        const [orphans] = await client<{ count: number }[]>`
          SELECT count(*)::int AS count FROM order_import_rows
          WHERE batch_id = ${expired.batchId}`;
        expect(orphans.count).toBe(0);
        expect(await rowsOf(live.batchId)).toHaveLength(2);
      });
    });
  });
});
