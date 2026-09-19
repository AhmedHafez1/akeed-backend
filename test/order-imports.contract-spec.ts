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
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
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
    `);
    // Layer the real migration on the hand-written base, twice, to prove it is
    // re-runnable and ships exactly the constraints the repository relies on.
    for (let pass = 0; pass < 2; pass++) {
      for (const migration of [
        '0037_order_import_batches.sql',
        '0038_order_import_validation_version.sql',
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
        }[]
      >`
        SELECT row_number, outcome, issues, include_override, dedupe_key, collapsed_into
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
        counts: { total: 7, ready: 3, invalid: 1, duplicate: 1, excluded: 2 },
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
});
