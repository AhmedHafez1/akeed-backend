import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import {
  StandaloneOrganizationProvisioningRepository,
  StandaloneSourceConflictError,
} from '../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';

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

const namespace = `e03_standalone_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 4,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const repository = new StandaloneOrganizationProvisioningRepository(
  drizzle(client, { schema }),
  standaloneCreditBillingConfigService(),
);
let created = false;

function autoActivationStatements(): string[] {
  return readFileSync(
    resolve(__dirname, '../drizzle/0035_standalone_auto_activation.sql'),
    'utf8',
  )
    .replaceAll('"public".', '')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.trim());
}

async function seedPendingOrganization(
  label: string,
  options: { owners?: number; freeGrant?: boolean } = {},
) {
  const orgId = randomUUID();
  const ownerIds = Array.from({ length: options.owners ?? 1 }, () =>
    randomUUID(),
  );
  await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${label}, ${`${label}-${orgId}`})`;
  for (const ownerId of ownerIds)
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner')`;
  await client`INSERT INTO integrations (org_id, platform_type, platform_store_url) VALUES (${orgId}, 'standalone', ${`standalone:${orgId}`})`;
  await client`INSERT INTO credit_accounts (org_id) VALUES (${orgId})`;
  if (options.freeGrant) {
    await client`
      INSERT INTO credit_ledger_entries (org_id, type, quantity, idempotency_key, actor_id, reason, posted_balance_before, posted_balance_after)
      VALUES (${orgId}, 'free_grant', 30, ${`standalone-free-grant:${orgId}:v1`}, ${ownerIds[0]}, 'staff approval', 0, 30)
    `;
    await client`UPDATE credit_accounts SET posted_balance = 30, version = version + 1 WHERE org_id = ${orgId}`;
  }
  return { orgId, ownerId: ownerIds[0] };
}

const backfill: {
  pending?: { orgId: string; ownerId: string };
  granted?: { orgId: string; ownerId: string };
} = {};

/**
 * Replays 0035 the way production meets it: a conflicting pending organization
 * aborts the whole migration, and once it is resolved every remaining pending
 * account is activated with exactly one launch grant.
 */
async function replayAutoActivationMigration() {
  backfill.pending = await seedPendingOrganization('pending');
  backfill.granted = await seedPendingOrganization('granted', {
    freeGrant: true,
  });
  const conflict = await seedPendingOrganization('co-owned', { owners: 2 });

  const statements = autoActivationStatements();
  await expect(
    client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    }),
  ).rejects.toThrow(conflict.orgId);
  await expect(
    client`SELECT status::text FROM credit_accounts WHERE org_id = ${backfill.pending.orgId}`,
  ).resolves.toEqual([{ status: 'pending_approval' }]);

  await client`DELETE FROM memberships WHERE org_id = ${conflict.orgId} AND user_id <> ${conflict.ownerId}`;
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

