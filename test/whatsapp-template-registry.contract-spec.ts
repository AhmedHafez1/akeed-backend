import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { TemplateRegistryService } from '../src/modules/template-registry/template-registry.service';
import {
  findDefaultTemplate,
  selectTemplateForSend,
} from '../src/shared/messaging/template-selector';
import { seededRegistryTemplates } from '../src/shared/messaging/testing/seeded-template-registry';

/**
 * US-08-03 against real PostgreSQL: migration 0054 creates and seeds the
 * template registry, and 0055 gives each store the registry key of the style
 * it had chosen.
 *
 * The seed is compared with the code catalog through the real repository, so
 * a row the send path reads is the template the code sent before.
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

const namespace = `e08_template_registry_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 4,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new WhatsappTemplatesRepository(database);
let created = false;

const REGISTRY_MIGRATION = '0054_whatsapp_templates_registry.sql';
const STORE_KEYS_MIGRATION = '0055_integration_template_keys.sql';

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

/** A store as it was before 0055: only the old variant columns. */
async function insertStore(
  arVariant: string,
  enVariant: string,
): Promise<string> {
  const [row] = await client<{ id: string }[]>`
    INSERT INTO integrations (cod_template_ar_variant, cod_template_en_variant)
    VALUES (${arVariant}, ${enVariant})
    RETURNING id`;
  return row.id;
}

async function storeKeys(id: string) {
  const [row] = await client<{ ar: string | null; en: string | null }[]>`
    SELECT cod_template_ar_key AS ar, cod_template_en_key AS en
    FROM integrations WHERE id = ${id}`;
  return row;
}

async function databaseErrorCode(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return String((error as { code?: string }).code);
  }
  return 'no error';
}

const NEW_ROW = `
  INSERT INTO whatsapp_templates
    ("key", "purpose", "language", "style", "meta_template_name",
     "meta_language_code", "parameter_format", "variable_mapping", "preview",
     "is_active", "is_default")`;
const NEW_ROW_JSON = `'[{"key":"order","position":1}]'::jsonb,
  '{"greeting":"","body":"","totalLabel":"","ending":"","confirmButton":"","cancelButton":""}'::jsonb`;

