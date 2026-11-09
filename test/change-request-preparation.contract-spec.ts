import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { eq, SQL } from 'drizzle-orm';
import * as schema from '../src/infrastructure/database/schema';
import * as relations from '../src/infrastructure/database/relations';
import { ChangeRequestPreparationRepository } from '../src/infrastructure/database/repositories/change-request-preparation.repository';
import { AdminChangePreparationService } from '../src/modules/admin/admin-change-preparation.service';
import {
  WhatsappTemplateDraftsRepository,
  toDraftContent,
} from '../src/infrastructure/database/repositories/whatsapp-template-drafts.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { describeMetaComponents } from '../src/infrastructure/spokes/meta/meta-template-text';
import {
  toTemplateSubmission,
  validateTemplateDraft,
} from '../src/shared/messaging/template-draft.validation';

const url = process.env.E045_TEST_DATABASE_URL;
if (
  !url ||
  !/^postgresql:\/\/e045_test:[^@]+@127\.0\.0\.1:\d+\/akeed_e045_test$/.test(
    url,
  )
)
  throw new Error(
    'Disposable local E045_TEST_DATABASE_URL required; no application database configuration is read.',
  );
const client = postgres(url, { max: 4, onnotice: () => undefined });
const db = drizzle(client, { schema: { ...schema, ...relations } });
const repository = new ChangeRequestPreparationRepository(db);
const service = new AdminChangePreparationService(repository, {
  describeComponents: describeMetaComponents,
} as never);
const drafts = new WhatsappTemplateDraftsRepository(db);
const templates = new WhatsappTemplatesRepository(db);
const operator = randomUUID();
const snapshot = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      'fixtures/change-request-preparation/production-before.json',
    ),
    'utf8',
  ),
) as {
  templates: Record<string, unknown>[];
  drafts: Record<string, unknown>[];
  journal: { id: number; hash: string; created_at: number }[];
};

async function scaffold(table: PgTable, excluded: string[]) {
  const dialect = new PgDialect();
  const definition = getTableConfig(table);
  const columns = definition.columns
    .filter((c) => !excluded.includes(c.name))
    .map((column) => {
      let text = `"${column.name}" ${column.getSQLType()}`;
      if (column.notNull) text += ' not null';
      if (column.primary) text += ' primary key';
      if (column.default !== undefined)
        text +=
          ' default ' +
          (column.default instanceof SQL
            ? dialect.sqlToQuery(column.default).sql
            : typeof column.default === 'string'
              ? `'${column.default}'`
              : typeof column.default === 'object'
                ? `'${JSON.stringify(column.default)}'::jsonb`
                : JSON.stringify(column.default));
      return text;
    });
  await client.unsafe(
    `create table "${definition.name}" (${columns.join(',')})`,
  );
}

beforeAll(async () => {
  await client.unsafe(`create extension if not exists "uuid-ossp"; create schema drizzle; create table drizzle.__drizzle_migrations(id serial primary key, hash text not null, created_at bigint);
    create type verification_dispatch_kind as enum ('initial','follow_up','acknowledgment');
    create table verifications(id uuid primary key);
    create table verification_message_dispatches(id uuid primary key);
    create table credit_reservations(id uuid primary key,kind text, constraint credit_reservations_kind_check check(kind in ('initial','follow_up','acknowledgment')));`);
  await scaffold(schema.whatsappTemplates, ['change_request_of_key']);
  await scaffold(schema.whatsappTemplateDrafts, [
    'change_label',
    'change_request_of_key',
  ]);
  await scaffold(schema.adminAccessAudit, []);
  await client.unsafe(`create unique index templates_key on whatsapp_templates(key);
    create unique index templates_identity on whatsapp_templates(meta_template_name,meta_language_code);
    create unique index drafts_key on whatsapp_template_drafts(key);
    create unique index drafts_identity on whatsapp_template_drafts(meta_template_name,meta_language_code);`);
  for (const row of snapshot.templates) {
    const values = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value && typeof value === 'object' ? JSON.stringify(value) : value,
      ]),
    );
    await client`insert into whatsapp_templates ${client(values as never)}`;
  }
  for (const row of snapshot.drafts) {
    const [parent] = await client<
      { id: string }[]
    >`select id from whatsapp_templates where key=${String(row.key)}`;
    const values = {
      ...row,
      template_id: parent.id,
      created_by: operator,
      updated_by: operator,
    };
    await client`insert into whatsapp_template_drafts ${client(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value && typeof value === 'object' ? JSON.stringify(value) : value])) as never)}`;
  }
  for (const row of snapshot.journal)
    await client`insert into drizzle.__drizzle_migrations ${client(row)}`;
  // Match the serial sequence after restoring a synthetic journal.
  await client`select setval('drizzle.__drizzle_migrations_id_seq',(select max(id) from drizzle.__drizzle_migrations))`;
}, 60_000);
afterAll(async () => {
  await client.end();
});

