import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { WhatsappTemplateLifecycleRepository } from '../src/infrastructure/database/repositories/whatsapp-template-lifecycle.repository';
import { WhatsappTemplateSyncRepository } from '../src/infrastructure/database/repositories/whatsapp-template-sync.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { AdminTemplateLifecycleService } from '../src/modules/admin/admin-template-lifecycle.service';

/**
 * US-08-07 against real PostgreSQL: migrations 0059 and 0060, their
 * constraints and the once-per-verification rule.
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

const namespace = `e08_message_improvements_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
let created = false;
const registryRepository = new WhatsappTemplatesRepository(database);
const registry = {
  listTemplates: () => registryRepository.findAll(),
  invalidate: jest.fn(),
};
const lifecycle = new AdminTemplateLifecycleService(
  new WhatsappTemplateLifecycleRepository(database),
  {} as never,
  registry,
);
const syncRepository = new WhatsappTemplateSyncRepository(database);

const MIGRATIONS = [
  '0054_whatsapp_templates_registry.sql',
  '0055_integration_template_keys.sql',
  '0056_dispatch_template_fallback.sql',
  '0057_whatsapp_template_sync.sql',
  '0058_whatsapp_template_authoring.sql',
  '0059_whatsapp_reminder_and_auto_style.sql',
  '0060_whatsapp_service_messages.sql',
];
const REMINDER_MIGRATION = '0059_whatsapp_reminder_and_auto_style.sql';
const SERVICE_MIGRATION = '0060_whatsapp_service_messages.sql';
const STAFF = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

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

/** The rollback written in a migration header, as one script. */
function rollbackStatements(name: string): string {
  const lines = readFileSync(resolve(__dirname, '../drizzle', name), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('--'));
  const start = lines.findIndex((line) => line.includes('then run:'));
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith('--   '))
    .map((line) => line.slice(5))
    .join('\n');
}

async function constraintError(
  run: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { constraint_name?: string }).constraint_name;
  }
  return undefined;
}

async function insertVerification(): Promise<{ id: string; orgId: string }> {
  const orgId = randomUUID();
  const [row] = await client<{ id: string }[]>`
    INSERT INTO verifications (org_id) VALUES (${orgId}) RETURNING id`;
  return { id: row.id, orgId };
}