describe('WhatsApp template registry migrations', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cod_template_ar_variant text DEFAULT 'standard' NOT NULL,
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL
      );
    `);
    await migrate(REGISTRY_MIGRATION);
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('0054: the registry and its seed', () => {
    it('seeds the 8 templates exactly as the code catalog defines them', async () => {
      const templates = await repository.findAll();

      expect(templates).toHaveLength(8);
      // Field order and array order included: this is what the settings
      // response and the send payload are built from.
      expect(JSON.stringify(templates)).toBe(
        JSON.stringify(seededRegistryTemplates()),
      );
    });

    it('keeps the two legacy template names verbatim', async () => {
      const rows = await client<{ key: string; name: string }[]>`
        SELECT "key", meta_template_name AS name FROM whatsapp_templates
        WHERE "key" IN ('cod_confirm.en.professional', 'cod_confirm.en.direct')
        ORDER BY "key"`;

      expect(rows).toEqual([
        {
          key: 'cod_confirm.en.direct',
          name: 'akeed_cod_verification_direct_',
        },
        {
          key: 'cod_confirm.en.professional',
          name: '_akeed_cod_verification_professional',
        },
      ]);
    });

    it('seeds every row active, with one default per language', async () => {
      const rows = await client<
        { key: string; active: boolean; default: boolean }[]
      >`
        SELECT "key", is_active AS active, is_default AS default
        FROM whatsapp_templates`;

      expect(rows.every(({ active }) => active)).toBe(true);
      expect(
        rows
          .filter((row) => row.default)
          .map(({ key }) => key)
          .sort(),
      ).toEqual(['cod_confirm.ar.standard', 'cod_confirm.en.friendly']);
    });

    it('seeds no Meta-side data: that comes from each environment’s sync', async () => {
      const [row] = await client<{ filled: number }[]>`
        SELECT count(*)::int AS filled FROM whatsapp_templates
        WHERE meta_template_id IS NOT NULL OR review_status IS NOT NULL
          OR category IS NOT NULL OR quality IS NOT NULL
          OR components_snapshot IS NOT NULL OR last_synced_at IS NOT NULL`;

      expect(row.filled).toBe(0);
    });

    it('is idempotent and never overwrites a row staff changed', async () => {
      await client`
        UPDATE whatsapp_templates
        SET is_active = false, preview = jsonb_set(preview, '{greeting}', '"Edited"')
        WHERE "key" = 'cod_confirm.en.short'`;

      await migrate(REGISTRY_MIGRATION);

      const [count] = await client<{ total: number }[]>`
        SELECT count(*)::int AS total FROM whatsapp_templates`;
      const [edited] = await client<{ active: boolean; greeting: string }[]>`
        SELECT is_active AS active, preview->>'greeting' AS greeting
        FROM whatsapp_templates WHERE "key" = 'cod_confirm.en.short'`;
      expect(count.total).toBe(8);
      expect(edited).toEqual({ active: false, greeting: 'Edited' });

      await client`
        UPDATE whatsapp_templates
        SET is_active = true, preview = jsonb_set(preview, '{greeting}', '"Hello"')
        WHERE "key" = 'cod_confirm.en.short'`;
      expect(JSON.stringify(await repository.findAll())).toBe(
        JSON.stringify(seededRegistryTemplates()),
      );
    });

    it('allows at most one default per purpose and language', async () => {
      await expect(
        databaseErrorCode(
          client`UPDATE whatsapp_templates SET is_default = true WHERE "key" = 'cod_confirm.ar.gulf'`,
        ),
      ).resolves.toBe('23505');
      await expect(
        databaseErrorCode(
          client.unsafe(`${NEW_ROW} VALUES
            ('cod_confirm.en.second_default', 'cod_confirmation', 'en', 'second_default',
             'x', 'en', 'positional', ${NEW_ROW_JSON}, true, true)`),
        ),
      ).resolves.toBe('23505');
    });

    it('lets the default move from one template to another', async () => {
      await client.begin(async (tx) => {
        await tx.unsafe(
          `UPDATE whatsapp_templates SET is_default = false WHERE "key" = 'cod_confirm.ar.standard'`,
        );
        await tx.unsafe(
          `UPDATE whatsapp_templates SET is_default = true WHERE "key" = 'cod_confirm.ar.gulf'`,
        );
      });

      expect(findDefaultTemplate(await repository.findAll(), 'ar')?.key).toBe(
        'cod_confirm.ar.gulf',
      );

      await client.begin(async (tx) => {
        await tx.unsafe(
          `UPDATE whatsapp_templates SET is_default = false WHERE "key" = 'cod_confirm.ar.gulf'`,
        );
        await tx.unsafe(
          `UPDATE whatsapp_templates SET is_default = true WHERE "key" = 'cod_confirm.ar.standard'`,
        );
      });
    });

    it('refuses an inactive default', async () => {
      await expect(
        databaseErrorCode(
          client`UPDATE whatsapp_templates SET is_active = false WHERE "key" = 'cod_confirm.ar.standard'`,
        ),
      ).resolves.toBe('23514');
    });

    it.each([
      [
        'a duplicate key',
        `('cod_confirm.ar.gulf', 'cod_confirmation', 'ar', 'gulf_again', 'x', 'ar', 'positional', ${NEW_ROW_JSON}, true, false)`,
        '23505',
      ],
      [
        'a second row for one purpose, language and style',
        `('cod_confirm.ar.gulf_again', 'cod_confirmation', 'ar', 'gulf', 'x', 'ar', 'positional', ${NEW_ROW_JSON}, true, false)`,
        '23505',
      ],
      [
        'an unknown purpose',
        `('marketing.ar.x', 'marketing', 'ar', 'x', 'x', 'ar', 'positional', ${NEW_ROW_JSON}, true, false)`,
        '23514',
      ],
      [
        'an unknown language',
        `('cod_confirm.fr.x', 'cod_confirmation', 'fr', 'x', 'x', 'fr', 'positional', ${NEW_ROW_JSON}, true, false)`,
        '23514',
      ],
      [
        'an unknown parameter format',
        `('cod_confirm.ar.x', 'cod_confirmation', 'ar', 'x', 'x', 'ar', 'mixed', ${NEW_ROW_JSON}, true, false)`,
        '23514',
      ],
    ])('refuses %s', async (_label, values, code) => {
      await expect(
        databaseErrorCode(client.unsafe(`${NEW_ROW} VALUES ${values}`)),
      ).resolves.toBe(code);
    });

    it('is closed to tenants: row security on, service role only', async () => {
      const [table] = await client<{ secured: boolean }[]>`
        SELECT relrowsecurity AS secured FROM pg_class
        WHERE oid = ${`${namespace}.whatsapp_templates`}::regclass`;
      const policies = await client<{ roles: string[] }[]>`
        SELECT roles FROM pg_policies
        WHERE schemaname = ${namespace} AND tablename = 'whatsapp_templates'`;
      const grants = await client<{ grantee: string }[]>`
        SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema = ${namespace} AND table_name = 'whatsapp_templates'
          AND grantee IN ('anon', 'authenticated', 'PUBLIC')`;

      expect(table.secured).toBe(true);
      expect(policies.map(({ roles }) => roles)).toEqual([['service_role']]);
      expect(grants).toEqual([]);
    });
  });

  describe('a registry row and the send path', () => {
    it('an inactive row is not selectable: the default stands in', async () => {
      await client`UPDATE whatsapp_templates SET is_active = false WHERE "key" = 'cod_confirm.ar.gulf'`;
      try {
        const selection = selectTemplateForSend(await repository.findAll(), {
          preferredLanguage: 'ar',
          phoneNumber: '+966500000001',
          arKey: 'cod_confirm.ar.gulf',
        });

        expect(selection.template?.variantKey).toBe('ar.standard');
        expect(selection).toMatchObject({ fallbackReason: 'key_inactive' });
      } finally {
        await client`UPDATE whatsapp_templates SET is_active = true WHERE "key" = 'cod_confirm.ar.gulf'`;
      }
    });

    it('an unknown stored key falls back to the default', async () => {
      const selection = selectTemplateForSend(await repository.findAll(), {
        preferredLanguage: 'en',
        phoneNumber: '+14155550101',
        enKey: 'cod_confirm.en.retired',
      });

      expect(selection.template?.variantKey).toBe('en.friendly');
      expect(selection).toMatchObject({ fallbackReason: 'key_unknown' });
    });

    it('the registry service serves the seeded rows through the port', async () => {
      const service = new TemplateRegistryService(repository);

      expect(JSON.stringify(await service.listTemplates())).toBe(
        JSON.stringify(seededRegistryTemplates()),
      );
    });
  });

  describe('0055: store settings reference registry keys', () => {
    const stores: Record<string, string> = {};
    const CHOICES = [
      ['standard', 'friendly'],
      ['egyptian', 'professional'],
      ['gulf', 'direct'],
      ['short', 'short'],
    ] as const;

    beforeAll(async () => {
      for (const [ar, en] of CHOICES) {
        stores[`${ar}/${en}`] = await insertStore(ar, en);
      }
      // No CHECK in this table, so a value the registry does not know can be
      // stored: the backfill must leave it without a key.
      stores.unknown = await insertStore('retired_variant', 'friendly');
      await migrate(STORE_KEYS_MIGRATION);
    });

    it.each(CHOICES)(
      'fills the keys of a store that chose %s and %s',
      async (ar, en) => {
        await expect(storeKeys(stores[`${ar}/${en}`])).resolves.toEqual({
          ar: `cod_confirm.ar.${ar}`,
          en: `cod_confirm.en.${en}`,
        });
      },
    );

    it('leaves a value with no registry row without a key', async () => {
      await expect(storeKeys(stores.unknown)).resolves.toEqual({
        ar: null,
        en: 'cod_confirm.en.friendly',
      });
    });

    it('keeps the old columns and their values', async () => {
      const [row] = await client<{ ar: string; en: string }[]>`
        SELECT cod_template_ar_variant AS ar, cod_template_en_variant AS en
        FROM integrations WHERE id = ${stores['gulf/direct']}`;

      expect(row).toEqual({ ar: 'gulf', en: 'direct' });
    });

    it('is idempotent and never overwrites a key already stored', async () => {
      const id = stores['standard/friendly'];
      await client`UPDATE integrations SET cod_template_ar_key = 'cod_confirm.ar.gulf' WHERE id = ${id}`;

      await migrate(STORE_KEYS_MIGRATION);

      await expect(storeKeys(id)).resolves.toEqual({
        ar: 'cod_confirm.ar.gulf',
        en: 'cod_confirm.en.friendly',
      });
    });

    it('starts a store created afterwards without keys', async () => {
      const id = await insertStore('standard', 'friendly');

      await expect(storeKeys(id)).resolves.toEqual({ ar: null, en: null });
    });

    it('refuses a key the registry does not have', async () => {
      await expect(
        databaseErrorCode(
          client`UPDATE integrations SET cod_template_en_key = 'cod_confirm.en.unknown' WHERE id = ${stores['gulf/direct']}`,
        ),
      ).resolves.toBe('23503');
    });

    it('refuses to delete a template a store references', async () => {
      await expect(
        databaseErrorCode(
          client`DELETE FROM whatsapp_templates WHERE "key" = 'cod_confirm.ar.egyptian'`,
        ),
      ).resolves.toBe('23503');
    });
  });

  describe('rollback', () => {
    it('removes the keys and the registry, keeps every choice, and reapplies', async () => {
      const [before] = await client<{ stores: number }[]>`
        SELECT count(*)::int AS stores FROM integrations`;

      // The statements written in the two migration headers.
      await client.unsafe(`
        ALTER TABLE "integrations" DROP COLUMN "cod_template_ar_key", DROP COLUMN "cod_template_en_key";
        DROP TABLE "whatsapp_templates";
      `);

      const variants = await client<{ ar: string; en: string }[]>`
        SELECT cod_template_ar_variant AS ar, cod_template_en_variant AS en
        FROM integrations WHERE cod_template_ar_variant = 'egyptian'`;
      expect(variants).toEqual([{ ar: 'egyptian', en: 'professional' }]);

      await migrate(REGISTRY_MIGRATION);
      await migrate(STORE_KEYS_MIGRATION);

      const [after] = await client<{ stores: number; keyed: number }[]>`
        SELECT count(*)::int AS stores, count(cod_template_en_key)::int AS keyed
        FROM integrations`;
      expect(after.stores).toBe(before.stores);
      expect(after.keyed).toBe(before.stores);
      expect(JSON.stringify(await repository.findAll())).toBe(
        JSON.stringify(seededRegistryTemplates()),
      );
    });
  });
});