it('applies only original 0093, prepares all 23 production counterparts from provider text, and preserves all 46 templates', async () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../.tmp/change-request-production/prepare-through-0093.sql',
    ),
    'utf8',
  );
  await client.begin(async (tx) => {
    await tx.unsafe(sql);
  });
  const page = await service.overview();
  expect(page.variants).toHaveLength(23);
  expect(
    page.variants.every(
      (v) =>
        v.state === 'draft' && v.validation?.valid && v.content?.changeLabel,
    ),
  ).toBe(true);
  expect(
    page.variants.find((v) => v.parent_key === 'cod_confirm.ar.egyptian')
      ?.content?.confirmLabel,
  ).toBe('تأكيد الطلب');
  for (const variant of page.variants) {
    const reviewed = JSON.parse(
      readFileSync(
        resolve(__dirname, '../.tmp/change-request-production/review.json'),
        'utf8',
      ),
    ) as { variants: { parentKey: string; content: { body: string } }[] };
    expect(variant.content!.body).toBe(
      reviewed.variants.find((v) => v.parentKey === variant.parent_key)!.content
        .body,
    );
    expect(toTemplateSubmission(variant.content!).buttons).toHaveLength(3);
    expect(variant.image_twin.state).toBe('planned');
  }
  const [unchanged] =
    await client`select jsonb_agg(to_jsonb(t)-'id'-'change_request_of_key' order by key) as rows from whatsapp_templates t`;
  expect(unchanged.rows).toEqual(snapshot.templates);
  const [journal] =
    await client`select max(created_at)::text as latest from drizzle.__drizzle_migrations`;
  expect(journal.latest).toBe('1794960000000');
  const [later] =
    await client`select count(*)::int as count from information_schema.columns where table_schema='public' and table_name='verification_change_requests' and column_name='reconfirmation_state'`;
  expect(later.count).toBe(0);
  await expect(
    client.begin(async (tx) => {
      await tx.unsafe(sql);
    }),
  ).rejects.toThrow('CHANGE_PREPARATION_JOURNAL_CHANGED');
}, 60_000);

it('repeated and concurrent preparation preserve drafts, edits, pending and uncertain records without new identities', async () => {
  const page = await service.overview();
  const target = page.variants[0];
  const before = await drafts.findById(target.draft_id!);
  await drafts.update(
    before!.id,
    { body: before!.body + '\nOperator note.' },
    { userId: operator, action: 'synthetic-edit' },
  );
  for (const [index, state] of ['submitting', 'submit_unknown'].entries())
    await db
      .update(schema.whatsappTemplateDrafts)
      .set({ state: state as 'submitting' | 'submit_unknown' })
      .where(
        eq(
          schema.whatsappTemplateDrafts.id,
          page.variants[index + 1].draft_id!,
        ),
      );
  const results = await Promise.all([
    service.prepare(operator),
    service.prepare(operator),
  ]);
  expect(
    results.every(
      (r) =>
        r.results.length === 23 &&
        r.results.every((v) => v.outcome === 'reused'),
    ),
  ).toBe(true);
  expect((await drafts.findById(before!.id))?.body).toBe(
    before!.body + '\nOperator note.',
  );
  expect(
    (await db.select().from(schema.whatsappTemplateDrafts)).filter(
      (d) => d.changeRequestOfKey,
    ),
  ).toHaveLength(23);
});

