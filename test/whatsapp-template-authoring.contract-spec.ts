import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { WhatsappTemplateDraftsRepository } from '../src/infrastructure/database/repositories/whatsapp-template-drafts.repository';
import { WhatsappTemplateLifecycleRepository } from '../src/infrastructure/database/repositories/whatsapp-template-lifecycle.repository';
import { WhatsappTemplateSyncRepository } from '../src/infrastructure/database/repositories/whatsapp-template-sync.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { MetaTemplateCatalogAdapter } from '../src/infrastructure/spokes/meta/meta-template-catalog.adapter';
import { MetaTemplateWebhookHandler } from '../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { AdminTemplateDraftService } from '../src/modules/admin/admin-template-draft.service';
import { AdminTemplateLifecycleService } from '../src/modules/admin/admin-template-lifecycle.service';
import type { AdminTemplateDraftDto } from '../src/modules/admin/dto/admin-template-authoring.dto';
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
 * US-08-06 against real PostgreSQL: migration 0058, drafts and their
 * submission, and the activate, set-default, deactivate, retire and edit
 * actions, with the locking and the audit rows they depend on.
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

const namespace = `e08_template_authoring_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
let created = false;

const MIGRATIONS = [
  '0054_whatsapp_templates_registry.sql',
  '0055_integration_template_keys.sql',
  '0056_dispatch_template_fallback.sql',
  '0057_whatsapp_template_sync.sql',
  '0058_whatsapp_template_authoring.sql',
];
const AUTHORING_MIGRATION = '0058_whatsapp_template_authoring.sql';

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

/** The rollback written in the 0058 header, as one script. */
function rollbackStatements(): string {
  const header = readFileSync(
    resolve(__dirname, '../drizzle', AUTHORING_MIGRATION),
    'utf8',
  );
  const start = header.indexOf('--   DROP TABLE');
  const end = header.indexOf('-- Registry rows created from drafts');
  return header
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^--\s{3}/, '').replace(/^--\s+/, ' '))
    .join('\n');
}

const OPERATOR: string = randomUUID();
const SECOND_OPERATOR: string = randomUUID();
const BODY =
  'Hello {{customer}}, thank you for your order {{order}} from {{store}}. It comes to {{total}} in all, paid on delivery.';
const TEXT_MARKERS = [
  'Hello',
  'thank you',
  'Confirm order',
  'Cancel order',
  'Ahmed',
];

const configValues: Record<string, unknown> = {
  WA_ACCESS_TOKEN: FAKE_TOKEN,
  NODE_ENV: 'test',
  whatsappTemplates: parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
    WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
  }),
};
const configService = { get: (key: string) => configValues[key] };
const api = new FakeMetaTemplateApi();
const catalog = new MetaTemplateCatalogAdapter(
  api.httpService as never,
  configService as never,
);
const draftsRepository = new WhatsappTemplateDraftsRepository(database);
const lifecycleRepository = new WhatsappTemplateLifecycleRepository(database);
const syncRepository = new WhatsappTemplateSyncRepository(database);
const registryRepository = new WhatsappTemplatesRepository(database);
const registry = {
  listTemplates: () => registryRepository.findAll(),
  invalidate: jest.fn(),
};
const drafts = new AdminTemplateDraftService(
  draftsRepository,
  catalog,
  registry,
  configService as never,
);
const lifecycle = new AdminTemplateLifecycleService(
  lifecycleRepository,
  catalog,
  registry,
);
const alerts = new TemplateAlertService(syncRepository);
const syncService = new WhatsappTemplateSyncService(
  syncRepository,
  catalog,
  registry,
  alerts,
  configService as never,
);
const statusService = new TemplateStatusService(
  syncRepository,
  registry,
  alerts,
  { requestSyncSoon: jest.fn().mockResolvedValue(undefined) } as never,
);
const webhook = new MetaTemplateWebhookHandler(
  configService as never,
  statusService,
);

function dto(
  overrides: Partial<AdminTemplateDraftDto> = {},
): AdminTemplateDraftDto {
  return {
    purpose: 'cod_confirmation',
    language: 'ar',
    style: 'warm',
    language_code: 'ar',
    parameter_format: 'named',
    body: BODY,
    confirm_label: 'Confirm order',
    cancel_label: 'Cancel order',
    samples: {
      customer: 'Ahmed',
      store: 'Akeed Store',
      order: 'TEST-1',
      total: '250.00 USD',
    },
    ...overrides,
  };
}

interface TemplateState {
  key: string;
  is_active: boolean;
  is_default: boolean;
  review_status: string | null;
  retired_at: string | null;
  rejection_reason: string | null;
  meta_template_id: string | null;
}

async function template(key: string): Promise<TemplateState> {
  const [found] = await client<TemplateState[]>`
    SELECT "key", is_active, is_default, review_status, retired_at,
      rejection_reason, meta_template_id
    FROM whatsapp_templates WHERE "key" = ${key}`;
  return found;
}

async function defaults(language: string): Promise<string[]> {
  const rows = await client<{ key: string }[]>`
    SELECT "key" FROM whatsapp_templates
    WHERE purpose = 'cod_confirmation' AND language = ${language} AND is_default`;
  return rows.map((row) => row.key);
}

async function setStatus(key: string, status: string | null): Promise<void> {
  await client`
    UPDATE whatsapp_templates SET review_status = ${status} WHERE "key" = ${key}`;
}

async function insertStore(store: {
  arKey?: string | null;
  arVariant?: string;
  active?: boolean;
}): Promise<string> {
  const [inserted] = await client<{ id: string }[]>`
    INSERT INTO integrations (cod_template_ar_key, cod_template_ar_variant, is_active)
    VALUES (${store.arKey ?? null}, ${store.arVariant ?? 'standard'}, ${store.active ?? true})
    RETURNING id`;
  return inserted.id;
}

async function store(id: string) {
  const [found] = await client<
    {
      cod_template_ar_key: string | null;
      cod_template_ar_variant: string;
      cod_template_en_key: string | null;
    }[]
  >`
    SELECT cod_template_ar_key, cod_template_ar_variant, cod_template_en_key
    FROM integrations WHERE id = ${id}`;
  return found;
}

async function audits(action?: string) {
  return client<
    {
      user_id: string;
      action: string;
      outcome: string;
      request_id: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT user_id, action, outcome, request_id, metadata
    FROM admin_access_audit
    WHERE ${action ?? null}::text IS NULL OR action = ${action ?? null}
    ORDER BY created_at, id`;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A submitted draft whose registry row the provider has approved. */