describe('US-08-07 message improvements against PostgreSQL', () => {
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
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL,
        updated_at timestamp with time zone DEFAULT now()
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
      CREATE TABLE verification_message_dispatches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE verifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        CONSTRAINT verifications_id_org_id_key UNIQUE (id, org_id)
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

  describe('0059: reminder purpose and Arabic auto', () => {
    it('replays as a no-op and changes no store and no template', async () => {
      const store = await client<{ id: string }[]>`
        INSERT INTO integrations DEFAULT VALUES RETURNING id`;
      const before =
        await client`SELECT * FROM whatsapp_templates ORDER BY key`;
      await migrate(REMINDER_MIGRATION);
      expect(
        await client`SELECT * FROM whatsapp_templates ORDER BY key`,
      ).toEqual(before);
      const [row] = await client<
        {
          cod_reminder_ar_key: string | null;
          cod_reminder_en_key: string | null;
          cod_template_ar_auto: boolean;
        }[]
      >`
        SELECT cod_reminder_ar_key, cod_reminder_en_key, cod_template_ar_auto
        FROM integrations WHERE id = ${store[0].id}`;
      expect(row).toEqual({
        cod_reminder_ar_key: null,
        cod_reminder_en_key: null,
        cod_template_ar_auto: false,
      });
    });

    it('accepts a cod_reminder template and draft, and still refuses another purpose', async () => {
      await client`
        INSERT INTO whatsapp_templates (key, purpose, language, style,
          meta_template_name, meta_language_code, parameter_format,
          variable_mapping, preview, is_active)
        VALUES ('cod_reminder.ar.standard_v1', 'cod_reminder', 'ar',
          'standard_v1', 'akeed_cod_reminder_standard_v1', 'ar', 'named',
          '[]'::jsonb, '{}'::jsonb, false)`;
      await client`
        INSERT INTO whatsapp_template_drafts (key, purpose, language, style,
          version, meta_template_name, meta_language_code, parameter_format,
          category, body, confirm_label, cancel_label, created_by, updated_by)
        VALUES ('cod_reminder.en.friendly_v1', 'cod_reminder', 'en',
          'friendly', 1, 'akeed_cod_reminder_friendly_v1', 'en', 'named',
          'utility', 'Hi', 'Confirm', 'Cancel', ${STAFF}, ${STAFF})`;
      expect(
        await constraintError(
          () => client`
            INSERT INTO whatsapp_templates (key, purpose, language, style,
              meta_template_name, meta_language_code, parameter_format,
              variable_mapping, preview)
            VALUES ('x.ar.a', 'marketing', 'ar', 'a', 'x', 'ar', 'named',
              '[]'::jsonb, '{}'::jsonb)`,
        ),
      ).toBe('whatsapp_templates_purpose_check');
      expect(
        await constraintError(
          () => client`
            INSERT INTO whatsapp_template_drafts (key, purpose, language,
              style, version, meta_template_name, meta_language_code,
              parameter_format, category, body, confirm_label, cancel_label,
              created_by, updated_by)
            VALUES ('x.en.a_v1', 'marketing', 'en', 'a', 1, 'x', 'en',
              'named', 'utility', 'Hi', 'Y', 'N', ${STAFF}, ${STAFF})`,
        ),
      ).toBe('whatsapp_template_drafts_purpose_check');
    });

    it('stores a reminder key only when the registry holds it, and follows a key rename', async () => {
      const [store] = await client<{ id: string }[]>`
        INSERT INTO integrations (cod_reminder_ar_key)
        VALUES ('cod_reminder.ar.standard_v1') RETURNING id`;
      expect(
        await constraintError(
          () => client`
            INSERT INTO integrations (cod_reminder_en_key)
            VALUES ('cod_reminder.en.missing')`,
        ),
      ).toBe('integrations_cod_reminder_en_key_fkey');
      await client`
        UPDATE whatsapp_templates SET key = 'cod_reminder.ar.standard_v1b'
        WHERE key = 'cod_reminder.ar.standard_v1'`;
      const [row] = await client<{ cod_reminder_ar_key: string }[]>`
        SELECT cod_reminder_ar_key FROM integrations WHERE id = ${store.id}`;
      expect(row.cod_reminder_ar_key).toBe('cod_reminder.ar.standard_v1b');
    });
  });

  describe('0060: free-form texts, service messages and reply events', () => {
    it('creates four service-role tables with row security and seeds nothing', async () => {
      const secured = await client<
        { relname: string; relrowsecurity: boolean }[]
      >`
        SELECT c.relname, c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${namespace}
          AND c.relname IN ('whatsapp_message_texts',
            'whatsapp_message_text_events', 'verification_service_messages',
            'verification_reply_events')
        ORDER BY c.relname`;
      expect(secured).toEqual([
        { relname: 'verification_reply_events', relrowsecurity: true },
        { relname: 'verification_service_messages', relrowsecurity: true },
        { relname: 'whatsapp_message_text_events', relrowsecurity: true },
        { relname: 'whatsapp_message_texts', relrowsecurity: true },
      ]);
      await migrate(SERVICE_MIGRATION);
      const [counts] = await client<{ texts: number; messages: number }[]>`
        SELECT (SELECT count(*)::int FROM whatsapp_message_texts) AS texts,
          (SELECT count(*)::int FROM verification_service_messages) AS messages`;
      expect(counts).toEqual({ texts: 0, messages: 0 });
    });

    it('keeps one text per purpose, language and style, within the limits', async () => {
      await client`
        INSERT INTO whatsapp_message_texts (purpose, language, style, body, updated_by)
        VALUES ('ack_confirmed', 'ar', 'default', 'نص', ${STAFF})`;
      await client`
        INSERT INTO whatsapp_message_texts (purpose, language, style, body, updated_by)
        VALUES ('ack_confirmed', 'ar', 'egyptian', 'نص', ${STAFF})`;
      expect(
        await constraintError(
          () => client`
            INSERT INTO whatsapp_message_texts (purpose, language, style, body, updated_by)
            VALUES ('ack_confirmed', 'ar', 'default', 'آخر', ${STAFF})`,
        ),
      ).toBe('whatsapp_message_texts_purpose_language_style_key');
      const cases: Array<[string, string, string, string, string]> = [
        ['promo', 'ar', 'default', 'x', 'whatsapp_message_texts_purpose_check'],
        [
          'ack_canceled',
          'fr',
          'default',
          'x',
          'whatsapp_message_texts_language_check',
        ],
        [
          'ack_canceled',
          'ar',
          'Gulf Style',
          'x',
          'whatsapp_message_texts_style_check',
        ],
        [
          'ack_canceled',
          'ar',
          'default',
          '',
          'whatsapp_message_texts_body_check',
        ],
        [
          'ack_canceled',
          'ar',
          'default',
          'x'.repeat(4097),
          'whatsapp_message_texts_body_check',
        ],
      ];
      for (const [purpose, language, style, body, constraint] of cases) {
        expect(
          await constraintError(
            () => client`
              INSERT INTO whatsapp_message_texts (purpose, language, style, body, updated_by)
              VALUES (${purpose}, ${language}, ${style}, ${body}, ${STAFF})`,
          ),
        ).toBe(constraint);
      }
    });

    it('allows one acknowledgment and one nudge per verification, ever', async () => {
      const verification = await insertVerification();
      for (const kind of ['acknowledgment', 'nudge']) {
        await client`
          INSERT INTO verification_service_messages (org_id, verification_id, kind)
          VALUES (${verification.orgId}, ${verification.id}, ${kind})`;
      }
      const replay = await client`
        INSERT INTO verification_service_messages (org_id, verification_id, kind)
        VALUES (${verification.orgId}, ${verification.id}, 'nudge')
        ON CONFLICT ON CONSTRAINT verification_service_messages_once_key DO NOTHING
        RETURNING id`;
      expect(replay).toHaveLength(0);
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_service_messages (org_id, verification_id, kind)
            VALUES (${verification.orgId}, ${verification.id}, 'acknowledgment')`,
        ),
      ).toBe('verification_service_messages_once_key');
    });

    it('ties a service message and a reply event to the verification of the same organization', async () => {
      const verification = await insertVerification();
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_service_messages (org_id, verification_id, kind)
            VALUES (${randomUUID()}, ${verification.id}, 'nudge')`,
        ),
      ).toBe('verification_service_messages_verification_fkey');
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_reply_events (org_id, verification_id, kind, provider_message_id, received_at)
            VALUES (${randomUUID()}, ${verification.id}, 'unresolved_reply', 'wamid.x', now())`,
        ),
      ).toBe('verification_reply_events_verification_fkey');
    });

    it('needs a provider id for a sent message, and refuses an unknown kind or state', async () => {
      const verification = await insertVerification();
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_service_messages (org_id, verification_id, kind, state)
            VALUES (${verification.orgId}, ${verification.id}, 'nudge', 'sent')`,
        ),
      ).toBe('verification_service_messages_sent_has_id_check');
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_service_messages (org_id, verification_id, kind)
            VALUES (${verification.orgId}, ${verification.id}, 'promo')`,
        ),
      ).toBe('verification_service_messages_kind_check');
      expect(
        await constraintError(
          () => client`
            INSERT INTO verification_service_messages (org_id, verification_id, kind, state)
            VALUES (${verification.orgId}, ${verification.id}, 'nudge', 'queued')`,
        ),
      ).toBe('verification_service_messages_state_check');
    });

    it('stores a redelivered reply event once, and has no column for its text', async () => {
      const verification = await insertVerification();
      for (let attempt = 0; attempt < 2; attempt++) {
        await client`
          INSERT INTO verification_reply_events (org_id, verification_id, kind, provider_message_id, received_at)
          VALUES (${verification.orgId}, ${verification.id}, 'unresolved_reply', 'wamid.reply-1', now())
          ON CONFLICT ON CONSTRAINT verification_reply_events_provider_message_key DO NOTHING`;
      }
      const [stored] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM verification_reply_events
        WHERE provider_message_id = 'wamid.reply-1'`;
      expect(stored.count).toBe(1);
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${namespace} AND table_name = 'verification_reply_events'
        ORDER BY ordinal_position`;
      expect(columns.map(({ column_name }) => column_name)).toEqual([
        'id',
        'org_id',
        'verification_id',
        'kind',
        'provider_message_id',
        'received_at',
        'created_at',
      ]);
    });
  });

  describe('reminder templates in the US-08-06 lifecycle', () => {
    async function insertReminder(style: string, isDefault = false) {
      await client`
        INSERT INTO whatsapp_templates (key, purpose, language, style,
          meta_template_name, meta_language_code, parameter_format,
          variable_mapping, preview, is_active, is_default, review_status,
          category, last_synced_at)
        VALUES (${`cod_reminder.ar.${style}`}, 'cod_reminder', 'ar', ${style},
          ${`akeed_cod_reminder_${style}`}, 'ar', 'named', '[]'::jsonb,
          '{}'::jsonb, true, ${isDefault}, 'approved', 'utility', now())`;
    }

    it('counts and moves the stores that chose a reminder, and leaves their first-send choice alone', async () => {
      await insertReminder('warm_v1', true);
      await insertReminder('calm_v1');
      const [chosen] = await client<{ id: string }[]>`
        INSERT INTO integrations (cod_template_ar_key, cod_reminder_ar_key)
        VALUES ('cod_confirm.ar.gulf', 'cod_reminder.ar.calm_v1') RETURNING id`;

      const counts = await syncRepository.activeStoreCountsByKey([
        'cod_reminder.ar.calm_v1',
        'cod_confirm.ar.gulf',
      ]);
      expect(counts.get('cod_reminder.ar.calm_v1')).toBe(1);
      expect(
        (await lifecycle.impact('cod_reminder.ar.calm_v1')).stores,
      ).toEqual({ total: 1, active: 1 });

      const result = await lifecycle.act({
        userId: STAFF,
        key: 'cod_reminder.ar.calm_v1',
        action: 'retire',
        replacementKey: 'cod_reminder.ar.warm_v1',
        requestId: 'req-retire-reminder',
      });
      expect(result).toMatchObject({ retired: true, moved_stores: 1 });
      const [after] = await client<
        { cod_template_ar_key: string; cod_reminder_ar_key: string }[]
      >`
        SELECT cod_template_ar_key, cod_reminder_ar_key
        FROM integrations WHERE id = ${chosen.id}`;
      expect(after).toEqual({
        cod_template_ar_key: 'cod_confirm.ar.gulf',
        cod_reminder_ar_key: 'cod_reminder.ar.warm_v1',
      });
    });

    it('refuses a first-send template as the replacement of a reminder', async () => {
      await insertReminder('quiet_v1');
      await expect(
        lifecycle.act({
          userId: STAFF,
          key: 'cod_reminder.ar.quiet_v1',
          action: 'retire',
          replacementKey: 'cod_confirm.ar.gulf',
          requestId: 'req-retire-wrong',
        }),
      ).rejects.toThrow();
    });
  });

  describe('rollback', () => {
    it('runs the 0060 then the 0059 header, then both migrations apply again', async () => {
      await client.unsafe(rollbackStatements(SERVICE_MIGRATION));
      await client.unsafe(rollbackStatements(REMINDER_MIGRATION));
      const [left] = await client<{ tables: number; columns: number }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.tables
            WHERE table_schema = ${namespace} AND table_name IN (
              'whatsapp_message_texts', 'whatsapp_message_text_events',
              'verification_service_messages', 'verification_reply_events')) AS tables,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = ${namespace} AND table_name = 'integrations'
              AND column_name IN ('cod_reminder_ar_key', 'cod_reminder_en_key',
                'cod_template_ar_auto')) AS columns`;
      expect(left).toEqual({ tables: 0, columns: 0 });
      const [reminders] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM whatsapp_templates
        WHERE purpose = 'cod_reminder'`;
      expect(reminders.count).toBe(0);
      await migrate(REMINDER_MIGRATION);
      await migrate(SERVICE_MIGRATION);
    });
  });
});