it('keeps fixed labels mandatory and positional samples intact through real repository saves', async () => {
  const page = await service.overview();
  const variant = page.variants.find(
    (v) => v.parent_key === 'cod_confirm.en.short',
  )!;
  const row = (await drafts.findById(variant.draft_id!))!;
  const content = toDraftContent(row);
  expect(content.parameterFormat).toBe('positional');
  expect(toTemplateSubmission(content).samples.map((v) => v.parameter)).toEqual(
    ['1', '2'],
  );
  expect(
    validateTemplateDraft(
      { ...content, changeLabel: null },
      { takenIdentities: new Set() },
    ).valid,
  ).toBe(false);
  expect(
    validateTemplateDraft(
      { ...content, changeLabel: 'Customize' },
      { takenIdentities: new Set() },
    ).valid,
  ).toBe(false);
});

it('registers a distinct inactive image twin with derived change capability', async () => {
  const [draft] = await db
    .select()
    .from(schema.whatsappTemplateDrafts)
    .where(
      eq(
        schema.whatsappTemplateDrafts.changeRequestOfKey,
        'cod_confirm.en.short',
      ),
    );
  const [parent] = await db
    .select()
    .from(schema.whatsappTemplates)
    .where(eq(schema.whatsappTemplates.key, 'cod_confirm.en.short'));
  const content = toDraftContent(draft);
  await db.insert(schema.whatsappTemplates).values({
    ...parent,
    id: randomUUID(),
    key: draft.key,
    style: draft.style + '_v1',
    metaTemplateName: draft.metaTemplateName,
    changeRequestOfKey: parent.key,
    isDefault: false,
    isActive: false,
    preview: { ...parent.preview, changeButton: content.changeLabel! },
  });
  expect(
    await templates.registerImageTwin(draft.key, {
      templateName: draft.metaTemplateName + '_logo',
      providerTemplateId: null,
      reviewStatus: null,
      category: null,
    }),
  ).toBe('registered');
  expect(
    await templates.registerImageTwin(draft.key, {
      templateName: draft.metaTemplateName + '_logo',
      providerTemplateId: null,
      reviewStatus: null,
      category: null,
    }),
  ).toBe('already_registered');
  const twin = (await templates.findImageTwins()).find(
    (t) => t.imageTwinOfKey === draft.key,
  )!;
  expect(twin.changeRequestOfKey).toBe(parent.key);
  expect(twin.isActive).toBe(false);
  expect((await templates.findAll()).some((t) => t.key === twin.key)).toBe(
    false,
  );
});

it('prepares a new draft-only language/style through the same repositories without submitting it', async () => {
  const source = await drafts.create(
    {
      purpose: 'cod_confirmation',
      language: 'tr',
      style: 'fresh',
      languageCode: 'tr',
      parameterFormat: 'named',
      category: 'utility',
      body: 'Merhaba {{customer}}, lütfen bu yeni siparişi onaylayın.',
      confirmLabel: 'Onayla',
      cancelLabel: 'İptal et',
      samples: { customer: 'Ayşe' },
    },
    { userId: operator, action: 'synthetic-source' },
  );
  expect(source).not.toBeNull();
  const result = await service.prepare(operator);
  expect(
    result.results.find((v) => v.parent_key === source!.key)?.outcome,
  ).toBe('created');
  const page = await service.overview();
  const prepared = page.variants.find((v) => v.parent_key === source!.key)!;
  expect(prepared.content?.changeLabel).toBe('Değişiklik iste');
  expect(prepared.state).toBe('draft');
  expect(prepared.review_status).toBeNull();
});
