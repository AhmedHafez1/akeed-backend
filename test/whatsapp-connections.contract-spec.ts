import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { WhatsappConnectTicketsRepository } from '../src/infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import { WhatsappConnectionTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import {
  WhatsappConnectionsRepository,
  WhatsappPhoneNumberInUseError,
  type SaveWhatsappConnectionInput,
} from '../src/infrastructure/database/repositories/whatsapp-connections.repository';
import {
  encryptConnectionSecret,
  readBusinessToken,
} from '../src/infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';

/**
 * Merchant WhatsApp connections against real PostgreSQL: migration 0084 and
 * its three repositories. Synthetic data only; nothing leaves the process.
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

const databaseUrl = isolatedDatabaseUrl();
const namespace = `e09_connections_${randomUUID().replaceAll('-', '')}`;
const KEY = 'c'.repeat(64);
const TABLES = [
  'whatsapp_connections',
  'whatsapp_connect_tickets',
  'whatsapp_connection_templates',
] as const;

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('WhatsApp connections contract', () => {
  const client = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
    connection: { search_path: `${namespace},public` },
  });
  const db = drizzle(client, { schema }) as never;
  const connections = new WhatsappConnectionsRepository(db);
  const tickets = new WhatsappConnectTicketsRepository(db);
  const templates = new WhatsappConnectionTemplatesRepository(db);
  let created = false;
  let orgA: string;
  let orgB: string;
  let templateOne: string;
  let templateTwo: string;

  const connectionInput = (
    phoneNumberId: string,
    overrides: Partial<SaveWhatsappConnectionInput> = {},
  ): SaveWhatsappConnectionInput => ({
    wabaId: '100000000000001',
    phoneNumberId,
    displayPhoneNumber: '+20 100 000 0000',
    signupPath: 'coexistence',
    state: 'connecting',
    businessTokenEncrypted: encryptConnectionSecret('EAAG-token', KEY),
    ...overrides,
  });

  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      );
      CREATE TABLE whatsapp_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL UNIQUE
      );
      -- Supabase grants new tables to these roles; the migration withdraws it.
      GRANT USAGE ON SCHEMA ${namespace} TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${namespace} GRANT ALL ON TABLES TO anon, authenticated;
    `);
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0084_whatsapp_connections.sql'),
      'utf8',
    );
    // Twice, to prove the migration re-runs.
    for (let run = 0; run < 2; run += 1) {
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
    [{ id: orgA }, { id: orgB }] = await client<{ id: string }[]>`
      INSERT INTO organizations (name) VALUES ('A'), ('B') RETURNING id`;
    [{ id: templateOne }, { id: templateTwo }] = await client<{ id: string }[]>`
      INSERT INTO whatsapp_templates (key) VALUES ('cod_ar'), ('cod_en') RETURNING id`;
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client`DELETE FROM whatsapp_connection_templates`;
    await client`DELETE FROM whatsapp_connections`;
    await client`DELETE FROM whatsapp_connect_tickets`;
  });

  describe('access', () => {
    it('is locked to the API: RLS on, nothing granted to browser roles', async () => {
      for (const table of TABLES) {
        const [row] = await client<{ relrowsecurity: boolean }[]>`
          SELECT c.relrowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${namespace} AND c.relname = ${table}`;
        expect(row.relrowsecurity).toBe(true);
        for (const role of ['anon', 'authenticated']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const [grant] = await client<{ allowed: boolean }[]>`
              SELECT has_table_privilege(${role}, ${`${namespace}.${table}`}, ${privilege}) AS allowed`;
            expect({ table, role, privilege, allowed: grant.allowed }).toEqual({
              table,
              role,
              privilege,
              allowed: false,
            });
          }
        }
      }
    });

    it('gives only the template table its service-role policy', async () => {
      const policies = await client<
        { tablename: string; roles: string[]; cmd: string }[]
      >`
        SELECT tablename, roles, cmd FROM pg_policies
        WHERE schemaname = ${namespace} ORDER BY tablename`;
      expect(policies).toEqual([
        {
          tablename: 'whatsapp_connection_templates',
          roles: ['service_role'],
          cmd: 'ALL',
        },
      ]);
    });

    it('keeps an authenticated session from reading a stored token', async () => {
      await connections.saveForOrg(orgA, connectionInput('200000000000001'));
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe('SET LOCAL ROLE authenticated');
          return tx.unsafe(
            'SELECT business_token_encrypted FROM whatsapp_connections',
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('connections', () => {
    it('keeps one row per organization: a reconnect replaces it', async () => {
      const first = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000001'),
      );
      const second = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000002', { state: 'active' }),
      );
      expect(second.id).toBe(first.id);
      expect(second.phoneNumberId).toBe('200000000000002');
      const [{ count }] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM whatsapp_connections`;
      expect(count).toBe(1);
      await expect(
        client`INSERT INTO whatsapp_connections (org_id, waba_id, phone_number_id, signup_path, state, business_token_encrypted)
               VALUES (${orgA}, '1', '3', 'coexistence', 'connecting', 'v1:a:b:c')`,
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'whatsapp_connections_org_id_key',
      });
    });

    it.each(['connecting', 'verifying', 'active', 'offboarded'] as const)(
      'holds a number for one organization while %s',
      async (state) => {
        await connections.saveForOrg(
          orgA,
          connectionInput('200000000000009', { state }),
        );
        await expect(
          connections.saveForOrg(orgB, connectionInput('200000000000009')),
        ).rejects.toBeInstanceOf(WhatsappPhoneNumberInUseError);
      },
    );

    it('releases the number on disconnect and clears every credential', async () => {
      await connections.saveForOrg(
        orgA,
        connectionInput('200000000000009', {
          signupPath: 'new_number',
          registrationPinEncrypted: encryptConnectionSecret('123456', KEY),
        }),
      );
      const disconnected = await connections.markDisconnected(
        orgA,
        'PARTNER_REMOVED',
      );
      expect(disconnected).toMatchObject({
        state: 'disconnected',
        businessTokenEncrypted: null,
        registrationPinEncrypted: null,
        phoneNumberId: '200000000000009',
      });
      expect(disconnected?.disconnectedAt).not.toBeNull();
      expect(
        await connections.findLiveByPhoneNumberId('200000000000009'),
      ).toBeNull();

      const taken = await connections.saveForOrg(
        orgB,
        connectionInput('200000000000009'),
      );
      expect(taken.orgId).toBe(orgB);
      expect(
        (await connections.findLiveByPhoneNumberId('200000000000009'))?.orgId,
      ).toBe(orgB);
    });

    it('scopes reads and writes to the calling organization', async () => {
      await connections.saveForOrg(orgA, connectionInput('200000000000001'));
      expect(await connections.findByOrg(orgB)).toBeNull();
      expect(await connections.markDisconnected(orgB, 'x')).toBeNull();
      const stillLive = await connections.findByOrg(orgA);
      expect(stillLive?.state).toBe('connecting');
      expect(readBusinessToken(stillLive!, KEY)).toBe('EAAG-token');
    });

    it.each([
      [
        'a plaintext token',
        `'connecting', 'EAAG-plain', NULL, NULL`,
        'whatsapp_connections_business_token_encrypted_check',
      ],
      [
        'a plaintext PIN',
        `'connecting', 'v1:a:b:c', '123456', NULL`,
        'whatsapp_connections_registration_pin_encrypted_check',
      ],
      [
        'a live row without a token',
        `'active', NULL, NULL, NULL`,
        'whatsapp_connections_credentials_check',
      ],
      [
        'a disconnected row that keeps its token',
        `'disconnected', 'v1:a:b:c', NULL, now()`,
        'whatsapp_connections_credentials_check',
      ],
      [
        'a disconnected row that keeps its PIN',
        `'disconnected', NULL, 'v1:a:b:c', now()`,
        'whatsapp_connections_credentials_check',
      ],
      [
        'a disconnected row with no disconnect time',
        `'disconnected', NULL, NULL, NULL`,
        'whatsapp_connections_credentials_check',
      ],
      [
        'an unknown state',
        `'paused', 'v1:a:b:c', NULL, NULL`,
        'whatsapp_connections_state_check',
      ],
    ])('refuses %s', async (_case, values, constraint) => {
      await expect(
        client.unsafe(
          `INSERT INTO whatsapp_connections (org_id, waba_id, phone_number_id, signup_path, state, business_token_encrypted, registration_pin_encrypted, disconnected_at)
           VALUES ('${orgA}', '1', '2', 'coexistence', ${values})`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
    });

    it('refuses a degraded class without its start time', async () => {
      await connections.saveForOrg(orgA, connectionInput('200000000000001'));
      await expect(
        client`UPDATE whatsapp_connections SET degraded_class = 'payment' WHERE org_id = ${orgA}`,
      ).rejects.toMatchObject({
        constraint_name: 'whatsapp_connections_degraded_since_check',
      });
    });
  });

  describe('templates', () => {
    it('records a template once per connection and updates it in place', async () => {
      const connection = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000001'),
      );
      const first = await templates.saveForOrg(orgA, {
        connectionId: connection.id,
        templateId: templateOne,
        metaLanguageCode: 'ar',
      });
      expect(first).toMatchObject({ status: 'not_submitted', orgId: orgA });
      const second = await templates.saveForOrg(orgA, {
        connectionId: connection.id,
        templateId: templateOne,
        metaLanguageCode: 'ar',
        metaTemplateId: '1234567890123456789',
        status: 'APPROVED',
        category: 'UTILITY',
      });
      expect(second?.id).toBe(first?.id);
      expect(second).toMatchObject({ status: 'APPROVED', category: 'UTILITY' });
      await templates.saveForOrg(orgA, {
        connectionId: connection.id,
        templateId: templateTwo,
        metaLanguageCode: 'en',
      });
      expect(await templates.listForOrg(orgA)).toHaveLength(2);
      expect(await templates.listForOrg(orgB)).toEqual([]);

      await expect(
        client`INSERT INTO whatsapp_connection_templates (connection_id, org_id, template_id, meta_language_code)
               VALUES (${connection.id}, ${orgA}, ${templateOne}, 'ar')`,
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name:
          'whatsapp_connection_templates_connection_template_key',
      });
    });

    it("never records a template on another organization's connection", async () => {
      const connection = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000001'),
      );
      expect(
        await templates.saveForOrg(orgB, {
          connectionId: connection.id,
          templateId: templateOne,
          metaLanguageCode: 'ar',
        }),
      ).toBeNull();
      await expect(
        client`INSERT INTO whatsapp_connection_templates (connection_id, org_id, template_id, meta_language_code)
               VALUES (${connection.id}, ${orgB}, ${templateOne}, 'ar')`,
      ).rejects.toMatchObject({
        code: '23503',
        constraint_name: 'whatsapp_connection_templates_connection_fkey',
      });

      // An existing row is not taken over through the conflict path either.
      await templates.saveForOrg(orgA, {
        connectionId: connection.id,
        templateId: templateOne,
        metaLanguageCode: 'ar',
      });
      expect(
        await templates.saveForOrg(orgB, {
          connectionId: connection.id,
          templateId: templateOne,
          metaLanguageCode: 'ar',
          status: 'REJECTED',
        }),
      ).toBeNull();
      expect((await templates.listForOrg(orgA))[0].status).toBe(
        'not_submitted',
      );
    });

    it('refuses a template the registry does not have', async () => {
      const connection = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000001'),
      );
      await expect(
        templates.saveForOrg(orgA, {
          connectionId: connection.id,
          templateId: randomUUID(),
          metaLanguageCode: 'ar',
        }),
      ).rejects.toMatchObject({
        cause: {
          code: '23503',
          constraint_name: 'whatsapp_connection_templates_template_id_fkey',
        },
      });
    });

    it("goes with its organization's connection", async () => {
      const connection = await connections.saveForOrg(
        orgA,
        connectionInput('200000000000001'),
      );
      await templates.saveForOrg(orgA, {
        connectionId: connection.id,
        templateId: templateOne,
        metaLanguageCode: 'ar',
      });
      await client`DELETE FROM whatsapp_connections WHERE id = ${connection.id}`;
      expect(await templates.listForOrg(orgA)).toEqual([]);
    });
  });

  describe('connect tickets', () => {
    it('stores only the hash and consumes a ticket once', async () => {
      const ticket = randomUUID();
      const issued = await tickets.issue({
        orgId: orgA,
        userId: randomUUID(),
        tokenHash: hash(ticket),
        ttlSeconds: 600,
      });
      const [stored] = await client<
        { token_hash: string; ttl: number }[]
      >`SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS ttl
        FROM whatsapp_connect_tickets WHERE id = ${issued.id}`;
      expect(stored.token_hash).toBe(hash(ticket));
      expect(stored.token_hash).not.toContain(ticket);
      expect(stored.ttl).toBe(600);

      expect(await tickets.consume(hash(ticket))).toMatchObject({
        orgId: orgA,
      });
      expect(await tickets.consume(hash(ticket))).toBeNull();
    });

    it('lets only one of several concurrent attempts through', async () => {
      const tokenHash = hash(randomUUID());
      await tickets.issue({
        orgId: orgA,
        userId: randomUUID(),
        tokenHash,
        ttlSeconds: 600,
      });
      const results = await Promise.all([
        tickets.consume(tokenHash),
        tickets.consume(tokenHash),
        tickets.consume(tokenHash),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('refuses an expired or unknown ticket', async () => {
      const tokenHash = hash(randomUUID());
      // Backdated in SQL, the clock consume compares against.
      await client`
        INSERT INTO whatsapp_connect_tickets (token_hash, org_id, user_id, created_at, expires_at)
        VALUES (${tokenHash}, ${orgA}, ${randomUUID()}, now() - interval '20 minutes', now() - interval '10 minutes')`;
      expect(await tickets.consume(tokenHash)).toBeNull();
      expect(await tickets.consume(hash('never-issued'))).toBeNull();
      const [{ used_at }] = await client<{ used_at: string | null }[]>`
        SELECT used_at FROM whatsapp_connect_tickets WHERE token_hash = ${tokenHash}`;
      expect(used_at).toBeNull();
    });

    it('refuses a raw ticket where a hash belongs, and a non-positive lifetime', async () => {
      await expect(
        client`INSERT INTO whatsapp_connect_tickets (token_hash, org_id, user_id, expires_at)
               VALUES ('raw-ticket', ${orgA}, ${randomUUID()}, now() + interval '10 minutes')`,
      ).rejects.toMatchObject({
        constraint_name: 'whatsapp_connect_tickets_token_hash_check',
      });
      await expect(
        tickets.issue({
          orgId: orgA,
          userId: randomUUID(),
          tokenHash: hash('x'),
          ttlSeconds: 0,
        }),
      ).rejects.toThrow('positive');
    });
  });
});