describe('standalone source provisioning PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        plan_type text DEFAULT 'free',
        wa_phone_number_id text,
        wa_business_account_id text,
        wa_access_token text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text DEFAULT 'owner',
        created_at timestamptz DEFAULT now(),
        UNIQUE (org_id, user_id)
      );
      -- The pre-0035 credit shape from 0032, so the auto-activation migration
      -- is replayed against the columns, checks and triggers it rewrites.
      CREATE TYPE credit_account_status AS ENUM ('pending_approval', 'active', 'suspended');
      CREATE TYPE credit_ledger_type AS ENUM ('free_grant', 'purchase', 'consumption', 'failure_reversal', 'refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement', 'staff_adjustment');
      CREATE TABLE credit_accounts (
        org_id uuid PRIMARY KEY REFERENCES organizations(id),
        status credit_account_status NOT NULL DEFAULT 'pending_approval',
        posted_balance integer NOT NULL DEFAULT 0,
        held_credits integer NOT NULL DEFAULT 0 CHECK (held_credits >= 0),
        approved_by uuid,
        approved_at timestamptz,
        approval_reason text,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT credit_account_approval_check CHECK ((approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reason IS NOT NULL AND length(trim(approval_reason)) > 0))
      );
      CREATE INDEX credit_account_status_idx ON credit_accounts (status);
      CREATE TABLE credit_ledger_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES credit_accounts(org_id),
        type credit_ledger_type NOT NULL,
        quantity integer NOT NULL CHECK (quantity <> 0),
        idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
        reservation_id uuid,
        dispatch_id uuid,
        purchase_id uuid,
        source_ledger_entry_id uuid,
        source_reference text,
        actor_id uuid,
        reason text NOT NULL CHECK (length(trim(reason)) > 0),
        posted_balance_before integer NOT NULL,
        posted_balance_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT credit_ledger_idempotency_key UNIQUE (org_id, idempotency_key),
        CONSTRAINT credit_ledger_projection_check CHECK (posted_balance_before::bigint + quantity::bigint = posted_balance_after),
        CONSTRAINT credit_ledger_free_grant_source_check CHECK (type <> 'free_grant' OR (quantity > 0 AND actor_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL))
      );
      CREATE UNIQUE INDEX credit_ledger_free_grant_key ON credit_ledger_entries (org_id) WHERE type = 'free_grant';
      CREATE FUNCTION guard_credit_account_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version::bigint <> OLD.version::bigint + 1 THEN
          RAISE EXCEPTION 'Account updates require a new version and stable identity' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER credit_account_version_guard BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION guard_credit_account_version();
      CREATE TABLE billing_free_plan_claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        platform_type text NOT NULL
      );
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        access_token text,
        expires_at timestamptz,
        webhook_secret text,
        is_active boolean DEFAULT true,
        last_synced_at timestamptz,
        metadata jsonb DEFAULT '{}'::jsonb,
        store_name varchar(255),
        default_language text DEFAULT 'auto' NOT NULL,
        cod_template_ar_variant text DEFAULT 'standard' NOT NULL,
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL,
        shipping_currency text DEFAULT 'USD' NOT NULL,
        avg_shipping_cost numeric(10,2) DEFAULT 3 NOT NULL,
        is_auto_verify_enabled boolean DEFAULT true NOT NULL,
        onboarding_status text DEFAULT 'pending' NOT NULL,
        billing_plan_id text,
        pending_billing_plan_id text,
        shopify_subscription_id text,
        billing_status text,
        billing_initiated_at timestamptz,
        billing_activated_at timestamptz,
        billing_canceled_at timestamptz,
        billing_status_updated_at timestamptz,
        follow_up_enabled boolean DEFAULT true NOT NULL,
        follow_up_delay_minutes integer DEFAULT 120 NOT NULL,
        escalation_enabled boolean DEFAULT true NOT NULL,
        escalation_delay_minutes integer DEFAULT 360 NOT NULL,
        quiet_hours_enabled boolean DEFAULT false NOT NULL,
        quiet_hours_start text,
        quiet_hours_end text,
        timezone text DEFAULT 'Asia/Riyadh' NOT NULL,
        send_delay_minutes integer DEFAULT 0 NOT NULL,
        country_code varchar(2),
        shop_timezone text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE (platform_type, platform_store_url),
        UNIQUE (id, org_id)
      );
    `);

    const conflictingOrg = randomUUID();
    await client`INSERT INTO organizations (id, name, slug) VALUES (${conflictingOrg}, 'Conflict', 'conflict')`;
    await client`
      INSERT INTO integrations (org_id, platform_type, platform_store_url)
      VALUES
        (${conflictingOrg}, 'shopify', 'one.myshopify.com'),
        (${conflictingOrg}, 'standalone', 'standalone:conflict')
    `;

    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0026_standalone_source_provisioning.sql'),
      'utf8',
    );
    const statements = migration.split('--> statement-breakpoint');
    await expect(client.unsafe(statements[0])).rejects.toThrow(
      'conflicting_org_count=1',
    );
    await client`
      DELETE FROM integrations
      WHERE org_id = ${conflictingOrg} AND platform_type = 'standalone'
    `;
    for (const statement of statements) await client.unsafe(statement);
    await replayAutoActivationMigration();
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('creates one complete source package and returns it on concurrent retries', async () => {
    const userId = randomUUID();
    const results = await Promise.all([
      repository.provision(userId, 'First name'),
      repository.provision(userId, 'Retry name'),
      repository.provision(userId, 'Concurrent retry'),
    ]);

    expect(new Set(results.map((result) => result.organization.id)).size).toBe(
      1,
    );
    expect(new Set(results.map((result) => result.integration.id)).size).toBe(
      1,
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => result.sourceCreated)).toHaveLength(1);
    expect(results[0].integration).toMatchObject({
      platformType: 'standalone',
      platformStoreUrl: `standalone:${results[0].organization.id}`,
      accessToken: null,
      webhookSecret: null,
      isActive: true,
      isAutoVerifyEnabled: false,
      assumeCodWhenPaymentMissing: false,
      onboardingStatus: 'pending',
    });

    const [counts] = await client<
      { organizations: number; memberships: number; integrations: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM organizations WHERE id = ${results[0].organization.id}) AS organizations,
        (SELECT count(*)::int FROM memberships WHERE user_id = ${userId}) AS memberships,
        (SELECT count(*)::int FROM integrations WHERE org_id = ${results[0].organization.id}) AS integrations
    `;
    expect(counts).toEqual({
      organizations: 1,
      memberships: 1,
      integrations: 1,
    });

    await expect(
      client`
        INSERT INTO integrations (org_id, platform_type, platform_store_url)
        VALUES (${results[0].organization.id}, 'shopify', 'second.myshopify.com')
      `,
    ).rejects.toThrow();
  });

  it('allows exactly one winner when competing active sources race', async () => {
    const orgId = randomUUID();
    await client`
      INSERT INTO organizations (id, name, slug)
      VALUES (${orgId}, 'Concurrent source guard', ${`race-${orgId}`})
    `;

    const attempts = await Promise.allSettled([
      client`
        INSERT INTO integrations (org_id, platform_type, platform_store_url)
        VALUES (${orgId}, 'standalone', ${`standalone:${orgId}`})
      `,
      client`
        INSERT INTO integrations (org_id, platform_type, platform_store_url)
        VALUES (${orgId}, 'shopify', ${`${orgId}.myshopify.com`})
      `,
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      client`SELECT id FROM integrations WHERE org_id = ${orgId} AND is_active = true`,
    ).resolves.toHaveLength(1);
  });

  it('rolls back a failed package and resumes successfully', async () => {
    const userId = randomUUID();
    await client.unsafe(`
      CREATE FUNCTION reject_standalone_source() RETURNS trigger AS $$
      BEGIN
        IF NEW.platform_type = 'standalone' THEN
          RAISE EXCEPTION 'injected source failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_standalone_source_trigger
      BEFORE INSERT ON integrations
      FOR EACH ROW EXECUTE FUNCTION reject_standalone_source();
    `);

    try {
      await repository.provision(userId, 'Rollback');
      throw new Error('Expected injected provisioning failure');
    } catch (error) {
      expect(
        (error as { cause?: { message?: string } }).cause?.message,
      ).toContain('injected source failure');
    }
    expect(
      await client`SELECT id FROM memberships WHERE user_id = ${userId}`,
    ).toHaveLength(0);
    expect(
      await client`SELECT id FROM organizations WHERE slug = ${`standalone-${userId}`}`,
    ).toHaveLength(0);

    await client`DROP TRIGGER reject_standalone_source_trigger ON integrations`;
    await client`DROP FUNCTION reject_standalone_source()`;
    await expect(
      repository.provision(userId, 'Recovered'),
    ).resolves.toMatchObject({ created: true, sourceCreated: true });
  });

  it('resumes an existing organization that has no source', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    await client`
      INSERT INTO organizations (id, name, slug)
      VALUES (${orgId}, 'Existing workspace', ${`standalone-${userId}`})
    `;
    await client`
      INSERT INTO memberships (org_id, user_id, role)
      VALUES (${orgId}, ${userId}, 'owner')
    `;

    await expect(
      repository.provision(userId, 'Ignored name'),
    ).resolves.toMatchObject({
      organization: { id: orgId, name: 'Existing workspace' },
      integration: {
        orgId,
        platformStoreUrl: `standalone:${orgId}`,
      },
      created: false,
      sourceCreated: true,
    });
  });

  it('rejects an existing Shopify owner without changing that source', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const integrationId = randomUUID();
    await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Shopify', ${`shopify-${orgId}`})`;
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await client`
      INSERT INTO integrations (id, org_id, platform_type, platform_store_url, access_token)
      VALUES (${integrationId}, ${orgId}, 'shopify', ${`${orgId}.myshopify.com`}, 'preserved-token')
    `;

    await expect(
      repository.provision(userId, 'Standalone'),
    ).rejects.toBeInstanceOf(StandaloneSourceConflictError);
    const [source] = await client<
      { platform_type: string; access_token: string; is_active: boolean }[]
    >`SELECT platform_type, access_token, is_active FROM integrations WHERE id = ${integrationId}`;
    expect(source).toEqual({
      platform_type: 'shopify',
      access_token: 'preserved-token',
      is_active: true,
    });
  });

  it('rejects an inactive native source owner instead of converting it', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const integrationId = randomUUID();
    await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Historical source', ${`historical-${orgId}`})`;
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await client`
      INSERT INTO integrations (id, org_id, platform_type, platform_store_url, is_active)
      VALUES (${integrationId}, ${orgId}, 'easyorders', ${`historical-${orgId}.example`}, false)
    `;

    await expect(
      repository.provision(userId, 'Standalone replacement'),
    ).rejects.toBeInstanceOf(StandaloneSourceConflictError);
    await expect(
      client`SELECT platform_type, is_active FROM integrations WHERE id = ${integrationId}`,
    ).resolves.toEqual([{ platform_type: 'easyorders', is_active: false }]);
  });

  it('does not claim an organization whose deterministic slug is already owned', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    await client`
      INSERT INTO organizations (id, name, slug)
      VALUES (${orgId}, 'Existing owner', ${`standalone-${userId}`})
    `;

    await expect(
      repository.provision(userId, 'New owner'),
    ).rejects.toBeInstanceOf(StandaloneSourceConflictError);
    expect(
      await client`SELECT id FROM memberships WHERE user_id = ${userId}`,
    ).toHaveLength(0);
  });

  it('activates pending accounts once and drops the approval shape', async () => {
    const accounts = await client<
      { org_id: string; status: string; posted_balance: number }[]
    >`SELECT org_id, status::text, posted_balance FROM credit_accounts WHERE org_id IN (${backfill.pending!.orgId}, ${backfill.granted!.orgId})`;
    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.status === 'active')).toBe(true);
    expect(accounts.every((account) => account.posted_balance === 30)).toBe(
      true,
    );

    const grants = await client<
      { org_id: string; actor_id: string; quantity: number; reason: string }[]
    >`SELECT org_id, actor_id, quantity, reason FROM credit_ledger_entries WHERE type = 'free_grant' AND org_id IN (${backfill.pending!.orgId}, ${backfill.granted!.orgId})`;
    expect(grants).toHaveLength(2);
    expect(
      grants.find((grant) => grant.org_id === backfill.pending!.orgId),
    ).toEqual({
      org_id: backfill.pending!.orgId,
      actor_id: backfill.pending!.ownerId,
      quantity: 30,
      reason: 'auto_activation_backfill',
    });
    expect(
      grants.find((grant) => grant.org_id === backfill.granted!.orgId),
    ).toMatchObject({ reason: 'staff approval' });

    await expect(
      client`SELECT enum_range(NULL::credit_account_status)::text AS range`,
    ).resolves.toEqual([{ range: '{active,suspended}' }]);
    await expect(
      client`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${namespace} AND table_name = 'credit_accounts'
          AND column_name IN ('approved_by', 'approved_at', 'approval_reason')
      `,
    ).resolves.toHaveLength(0);
  });

  it('opens an active account with exactly one launch grant on signup', async () => {
    const userId = randomUUID();
    const results = await Promise.all([
      repository.provision(userId, 'Signup'),
      repository.provision(userId, 'Signup retry'),
    ]);
    const orgId = results[0].organization.id;

    await expect(
      client`SELECT status::text, posted_balance, held_credits, version FROM credit_accounts WHERE org_id = ${orgId}`,
    ).resolves.toEqual([
      { status: 'active', posted_balance: 30, held_credits: 0, version: 0 },
    ]);
    await expect(
      client`
        SELECT type::text, quantity, actor_id, reason, idempotency_key, posted_balance_before, posted_balance_after
        FROM credit_ledger_entries WHERE org_id = ${orgId}
      `,
    ).resolves.toEqual([
      {
        type: 'free_grant',
        quantity: 30,
        actor_id: userId,
        reason: 'signup_auto_activation',
        idempotency_key: `standalone-free-grant:${orgId}:v1`,
        posted_balance_before: 0,
        posted_balance_after: 30,
      },
    ]);

    await repository.provision(userId, 'Later sign-in');
    await expect(
      client`SELECT count(*)::int AS count FROM credit_ledger_entries WHERE org_id = ${orgId}`,
    ).resolves.toEqual([{ count: 1 }]);
  });

  it('opens no credit account for a Shopify owner', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Shopify only', ${`shopify-only-${orgId}`})`;
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
    await client`INSERT INTO integrations (org_id, platform_type, platform_store_url) VALUES (${orgId}, 'shopify', ${`${orgId}.myshopify.com`})`;

    await expect(
      repository.provision(userId, 'Standalone'),
    ).rejects.toBeInstanceOf(StandaloneSourceConflictError);
    await expect(
      client`SELECT org_id FROM credit_accounts WHERE org_id = ${orgId}`,
    ).resolves.toHaveLength(0);
  });
});