async function approvedTemplate(style: string): Promise<string> {
  const { draft } = await drafts.create(OPERATOR, dto({ style }));
  const submitted = await drafts.submit(OPERATOR, draft.id);
  const key = submitted.draft.template_key!;
  await setStatus(key, 'approved');
  return key;
}

describe('WhatsApp template authoring against PostgreSQL (US-08-06)', () => {
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
        cod_template_ar_variant text DEFAULT 'standard' NOT NULL
          CHECK (cod_template_ar_variant IN ('standard', 'egyptian', 'gulf', 'short')),
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL
          CHECK (cod_template_en_variant IN ('friendly', 'professional', 'direct', 'short')),
        updated_at timestamp with time zone DEFAULT now()
      );
      CREATE TABLE verification_message_dispatches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE admin_access_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid,
        action text NOT NULL,
        outcome text NOT NULL,
        request_id text,
        target_integration_id uuid,
        metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamp with time zone DEFAULT now()
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

  describe('0058', () => {
    it('adds the draft and edit tables, service-role only, and two registry columns', async () => {
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${namespace} AND table_name = 'whatsapp_templates'
          AND column_name IN ('retired_at', 'rejection_reason')`;
      expect(columns).toHaveLength(2);
      const secured = await client<
        { relname: string; relrowsecurity: boolean }[]
      >`
        SELECT c.relname, c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${namespace}
          AND c.relname IN ('whatsapp_template_drafts', 'whatsapp_template_edits')
        ORDER BY c.relname`;
      expect(secured).toEqual([
        { relname: 'whatsapp_template_drafts', relrowsecurity: true },
        { relname: 'whatsapp_template_edits', relrowsecurity: true },
      ]);
      const policies = await client<{ tablename: string; roles: string[] }[]>`
        SELECT tablename, roles FROM pg_policies
        WHERE schemaname = ${namespace}
          AND tablename IN ('whatsapp_template_drafts', 'whatsapp_template_edits')
        ORDER BY tablename`;
      expect(
        policies.map((policy) => [policy.tablename, String(policy.roles)]),
      ).toEqual([
        ['whatsapp_template_drafts', 'service_role'],
        ['whatsapp_template_edits', 'service_role'],
      ]);
      const grants = await client<{ grantee: string }[]>`
        SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema = ${namespace}
          AND table_name IN ('whatsapp_template_drafts', 'whatsapp_template_edits')
          AND grantee IN ('anon', 'authenticated', 'PUBLIC')`;
      expect(grants).toHaveLength(0);
    });

    it('replays as a no-op and writes no row', async () => {
      await migrate(AUTHORING_MIGRATION);

      const [counts] = await client<{ drafts: number; changed: number }[]>`
        SELECT (SELECT count(*)::int FROM whatsapp_template_drafts) AS drafts,
          (SELECT count(*)::int FROM whatsapp_templates
            WHERE retired_at IS NOT NULL OR rejection_reason IS NOT NULL) AS changed`;
      expect(counts).toEqual({ drafts: 0, changed: 0 });
      await expect(registryRepository.findAll()).resolves.toHaveLength(8);
    });

    it('rolls back with the statements in its header and applies again', async () => {
      await client.unsafe(rollbackStatements());

      const tables = await client<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${namespace}
          AND c.relname IN ('whatsapp_template_drafts', 'whatsapp_template_edits')`;
      expect(tables).toHaveLength(0);
      // The send path reads only 0054 columns, so it still works.
      await expect(registryRepository.findAll()).resolves.toHaveLength(8);

      await migrate(AUTHORING_MIGRATION);
    });

    it('refuses a draft state the application does not know and a submitted draft with no template', async () => {
      const insert = (state: string) =>
        client`
          INSERT INTO whatsapp_template_drafts ("key", purpose, language, style, version,
            meta_template_name, meta_language_code, parameter_format, category, body,
            confirm_label, cancel_label, state, created_by, updated_by)
          VALUES (${`cod_confirm.ar.check_${state}_v1`}, 'cod_confirmation', 'ar', 'check', 1,
            ${`akeed_cod_confirm_check_${state}_v1`}, 'ar', 'named', 'utility', 'x',
            'a', 'b', ${state}, ${OPERATOR}, ${OPERATOR})`;

      await expect(insert('archived')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('submitted')).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  describe('drafts and submission', () => {
    it('gives concurrent drafts of one style distinct names, never the same one', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          drafts.create(OPERATOR, dto({ style: 'race' })),
        ),
      );

      const made = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.draft.template_name] : [],
      );
      expect(made.length).toBeGreaterThanOrEqual(1);
      expect(new Set(made).size).toBe(made.length);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(
            ((result.reason as HttpException).getResponse() as { code: string })
              .code,
          ).toBe('WHATSAPP_TEMPLATE_DRAFT_NAME_TAKEN');
        }
      }
      const stored = await client<{ name: string }[]>`
        SELECT meta_template_name AS name FROM whatsapp_template_drafts
        WHERE style = 'race'`;
      expect(stored.map((row) => row.name).sort()).toEqual([...made].sort());
    });

    it('keeps a draft out of the registry until the provider holds it', async () => {
      const { draft } = await drafts.create(OPERATOR, dto({ style: 'local' }));

      expect(await template(draft.key)).toBeUndefined();
      await expect(registryRepository.findAll()).resolves.toHaveLength(8);
    });

    it('sends one create for many submits at once, and inserts one inactive registry row', async () => {
      const { draft } = await drafts.create(OPERATOR, dto({ style: 'once' }));
      const before = api.writes.length;

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => drafts.submit(OPERATOR, draft.id)),
      );

      expect(api.writes.length - before).toBe(1);
      const outcomes = results.map((result) =>
        result.status === 'fulfilled'
          ? result.value.outcome
          : ((result.reason as HttpException).getResponse() as { code: string })
              .code,
      );
      expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(
        1,
      );
      expect(
        outcomes.every((outcome) =>
          [
            'created',
            'already_submitted',
            'WHATSAPP_TEMPLATE_SUBMIT_IN_PROGRESS',
          ].includes(outcome),
        ),
      ).toBe(true);
      expect(await template(draft.key)).toMatchObject({
        is_active: false,
        is_default: false,
        review_status: 'pending',
        meta_template_id: expect.stringMatching(/^\d+$/) as string,
      });
      const [rows] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM whatsapp_templates
        WHERE meta_template_name = ${draft.template_name}`;
      expect(rows.count).toBe(1);
    });

    it('audits the submit with the provider reference and no template text', async () => {
      const submits = await audits('whatsapp-templates.submit');

      expect(submits.length).toBeGreaterThanOrEqual(1);
      expect(submits.at(-1)).toMatchObject({
        user_id: OPERATOR,
        outcome: 'allowed',
        metadata: {
          version: 1,
          templateKey: 'cod_confirm.ar.once_v1',
          outcome: 'created',
          providerReference: expect.stringMatching(/^\d+$/) as string,
        },
      });
      const everything = JSON.stringify(await audits());
      for (const marker of TEXT_MARKERS)
        expect(everything).not.toContain(marker);
    });

    it('does not change what a store sends: the new row is inactive and never a default', async () => {
      const templates = await registryRepository.findAll();

      expect(await defaults('ar')).toEqual(['cod_confirm.ar.standard']);
      const selection = selectTemplateForSend(templates, {
        preferredLanguage: 'ar',
        phoneNumber: '+201001234567',
        arKey: 'cod_confirm.ar.once_v1',
        guardrail: { enabled: false },
      });
      expect(selection).toMatchObject({
        template: { variantKey: 'ar.standard' },
        fallbackReason: 'key_inactive',
      });
    });

    it('resolves a lost answer by reading the provider, without a second create', async () => {
      const { draft } = await drafts.create(OPERATOR, dto({ style: 'lost' }));
      const before = api.writes.length;
      api.failNextWrite({ kind: 'applied_then_lost' });

      expect(await codeOf(drafts.submit(OPERATOR, draft.id))).toBe(
        'WHATSAPP_TEMPLATE_SUBMIT_UNRESOLVED',
      );
      expect(await template(draft.key)).toBeUndefined();
      expect(await codeOf(drafts.submit(OPERATOR, draft.id))).toBe(
        'WHATSAPP_TEMPLATE_SUBMIT_UNRESOLVED',
      );

      const checked = await drafts.reconcile(OPERATOR, draft.id);

      expect(checked.outcome).toBe('adopted');
      expect(api.writes.length - before).toBe(1);
      expect(await template(draft.key)).toMatchObject({
        is_active: false,
        review_status: 'pending',
      });
    });

    it('follows review through sync and the status webhook, with the rejection reason', async () => {
      const { draft } = await drafts.create(OPERATOR, dto({ style: 'review' }));
      await drafts.submit(OPERATOR, draft.id);
      const listed = api.templates.find(
        (entry) => entry.name === draft.template_name,
      )!;
      listed.status = 'REJECTED';
      listed.rejected_reason = 'INVALID_FORMAT';

      await expect(syncService.runSync('scheduled')).resolves.toMatchObject({
        outcome: 'succeeded',
      });

      expect(await template(draft.key)).toMatchObject({
        review_status: 'rejected',
        rejection_reason: 'invalid_format',
        is_active: false,
      });

      await webhook.handle(
        Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: FAKE_ACCOUNT_ID,
                time: Math.floor(Date.now() / 1000) + 60,
                changes: [
                  {
                    field: 'message_template_status_update',
                    value: {
                      event: 'APPROVED',
                      message_template_id: Number(listed.id),
                      message_template_name: draft.template_name,
                      message_template_language: 'ar',
                      reason: 'NONE',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );

      expect(await template(draft.key)).toMatchObject({
        review_status: 'approved',
        rejection_reason: 'none',
      });
    });
  });

  describe('activate and set default', () => {
    it('refuses to activate or default a template the provider has not approved', async () => {
      const { draft } = await drafts.create(
        OPERATOR,
        dto({ style: 'unapproved' }),
      );
      const { draft: submitted } = await drafts.submit(OPERATOR, draft.id);
      const key = submitted.template_key!;

      expect(
        await codeOf(
          lifecycle.act({ userId: OPERATOR, key, action: 'activate' }),
        ),
      ).toBe('WHATSAPP_TEMPLATE_NOT_APPROVED');
      expect(
        await codeOf(
          lifecycle.act({ userId: OPERATOR, key, action: 'set_default' }),
        ),
      ).toBe('WHATSAPP_TEMPLATE_NOT_APPROVED');
      expect(await template(key)).toMatchObject({
        is_active: false,
        is_default: false,
      });
    });

    it('activates an approved template and audits the flags before and after', async () => {
      const key = await approvedTemplate('active');

      await expect(
        lifecycle.act({
          userId: OPERATOR,
          key,
          action: 'activate',
          requestId: 'req-activate',
        }),
      ).resolves.toMatchObject({ changed: true, is_active: true });

      expect(await template(key)).toMatchObject({ is_active: true });
      expect(await audits('whatsapp-templates.activate')).toEqual([
        {
          user_id: OPERATOR,
          action: 'whatsapp-templates.activate',
          outcome: 'allowed',
          request_id: 'req-activate',
          metadata: {
            version: 1,
            templateKey: key,
            before: { is_active: false, is_default: false, retired: false },
            after: { is_active: true, is_default: false, retired: false },
            replacementKey: null,
            movedStores: 0,
            changedKeys: [key],
          },
        },
      ]);
    });

    it('swaps the default in one transaction: the old one is unset, the new one set', async () => {
      const key = 'cod_confirm.ar.active_v1';
      await setStatus('cod_confirm.ar.standard', 'approved');

      await expect(
        lifecycle.act({ userId: OPERATOR, key, action: 'set_default' }),
      ).resolves.toMatchObject({ changed: true, is_default: true });

      expect(await defaults('ar')).toEqual([key]);
      expect(await defaults('en')).toEqual(['cod_confirm.en.friendly']);
      const [swap] = await audits('whatsapp-templates.set-default');
      expect(swap.metadata).toMatchObject({
        templateKey: key,
        before: { is_default: false },
        after: { is_default: true },
        changedKeys: [key, 'cod_confirm.ar.standard'].sort(),
      });
    });

    it('keeps exactly one default under concurrent default changes by two operators', async () => {
      const candidates = [
        'cod_confirm.ar.standard',
        'cod_confirm.ar.active_v1',
        await approvedTemplate('rival'),
      ];
      await lifecycle.act({
        userId: OPERATOR,
        key: candidates[2],
        action: 'activate',
      });

      for (let round = 0; round < 3; round += 1) {
        const results = await Promise.allSettled(
          Array.from({ length: 9 }, (_, index) =>
            lifecycle.act({
              userId: index % 2 === 0 ? OPERATOR : SECOND_OPERATOR,
              key: candidates[(index + round) % candidates.length],
              action: 'set_default',
            }),
          ),
        );

        // No request loses to the unique index: each waits its turn.
        expect(results.map((result) => result.status)).toEqual(
          Array.from({ length: 9 }, () => 'fulfilled'),
        );
        const now = await defaults('ar');
        expect(now).toHaveLength(1);
        expect(candidates).toContain(now[0]);
      }
      expect(await defaults('en')).toEqual(['cod_confirm.en.friendly']);
    });
  });

  describe('deactivate and retire', () => {
    it('refuses to retire a template a store sends when no replacement is named', async () => {
      await lifecycle.act({
        userId: OPERATOR,
        key: 'cod_confirm.ar.standard',
        action: 'set_default',
      });
      await setStatus('cod_confirm.ar.egyptian', 'approved');
      const storeId = await insertStore({ arKey: 'cod_confirm.ar.egyptian' });
      const before = (await audits()).length;

      for (const action of ['retire', 'deactivate'] as const) {
        expect(
          await codeOf(
            lifecycle.act({
              userId: OPERATOR,
              key: 'cod_confirm.ar.egyptian',
              action,
            }),
          ),
        ).toBe('WHATSAPP_TEMPLATE_REPLACEMENT_REQUIRED');
      }

      expect(await template('cod_confirm.ar.egyptian')).toMatchObject({
        is_active: true,
        retired_at: null,
      });
      expect((await store(storeId)).cod_template_ar_key).toBe(
        'cod_confirm.ar.egyptian',
      );
      // A refused action writes nothing, the audit row included.
      expect((await audits()).length).toBe(before);
    });

    it('refuses a replacement that is not approved and active in the same language', async () => {
      await setStatus('cod_confirm.ar.gulf', 'paused');

      for (const replacementKey of [
        'cod_confirm.ar.gulf',
        'cod_confirm.en.friendly',
        'cod_confirm.ar.egyptian',
        'cod_confirm.ar.nothing',
      ]) {
        expect(
          await codeOf(
            lifecycle.act({
              userId: OPERATOR,
              key: 'cod_confirm.ar.egyptian',
              action: 'retire',
              replacementKey,
            }),
          ),
        ).toBe('WHATSAPP_TEMPLATE_REPLACEMENT_INVALID');
      }
      expect(await template('cod_confirm.ar.egyptian')).toMatchObject({
        is_active: true,
      });
    });

    it('retires with a replacement: every store moves and the template is retired, in one transaction', async () => {
      const keyed = await insertStore({ arKey: 'cod_confirm.ar.egyptian' });
      // No stored key: read from the old variant column, like a send.
      const legacy = await insertStore({ arKey: null, arVariant: 'egyptian' });
      const inactive = await insertStore({
        arKey: 'cod_confirm.ar.egyptian',
        active: false,
      });
      const untouched = await insertStore({ arKey: 'cod_confirm.ar.short' });
      const replacementKey = 'cod_confirm.ar.active_v1';

      const impact = await lifecycle.impact('cod_confirm.ar.egyptian');
      expect(impact).toMatchObject({
        stores: { total: 4, active: 3 },
        requires_replacement: true,
      });
      expect(impact.replacements.map((entry) => entry.key)).toContain(
        replacementKey,
      );

      const result = await lifecycle.act({
        userId: OPERATOR,
        key: 'cod_confirm.ar.egyptian',
        action: 'retire',
        replacementKey,
        requestId: 'req-retire',
      });

      expect(result).toMatchObject({
        changed: true,
        is_active: false,
        retired: true,
        replacement_key: replacementKey,
        moved_stores: 4,
      });
      expect(await template('cod_confirm.ar.egyptian')).toMatchObject({
        is_active: false,
        is_default: false,
        retired_at: expect.anything() as string,
      });
      for (const id of [keyed, legacy, inactive]) {
        expect((await store(id)).cod_template_ar_key).toBe(replacementKey);
      }
      // The replacement is not one of the old column's values, so that column
      // stays as it was and still satisfies its CHECK.
      expect((await store(legacy)).cod_template_ar_variant).toBe('egyptian');
      expect((await store(untouched)).cod_template_ar_key).toBe(
        'cod_confirm.ar.short',
      );
      expect(await audits('whatsapp-templates.retire')).toEqual([
        {
          user_id: OPERATOR,
          action: 'whatsapp-templates.retire',
          outcome: 'allowed',
          request_id: 'req-retire',
          metadata: {
            version: 1,
            templateKey: 'cod_confirm.ar.egyptian',
            before: { is_active: true, is_default: false, retired: false },
            after: { is_active: false, is_default: false, retired: true },
            replacementKey,
            movedStores: 4,
            changedKeys: ['cod_confirm.ar.egyptian'],
          },
        },
      ]);
    });

    it('sets the old variant column too when the replacement is one of its values', async () => {
      await setStatus('cod_confirm.ar.short', 'approved');
      await setStatus('cod_confirm.ar.gulf', 'approved');
      const storeId = await insertStore({ arKey: null, arVariant: 'short' });

      await lifecycle.act({
        userId: OPERATOR,
        key: 'cod_confirm.ar.short',
        action: 'deactivate',
        replacementKey: 'cod_confirm.ar.gulf',
      });

      expect(await store(storeId)).toMatchObject({
        cod_template_ar_key: 'cod_confirm.ar.gulf',
        cod_template_ar_variant: 'gulf',
      });
      expect(await template('cod_confirm.ar.short')).toMatchObject({
        is_active: false,
        retired_at: null,
      });
    });

    it('hands the default to the replacement when the default itself is retired', async () => {
      expect(await defaults('ar')).toEqual(['cod_confirm.ar.standard']);
      expect(
        await codeOf(
          lifecycle.act({
            userId: OPERATOR,
            key: 'cod_confirm.ar.standard',
            action: 'retire',
          }),
        ),
      ).toBe('WHATSAPP_TEMPLATE_REPLACEMENT_REQUIRED');

      await lifecycle.act({
        userId: OPERATOR,
        key: 'cod_confirm.ar.standard',
        action: 'retire',
        replacementKey: 'cod_confirm.ar.gulf',
      });

      expect(await defaults('ar')).toEqual(['cod_confirm.ar.gulf']);
      expect(await template('cod_confirm.ar.standard')).toMatchObject({
        is_active: false,
        is_default: false,
      });
      // No store is left on a template that cannot be sent.
      const [stranded] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM integrations i
        JOIN whatsapp_templates t
          ON t."key" = COALESCE(i.cod_template_ar_key, 'cod_confirm.ar.' || i.cod_template_ar_variant)
        WHERE NOT t.is_active`;
      expect(stranded.count).toBe(0);
    });

    it('never brings a retired template back', async () => {
      for (const action of [
        'activate',
        'set_default',
        'deactivate',
        'retire',
      ] as const) {
        expect(
          await codeOf(
            lifecycle.act({
              userId: OPERATOR,
              key: 'cod_confirm.ar.egyptian',
              action,
            }),
          ),
        ).toBe('WHATSAPP_TEMPLATE_RETIRED');
      }
    });

    it('reactivates a template that was only deactivated', async () => {
      await expect(
        lifecycle.act({
          userId: OPERATOR,
          key: 'cod_confirm.ar.short',
          action: 'activate',
        }),
      ).resolves.toMatchObject({ changed: true, is_active: true });
    });
  });

  describe('edit', () => {
    const text = {
      body: `${BODY} We will ship it right away.`,
      confirm_label: 'Yes, confirm',
      cancel_label: 'No, cancel',
      samples: dto().samples,
    };

    it('refuses to edit in place a template that is active or that a store selects', async () => {
      expect(
        await codeOf(
          lifecycle.edit({
            userId: OPERATOR,
            key: 'cod_confirm.ar.active_v1',
            dto: text,
          }),
        ),
      ).toBe('WHATSAPP_TEMPLATE_EDIT_REFUSED');
      await expect(
        lifecycle.impact('cod_confirm.ar.active_v1'),
      ).resolves.toMatchObject({
        edit: { allowed: false, refusal: 'in_use', rule: '4.3.9' },
      });
    });

    it('refuses to edit a template Akeed holds no text for', async () => {
      await expect(
        lifecycle.impact('cod_confirm.ar.egyptian'),
      ).resolves.toMatchObject({
        edit: { allowed: false, refusal: 'retired' },
      });
      await client`
        UPDATE whatsapp_templates SET is_active = false WHERE "key" = 'cod_confirm.en.direct'`;
      await setStatus('cod_confirm.en.direct', 'approved');
      await expect(
        lifecycle.impact('cod_confirm.en.direct'),
      ).resolves.toMatchObject({
        edit: { allowed: false, refusal: 'not_authored_here' },
      });
    });

    it('edits an approved, unused template once: it is not sendable until approved again', async () => {
      const key = await approvedTemplate('edited');
      const before = api.writes.length;

      await expect(
        lifecycle.edit({
          userId: OPERATOR,
          key,
          dto: text,
          requestId: 'req-edit',
        }),
      ).resolves.toEqual({ key, review_status: 'pending' });

      expect(api.writes.length - before).toBe(1);
      expect(await template(key)).toMatchObject({
        review_status: 'pending',
        is_active: false,
      });
      expect(
        await codeOf(
          lifecycle.act({ userId: OPERATOR, key, action: 'activate' }),
        ),
      ).toBe('WHATSAPP_TEMPLATE_NOT_APPROVED');
      const [draft] = await client<{ body: string; confirm_label: string }[]>`
        SELECT d.body, d.confirm_label FROM whatsapp_template_drafts d
        JOIN whatsapp_templates t ON t.id = d.template_id WHERE t."key" = ${key}`;
      expect(draft).toEqual({ body: text.body, confirm_label: 'Yes, confirm' });
      const [preview] = await client<{ preview: { confirmButton: string } }[]>`
        SELECT preview FROM whatsapp_templates WHERE "key" = ${key}`;
      expect(preview.preview.confirmButton).toBe('Yes, confirm');
      const [edit] = await audits('whatsapp-templates.edit');
      expect(edit).toMatchObject({
        user_id: OPERATOR,
        request_id: 'req-edit',
        metadata: {
          templateKey: key,
          outcome: 'applied',
          previousReviewStatus: 'approved',
        },
      });
      expect(JSON.stringify(edit)).not.toContain('ship it');
    });

    it('refuses a second edit of an approved template within 24 hours, by its own count', async () => {
      const key = 'cod_confirm.ar.edited_v1';
      await setStatus(key, 'approved');
      const before = api.writes.length;

      expect(
        await codeOf(lifecycle.edit({ userId: OPERATOR, key, dto: text })),
      ).toBe('WHATSAPP_TEMPLATE_EDIT_REFUSED');
      await expect(lifecycle.impact(key)).resolves.toMatchObject({
        edit: {
          allowed: false,
          refusal: 'daily_limit',
          rule: '4.3.2',
          edits_last_day: 1,
          edits_last_30_days: 1,
        },
      });
      expect(api.writes.length).toBe(before);

      // The window rolls: 24 hours after the first edit, the next is allowed.
      const later = new Date(Date.now() + 24 * 60 * 60_000 + 1000);
      await expect(
        lifecycleRepository.beginEdit({ key, userId: OPERATOR, now: later }),
      ).resolves.toMatchObject({ kind: 'started' });
    });

    it('refuses the eleventh edit of an approved template in 30 days', async () => {
      const key = await approvedTemplate('monthly');
      const [{ id }] = await client<{ id: string }[]>`
        SELECT id FROM whatsapp_templates WHERE "key" = ${key}`;
      for (let day = 2; day <= 11; day += 1) {
        await client`
          INSERT INTO whatsapp_template_edits (template_id, requested_by, requested_at, outcome)
          VALUES (${id}, ${OPERATOR}, now() - make_interval(days => ${day}::int), 'applied')`;
      }
      // A refused edit and one older than the window do not count.
      await client`
        INSERT INTO whatsapp_template_edits (template_id, requested_by, requested_at, outcome)
        VALUES (${id}, ${OPERATOR}, now() - interval '3 days', 'refused'),
          (${id}, ${OPERATOR}, now() - interval '31 days', 'applied')`;

      await expect(
        lifecycleRepository.beginEdit({ key, userId: OPERATOR }),
      ).resolves.toEqual({
        kind: 'refused',
        reason: 'monthly_limit',
        rule: '4.3.2',
      });
    });

    it('does not limit a rejected template, and counts an edit with no answer', async () => {
      const key = await approvedTemplate('rejected');
      await setStatus(key, 'rejected');

      await lifecycle.edit({ userId: OPERATOR, key, dto: text });
      await setStatus(key, 'rejected');
      api.failNextWrite({ kind: 'applied_then_lost' });
      expect(
        await codeOf(lifecycle.edit({ userId: OPERATOR, key, dto: text })),
      ).toBe('WHATSAPP_TEMPLATE_EDIT_UNRESOLVED');

      expect(await template(key)).toMatchObject({ review_status: 'pending' });
      const edits = await client<{ outcome: string }[]>`
        SELECT e.outcome FROM whatsapp_template_edits e
        JOIN whatsapp_templates t ON t.id = e.template_id
        WHERE t."key" = ${key} ORDER BY e.requested_at`;
      expect(edits.map((edit) => edit.outcome)).toEqual(['applied', 'unknown']);
    });

    it('starts one of two edits of an approved template at once', async () => {
      const key = await approvedTemplate('paired');

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          lifecycleRepository.beginEdit({ key, userId: OPERATOR }),
        ),
      );

      expect(results.map((result) => result.kind).sort()).toEqual([
        'refused',
        'refused',
        'refused',
        'started',
      ]);
    });
  });

  it('writes one audit row per write, none with template text, all by a named actor', async () => {
    const rows = await audits();
    const actions = new Set(rows.map((row) => row.action));

    expect([...actions].sort()).toEqual([
      'whatsapp-templates.activate',
      'whatsapp-templates.deactivate',
      'whatsapp-templates.draft.create',
      'whatsapp-templates.edit',
      'whatsapp-templates.reconcile',
      'whatsapp-templates.retire',
      'whatsapp-templates.set-default',
      'whatsapp-templates.submit',
    ]);
    expect(
      rows.every(
        (row) =>
          [OPERATOR, SECOND_OPERATOR].includes(row.user_id) &&
          row.outcome === 'allowed' &&
          row.metadata.version === 1,
      ),
    ).toBe(true);
    const everything = JSON.stringify(rows);
    for (const marker of [...TEXT_MARKERS, 'ship it', 'Yes, confirm']) {
      expect(everything).not.toContain(marker);
    }
    // Nothing in the suite deleted a template at the provider.
    expect(api.templates.length).toBeGreaterThan(8);
  });
});
