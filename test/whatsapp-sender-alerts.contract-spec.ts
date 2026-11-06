import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import * as schema from '../src/infrastructure/database';
import { WhatsappSenderAlertsRepository } from '../src/infrastructure/database/repositories/whatsapp-sender-alerts.repository';
import { WhatsappConnectionsRepository } from '../src/infrastructure/database/repositories/whatsapp-connections.repository';

const value = process.env.E01_TEST_DATABASE_URL;
if (!value)
  throw new Error(
    'NOT RUN: E01_TEST_DATABASE_URL must identify disposable PostgreSQL.',
  );
const url = new URL(value);
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.username !== 'e01_test' ||
  url.pathname !== '/akeed_e01_test'
)
  throw new Error('NOT RUN: shared databases are forbidden.');
const namespace = `sender_alerts_${randomUUID().replaceAll('-', '')}`;
const client = postgres(value, {
  max: 8,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const repo = new WhatsappSenderAlertsRepository(db);
let org: string;
let connection: string;
const otherOrg = randomUUID();

describe('sender alert PostgreSQL contract', () => {
  beforeAll(async () => {
    await client.unsafe(`CREATE SCHEMA ${namespace};
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      GRANT USAGE ON SCHEMA ${namespace} TO authenticated, anon, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${namespace} GRANT ALL ON TABLES TO authenticated, anon;
    `);
    // Scaffold the existing connection columns; the new table itself must come from SQL.
    const definition = getTableConfig(schema.whatsappConnections);
    const dialect = new PgDialect();
    const columns = definition.columns.map((column) => {
      let result = `"${column.name}" ${column.getSQLType()}`;
      if (column.notNull) result += ' NOT NULL';
      if (column.primary) result += ' PRIMARY KEY';
      if (column.default !== undefined) {
        const d = column.default;
        result +=
          ' DEFAULT ' +
          (d instanceof SQL
            ? dialect.sqlToQuery(d).sql
            : typeof d === 'boolean' || typeof d === 'number'
              ? String(d)
              : `'${(typeof d === 'string' ? d : JSON.stringify(d)).replaceAll("'", "''")}'`);
      }
      return result;
    });
    columns.push('UNIQUE (id,org_id)', 'UNIQUE (org_id)');
    await client.unsafe(`CREATE TABLE whatsapp_connections (${columns.join(',')});
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text, is_active boolean DEFAULT true, review_status text DEFAULT 'approved', header_format text DEFAULT 'none', retired_at timestamptz);
      CREATE TABLE whatsapp_connection_templates(org_id uuid, connection_id uuid, template_id uuid, meta_language_code text, status text, category text);
      CREATE TABLE verification_message_dispatches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, state text, failed_at timestamptz, accepted_at timestamptz, sender_kind text, sender_reason text, sender_connection_id uuid, sender_connection_generation bigint, fallback_for_dispatch_id uuid);
      CREATE TABLE verification_sender_attempts(org_id uuid, dispatch_id uuid, attempt_number integer, failure jsonb);
    `);
    for (let run = 0; run < 2; run++) {
      const sql = readFileSync(
        resolve(__dirname, '../drizzle/0091_whatsapp_sender_alerts.sql'),
        'utf8',
      );
      for (const statement of sql.split('--> statement-breakpoint'))
        if (statement.trim()) await client.unsafe(statement);
    }
  });
  beforeEach(async () => {
    await client`TRUNCATE organizations, whatsapp_connections, whatsapp_sender_alerts, whatsapp_templates, whatsapp_connection_templates, verification_message_dispatches, verification_sender_attempts CASCADE`;
    org = randomUUID();
    connection = randomUUID();
    await client`INSERT INTO organizations (id) VALUES (${org}),(${otherOrg})`;
    await client`INSERT INTO whatsapp_connections (id,org_id,waba_id,phone_number_id,signup_path,state,quality_rating) VALUES (${connection},${org},'123','456','coexistence','active','GREEN')`;
  });
  afterAll(async () => {
    await client.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await client.end();
  });

  async function fallback(failureClass = 'retryable') {
    const source = randomUUID();
    await client`INSERT INTO verification_message_dispatches(id,org_id,state,sender_kind,sender_connection_id,sender_connection_generation) VALUES (${source},${org},'rejected','merchant_own',${connection},1)`;
    await client`INSERT INTO verification_sender_attempts(org_id,dispatch_id,attempt_number,failure) VALUES (${org},${source},2,${JSON.stringify({ class: failureClass })}::jsonb)`;
    await client`INSERT INTO verification_message_dispatches(org_id,state,accepted_at,sender_kind,sender_reason,fallback_for_dispatch_id) VALUES (${org},'accepted',now(),'akeed_system','send_failed:131000',${source})`;
  }

  it('deduplicates simultaneous evaluations and claims exactly one delivery', async () => {
    await client`UPDATE whatsapp_connections SET quality_rating = 'RED' WHERE org_id = ${org}`;
    await Promise.all(
      Array.from({ length: 8 }, () => repo.reconcile(org, true)),
    );
    const rows = await client<
      { id: string }[]
    >`SELECT * FROM whatsapp_sender_alerts`;
    expect(rows).toHaveLength(1);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimEmail(org, rows[0].id, true)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repo.markEmail(org, rows[0].id, 'failed', 'timeout');
    expect(await repo.reconcile(org, true)).toEqual([]);
    expect(await repo.claimEmail(org, rows[0].id, true)).toBeNull();
  });
  it('closes recovery, permits reopening, and rejects stale delivery', async () => {
    await client`UPDATE whatsapp_connections SET quality_rating = 'RED' WHERE org_id = ${org}`;
    const [first] = await repo.reconcile(org, true);
    await client`UPDATE whatsapp_connections SET quality_rating = 'YELLOW' WHERE org_id = ${org}`;
    expect(await repo.claimEmail(org, first.id, true)).toBeNull();
    await repo.reconcile(org, true);
    await client`UPDATE whatsapp_connections SET quality_rating = 'RED' WHERE org_id = ${org}`;
    const [next] = await repo.reconcile(org, true);
    expect(next.id).not.toBe(first.id);
    expect(await repo.claimEmail(org, next.id, true)).toMatchObject({
      kind: 'quality_drop',
    });
  });
  it('prevents a second open incident even with a different dedupe key', async () => {
    await client`UPDATE whatsapp_connections SET quality_rating='RED' WHERE org_id=${org}`;
    await repo.reconcile(org, true);
    await expect(
      client`INSERT INTO whatsapp_sender_alerts(org_id,connection_id,signup_generation,kind,reason,dedupe_key) VALUES (${org},${connection},1,'quality_drop','red','different')`,
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('retains red quality when health has no known quality observation', async () => {
    const connections = new WhatsappConnectionsRepository(db);
    await client`UPDATE whatsapp_connections SET quality_rating='RED' WHERE org_id=${org}`;
    for (const status of ['unknown', 'AVAILABLE'] as const) {
      await client`UPDATE whatsapp_connections SET next_health_at=now() WHERE org_id=${org}`;
      const claim = await connections.claimHealth(org, connection, 1);
      expect(claim).not.toBeNull();
      await connections.completeHealth(claim, {
        status,
        qualityRating: 'UNKNOWN',
      });
      expect(await repo.read(org, true)).toMatchObject([
        { kind: 'quality_drop' },
      ]);
    }
  });
  it('fences old connection generations and resolves superseded incidents', async () => {
    await client`UPDATE whatsapp_connections SET state='disconnected',state_reason='PRIMARY_INACTIVITY' WHERE org_id=${org}`;
    const [old] = await repo.reconcile(org, true);
    await client`UPDATE whatsapp_connections SET signup_generation=2,state='active',state_reason=NULL WHERE org_id=${org}`;
    expect(await repo.reconcile(org, true, 1)).toEqual([]);
    await repo.reconcile(org, true, 2);
    expect(await repo.claimEmail(org, old.id, true)).toBeNull();
    const [row] =
      await client`SELECT resolved_at FROM whatsapp_sender_alerts WHERE id=${old.id}`;
    expect(row.resolved_at).not.toBeNull();
  });
  it('groups live templates, ignores retired and inactive templates, and resolves on approval', async () => {
    const keys = ['first', 'second', 'retired', 'inactive'];
    for (const key of keys) {
      const [t] = await client<
        { id: string }[]
      >`INSERT INTO whatsapp_templates(key, retired_at, is_active) VALUES (${key},${key === 'retired' ? new Date().toISOString() : null},${key !== 'inactive'}) RETURNING id`;
      await client`INSERT INTO whatsapp_connection_templates VALUES (${org},${connection},${t.id},'en','rejected','utility')`;
    }
    const banners = await repo.read(org, true);
    expect(banners).toHaveLength(1);
    expect(banners[0].templates.map((t) => t.key)).toEqual(['first', 'second']);
    const incidents = await repo.reconcile(org, true);
    expect(incidents).toHaveLength(1);
    await client`UPDATE whatsapp_connection_templates SET status='approved'`;
    expect(await repo.reconcile(org, true)).toEqual([]);
    expect(await repo.read(org, true)).toEqual([]);
  });
  it('keeps banners with email disabled and no recipient; reads never write incidents', async () => {
    await client`UPDATE whatsapp_connections SET degraded_class='payment' WHERE org_id=${org}`;
    expect(await repo.read(org, false)).toMatchObject([{ kind: 'payment' }]);
    expect(await client`SELECT * FROM whatsapp_sender_alerts`).toHaveLength(0);
    const [incident] = await repo.reconcile(org, false);
    expect(
      await repo.claimEmail(org, incident.id, false, 'email_disabled'),
    ).toBeNull();
    expect(await repo.read(org, false)).toHaveLength(1);
    const [row] =
      await client`SELECT email_status,email_error FROM whatsapp_sender_alerts`;
    expect(row).toMatchObject({
      email_status: 'skipped',
      email_error: 'email_disabled',
    });
  });
  it('rate-limits fallback across reopening, allows it after 24 hours, and serializes concurrent claims', async () => {
    await fallback();
    const [first] = await repo.reconcile(org, true);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimEmail(org, first.id, true)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await client`UPDATE whatsapp_sender_alerts SET resolved_at=now()`;
    const [second] = await repo.reconcile(org, true);
    expect(await repo.claimEmail(org, second.id, true)).toBeNull();
    expect(
      (
        await client`SELECT email_error FROM whatsapp_sender_alerts WHERE id=${second.id}`
      )[0].email_error,
    ).toBe('rate_limited');
    await client`UPDATE whatsapp_sender_alerts SET email_claimed_at=now()-interval '25 hours' WHERE id=${first.id}`;
    await client`UPDATE whatsapp_sender_alerts SET resolved_at=now() WHERE id=${second.id}`;
    const [third] = await repo.reconcile(org, true);
    expect(await repo.claimEmail(org, third.id, true)).toMatchObject({
      kind: 'fallback',
    });
  });
  it('suppresses generic fallback for a specific cause and does not consume its rate-limit budget', async () => {
    await fallback();
    await client`UPDATE whatsapp_connections SET degraded_class='payment' WHERE org_id=${org}`;
    const pending = await repo.reconcile(org, true);
    const generic = pending.find((a) => a.kind === 'fallback')!;
    expect(await repo.claimEmail(org, generic.id, true)).toBeNull();
    const [row] =
      await client`SELECT email_error,email_claimed_at FROM whatsapp_sender_alerts WHERE id=${generic.id}`;
    expect(row).toMatchObject({
      email_error: 'specific_cause',
      email_claimed_at: null,
    });
    expect(
      await repo.claimEmail(
        org,
        pending.find((a) => a.kind === 'payment')!.id,
        true,
      ),
    ).toMatchObject({ kind: 'payment' });
  });
  it('records disabled email ahead of suppression and records missing recipients without retrying', async () => {
    await fallback();
    await client`UPDATE whatsapp_connections SET degraded_class='payment' WHERE org_id=${org}`;
    const pending = await repo.reconcile(org, true);
    const generic = pending.find((a) => a.kind === 'fallback')!;
    const payment = pending.find((a) => a.kind === 'payment')!;
    expect(
      await repo.claimEmail(org, generic.id, true, 'email_disabled'),
    ).toBeNull();
    expect(
      await repo.claimEmail(org, payment.id, true, 'no_recipient'),
    ).toBeNull();
    const rows = await client<
      { email_error: string }[]
    >`SELECT email_error FROM whatsapp_sender_alerts ORDER BY kind`;
    expect(rows.map((r) => r.email_error)).toEqual([
      'email_disabled',
      'no_recipient',
    ]);
    expect(await repo.reconcile(org, true)).toEqual([]);
    expect(await repo.read(org, true)).toHaveLength(2);
  });
  it.each(['payload', 'unknown', 'recipient'])(
    'does not alert for staff-only or recipient failure %s',
    async (failureClass) => {
      await fallback(failureClass);
      expect(await repo.read(org, true)).toEqual([]);
    },
  );
  it('ignores normal shared sends, old generations, failed sends and disabled fallback', async () => {
    await client`INSERT INTO verification_message_dispatches(org_id,state,accepted_at,sender_kind,sender_reason) VALUES (${org},'accepted',now(),'akeed_system','no_connection')`;
    expect(await repo.read(org, true)).toEqual([]);
    await fallback();
    expect(await repo.read(org, false)).toEqual([]);
    await client`UPDATE whatsapp_connections SET signup_generation=2 WHERE org_id=${org}`;
    expect(await repo.read(org, true)).toEqual([]);
  });
  it('closes transient fallback after a newer accepted merchant send', async () => {
    await fallback();
    const [incident] = await repo.reconcile(org, true);
    await client`INSERT INTO verification_message_dispatches(org_id,state,accepted_at,sender_kind,sender_connection_id,sender_connection_generation) VALUES (${org},'accepted',now()+interval '1 second','merchant_own',${connection},1)`;
    expect(await repo.read(org, true)).toEqual([]);
    expect(await repo.reconcile(org, true)).toEqual([]);
    expect(await repo.claimEmail(org, incident.id, true)).toBeNull();
  });
  it('enforces tenant scoping, composite ownership and private RLS access', async () => {
    await client`UPDATE whatsapp_connections SET quality_rating='RED' WHERE org_id=${org}`;
    const [incident] = await repo.reconcile(org, true);
    expect(await repo.read(otherOrg, true)).toEqual([]);
    expect(await repo.claimEmail(otherOrg, incident.id, true)).toBeNull();
    await repo.markEmail(otherOrg, incident.id, 'sent');
    expect(
      (
        await client`SELECT email_status FROM whatsapp_sender_alerts WHERE id=${incident.id}`
      )[0].email_status,
    ).toBe('pending');
    await expect(
      client`INSERT INTO whatsapp_sender_alerts(org_id,connection_id,signup_generation,kind,reason,dedupe_key) VALUES (${otherOrg},${connection},1,'fallback','x','x')`,
    ).rejects.toMatchObject({ code: '23503' });
    const [rls] =
      await client`SELECT relrowsecurity FROM pg_class WHERE oid='whatsapp_sender_alerts'::regclass`;
    expect(rls.relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const [grant] =
        await client`SELECT has_table_privilege(${role},'whatsapp_sender_alerts','SELECT') AS allowed`;
      expect(grant.allowed).toBe(false);
    }
    await client.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE service_role');
      expect(
        await tx.unsafe('SELECT id FROM whatsapp_sender_alerts'),
      ).toHaveLength(1);
    });
  });
});
