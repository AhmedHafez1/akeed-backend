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
  type NewImportRow,
} from '../src/infrastructure/database/repositories/order-imports.repository';
import { generateShortCode } from '../src/modules/order-imports/short-code';

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
        UNIQUE (platform_type, platform_store_url),
        UNIQUE (id, org_id)
      );
    `);
    // Layer the real migration on the hand-written base, twice, to prove it is
    // re-runnable and ships exactly the constraints the repository relies on.
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of readFileSync(
        resolve(__dirname, '../drizzle/0037_order_import_batches.sql'),
        'utf8',
      ).split('--> statement-breakpoint')) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
    await client.unsafe(`
      GRANT USAGE ON SCHEMA ${namespace} TO authenticated;
      GRANT SELECT ON order_import_batches, order_import_rows, order_import_mapping_profiles TO authenticated;
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
        AND tablename IN ('order_import_batches', 'order_import_rows', 'order_import_mapping_profiles')
        AND qual = '(org_id = get_user_org_id())'`;
    expect(policies.count).toBe(3);
  });
});
