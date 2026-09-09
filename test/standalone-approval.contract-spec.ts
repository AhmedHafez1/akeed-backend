import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { CreditAccountingRepository } from '../src/infrastructure/database/repositories/credit-accounting.repository';
import {
  StandaloneOrganizationProvisioningRepository,
  buildStandaloneOrganizationSlug,
} from '../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import { evaluateStandaloneApproval } from '../src/modules/admin/standalone-billing.policy';
import {
  buildFreeGrantKey,
  StandaloneBillingRepository,
} from '../src/modules/admin/standalone-billing.repository';
import type { ApprovalApplyResult } from '../src/modules/admin/standalone-billing.types';

const FREE_GRANT = 30;

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
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

const namespace = `e045_approval_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const credits = new CreditAccountingRepository(database);
const repository = new StandaloneBillingRepository(database, credits);
const provisioning = new StandaloneOrganizationProvisioningRepository(
  database,
  standaloneCreditBillingConfigService({
    STANDALONE_CREDIT_BILLING_ENABLED: 'true',
    PAYMOB_MODE: 'test',
    PAYMOB_BASE_URL: 'http://localhost:9000',
    PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
    PAYMOB_RETURN_URL: 'http://localhost:9000',
    PAYMOB_SECRET_KEY: 'sandbox-secret',
    PAYMOB_PUBLIC_KEY: 'sandbox-public',
    PAYMOB_HMAC_SECRET: 'sandbox-hmac',
    PAYMOB_CARD_INTEGRATION_ID: 'card1',
    PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
    PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
  }),
);
let created = false;

async function createOrganization(
  name: string,
  options: { source?: boolean; anchor?: string | null } = {},
) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${name}, ${buildStandaloneOrganizationSlug(userId)})`;
  await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
  await client`INSERT INTO credit_accounts (org_id) VALUES (${orgId})`;
  let integrationId: string | undefined;
  if (options.source) {
    integrationId = randomUUID();
    await client`INSERT INTO integrations (id, org_id, platform_type, platform_store_url, billing_activated_at) VALUES (${integrationId}, ${orgId}, 'standalone', ${`standalone:${orgId}`}, ${options.anchor ?? null})`;
  }
  return { orgId, userId, integrationId };
}

async function preview(orgId: string, staffId = randomUUID()) {
  const [snapshot] = await repository.loadSnapshots([orgId]);
  const evaluation = evaluateStandaloneApproval(snapshot, FREE_GRANT);
  const previewId = await repository.savePreview(staffId, [evaluation]);
  return {
    staffId,
    previewId,
    entry: { orgId, fingerprint: evaluation.fingerprint },
    evaluation,
  };
}

function approve(
  prepared: Awaited<ReturnType<typeof preview>>,
  reason: string,
) {
  return repository.approveOrganization(
    prepared.entry,
    prepared.staffId,
    prepared.previewId,
    reason,
    FREE_GRANT,
  );
}

async function ledgerRows(orgId: string) {
  return client`SELECT type, quantity, idempotency_key, actor_id, posted_balance_before, posted_balance_after FROM credit_ledger_entries WHERE org_id = ${orgId}`;
}

describe('Standalone credit approval PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, plan_type text DEFAULT 'free', wa_phone_number_id text, wa_business_account_id text, wa_access_token text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL, role text DEFAULT 'owner', created_at timestamptz DEFAULT now(), UNIQUE(org_id,user_id));
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), platform_type text NOT NULL, platform_store_url text NOT NULL,
        access_token text, expires_at timestamptz, webhook_secret text, is_active boolean DEFAULT true, last_synced_at timestamptz, metadata jsonb DEFAULT '{}'::jsonb,
        store_name varchar(255), default_language text DEFAULT 'auto' NOT NULL, cod_template_ar_variant text DEFAULT 'standard' NOT NULL,
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL, shipping_currency text DEFAULT 'USD' NOT NULL, avg_shipping_cost numeric(10,2) DEFAULT 3 NOT NULL,
        is_auto_verify_enabled boolean DEFAULT false NOT NULL, assume_cod_when_payment_missing boolean DEFAULT false NOT NULL,
        onboarding_status text DEFAULT 'pending' NOT NULL, billing_plan_id text, pending_billing_plan_id text, shopify_subscription_id text, billing_status text,
        billing_initiated_at timestamptz, billing_activated_at timestamptz, billing_canceled_at timestamptz, billing_status_updated_at timestamptz,
        follow_up_enabled boolean DEFAULT true NOT NULL, follow_up_delay_minutes integer DEFAULT 120 NOT NULL, escalation_enabled boolean DEFAULT true NOT NULL,
        escalation_delay_minutes integer DEFAULT 360 NOT NULL, quiet_hours_enabled boolean DEFAULT false NOT NULL, quiet_hours_start text, quiet_hours_end text,
        timezone text DEFAULT 'Asia/Riyadh' NOT NULL, send_delay_minutes integer DEFAULT 0 NOT NULL, country_code varchar(2), shop_timezone text, created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), UNIQUE(platform_type,platform_store_url), UNIQUE(id,org_id)
      );
      CREATE UNIQUE INDEX integrations_one_active_source_per_org_idx ON integrations(org_id) WHERE is_active = true;
      CREATE TABLE integration_monthly_usage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), integration_id uuid NOT NULL,
        period_start date NOT NULL, included_limit integer NOT NULL, consumed_count integer DEFAULT 0 NOT NULL, blocked_count integer DEFAULT 0 NOT NULL,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(integration_id,period_start), FOREIGN KEY(integration_id,org_id) REFERENCES integrations(id,org_id)
      );
      CREATE TABLE billing_free_plan_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, platform_type text NOT NULL);
      CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, integration_id uuid NOT NULL, external_order_id text NOT NULL);
      CREATE TABLE admin_access_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text NOT NULL, outcome text NOT NULL, request_id text,
        target_integration_id uuid, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamptz DEFAULT now()
      );
      DO $$ BEGIN CREATE TYPE credit_account_status AS ENUM ('pending_approval', 'active', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE credit_ledger_type AS ENUM ('free_grant', 'purchase', 'consumption', 'failure_reversal', 'refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement', 'staff_adjustment'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
      CREATE TABLE credit_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES credit_accounts(org_id),
        quantity integer NOT NULL, status text NOT NULL DEFAULT 'held', CONSTRAINT credit_reservation_id_org_key UNIQUE (id, org_id)
      );
      CREATE TABLE credit_ledger_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES credit_accounts(org_id),
        type credit_ledger_type NOT NULL,
        quantity integer NOT NULL CHECK (quantity <> 0),
        idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
        reservation_id uuid, dispatch_id uuid, purchase_id uuid, source_ledger_entry_id uuid, source_reference text,
        actor_id uuid,
        reason text NOT NULL CHECK (length(trim(reason)) > 0),
        posted_balance_before integer NOT NULL,
        posted_balance_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT credit_ledger_id_org_key UNIQUE (id, org_id),
        CONSTRAINT credit_ledger_idempotency_key UNIQUE (org_id, idempotency_key),
        CONSTRAINT credit_ledger_projection_check CHECK (posted_balance_before::bigint + quantity::bigint = posted_balance_after),
        CONSTRAINT credit_ledger_sign_check CHECK ((type IN ('free_grant', 'purchase', 'failure_reversal', 'chargeback_reinstatement') AND quantity > 0) OR (type IN ('consumption', 'refund_reversal', 'chargeback_reversal') AND quantity < 0) OR type = 'staff_adjustment'),
        CONSTRAINT credit_ledger_source_check CHECK (type NOT IN ('free_grant', 'staff_adjustment') OR (reservation_id IS NULL AND dispatch_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL AND actor_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX credit_ledger_free_grant_key ON credit_ledger_entries (org_id) WHERE type = 'free_grant';
      CREATE OR REPLACE FUNCTION ${namespace}.protect_credit_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Credit and payment history is immutable' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION ${namespace}.protect_credit_history();
      CREATE OR REPLACE FUNCTION ${namespace}.guard_credit_account_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version::bigint <> OLD.version::bigint + 1 THEN
          RAISE EXCEPTION 'Account updates require a new version and stable identity' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER credit_account_version_guard BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION ${namespace}.guard_credit_account_version();
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA ${namespace} TO anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ${namespace} TO anon, authenticated, service_role;
      REVOKE ALL ON credit_accounts, credit_reservations, credit_ledger_entries FROM PUBLIC, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE ON credit_accounts, credit_reservations, credit_ledger_entries TO service_role;
      REVOKE UPDATE ON credit_ledger_entries FROM service_role;
    `);
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0027_standalone_pilot_permissions.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint'))
      await client.unsafe(statement);
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('activates the account, grants the launch credits once, and preserves history', async () => {
    const account = await createOrganization('Existing merchant', {
      source: true,
      anchor: '2026-08-01T00:00:00Z',
    });
    await client`INSERT INTO integration_monthly_usage (org_id, integration_id, period_start, included_limit, consumed_count, blocked_count) VALUES (${account.orgId}, ${account.integrationId!}, '2026-08-01', 30, 7, 2)`;
    const prepared = await preview(account.orgId);

    const first = await approve(prepared, 'Approved support request');
    const repeated = await approve(prepared, 'Approved support request');

    expect(first).toMatchObject({
      outcome: 'approved',
      reason: 'activate_source',
      grantedCredits: FREE_GRANT,
    });
    expect(repeated).toMatchObject({
      outcome: 'already_applied',
      reason: 'already_approved',
      auditId: first.auditId,
    });
    const ledger = await ledgerRows(account.orgId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'free_grant',
      quantity: FREE_GRANT,
      idempotency_key: buildFreeGrantKey(account.orgId),
      actor_id: prepared.staffId,
      posted_balance_before: 0,
      posted_balance_after: FREE_GRANT,
    });
    const [state] =
      await client`SELECT status, posted_balance, held_credits, version, approved_by, approval_reason FROM credit_accounts WHERE org_id = ${account.orgId}`;
    expect(state).toMatchObject({
      status: 'active',
      posted_balance: FREE_GRANT,
      held_credits: 0,
      version: 1,
      approved_by: prepared.staffId,
      approval_reason: 'Approved support request',
    });
    expect(await credits.checkInvariant(account.orgId)).toMatchObject({
      consistent: true,
    });
    // Old monthly usage is neither converted into nor subtracted from credits.
    const [usage] =
      await client`SELECT consumed_count, blocked_count FROM integration_monthly_usage WHERE integration_id = ${account.integrationId!}`;
    expect(usage).toMatchObject({ consumed_count: 7, blocked_count: 2 });
    const [source] =
      await client`SELECT billing_plan_id, billing_status, billing_activated_at FROM integrations WHERE id = ${account.integrationId!}`;
    expect(source).toMatchObject({
      billing_plan_id: 'starter',
      billing_status: 'not_required',
    });
    expect(new Date(source.billing_activated_at as string).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    const [auditCount] =
      await client`SELECT count(*)::int AS count FROM admin_access_audit WHERE action = 'standalone-billing.approve' AND metadata->>'orgId' = ${account.orgId}`;
    expect(auditCount.count).toBe(1);
  });

  it('reports an already approved organization without granting a second time', async () => {
    const account = await createOrganization('Repeat approval');
    const first = await preview(account.orgId);
    await approve(first, 'First approval');

    const second = await preview(account.orgId);

    expect(second.evaluation.row.status).toBe('already_approved');
    expect(await approve(second, 'Second approval')).toMatchObject({
      outcome: 'unchanged',
      reason: 'already_approved',
    });
    expect(await ledgerRows(account.orgId)).toHaveLength(1);
  });

  it('grants once under concurrent approvals of the same organization', async () => {
    const account = await createOrganization('Concurrent approval');
    const prepared = await Promise.all([
      preview(account.orgId),
      preview(account.orgId),
      preview(account.orgId),
      preview(account.orgId),
    ]);

    const outcomes = await Promise.all(
      prepared.map((entry, index) =>
        approve(entry, `Concurrent approval ${index}`).catch(
          (error: unknown) => error,
        ),
      ),
    );

    expect(
      outcomes.filter(
        (outcome) => (outcome as { outcome?: string }).outcome === 'approved',
      ),
    ).toHaveLength(1);
    expect(await ledgerRows(account.orgId)).toHaveLength(1);
    const [state] =
      await client`SELECT status, posted_balance, version FROM credit_accounts WHERE org_id = ${account.orgId}`;
    expect(state).toMatchObject({
      status: 'active',
      posted_balance: FREE_GRANT,
      version: 1,
    });
  });

  it('rolls the grant back when the approval audit fails', async () => {
    const account = await createOrganization('Audit rollback');
    const prepared = await preview(account.orgId);
    await client.unsafe(
      `CREATE FUNCTION ${namespace}.reject_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'standalone-billing.approve' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_approval_audit BEFORE INSERT ON admin_access_audit FOR EACH ROW EXECUTE FUNCTION ${namespace}.reject_approval_audit();`,
    );

    const failure = await approve(prepared, 'Rollback test').catch(
      (error: unknown) => error,
    );

    expect(String((failure as { cause?: Error }).cause?.message)).toContain(
      'synthetic audit failure',
    );
    await client`DROP TRIGGER reject_approval_audit ON admin_access_audit`;
    await client.unsafe(`DROP FUNCTION ${namespace}.reject_approval_audit()`);
    expect(await ledgerRows(account.orgId)).toHaveLength(0);
    const [state] =
      await client`SELECT status, posted_balance, version FROM credit_accounts WHERE org_id = ${account.orgId}`;
    expect(state).toMatchObject({
      status: 'pending_approval',
      posted_balance: 0,
      version: 0,
    });
    const [sources] =
      await client`SELECT count(*)::int AS count FROM integrations WHERE org_id = ${account.orgId}`;
    expect(sources.count).toBe(0);
  });

  it('rejects a stale preview without granting or creating a source', async () => {
    const account = await createOrganization('Stale preview');
    const prepared = await preview(account.orgId);
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${account.orgId}, ${randomUUID()}, 'owner')`;

    expect(await approve(prepared, 'Stale test')).toMatchObject({
      outcome: 'changed',
      reason: 'preview_changed',
    });
    expect(await ledgerRows(account.orgId)).toHaveLength(0);
    const [sources] =
      await client`SELECT count(*)::int AS count FROM integrations WHERE org_id = ${account.orgId}`;
    expect(sources.count).toBe(0);
  });

  it('drifts a preview when the credit account changes after it was taken', async () => {
    const account = await createOrganization('Credit drift');
    const prepared = await preview(account.orgId);
    await client`UPDATE credit_accounts SET status = 'suspended', version = version + 1 WHERE org_id = ${account.orgId}`;

    expect(await approve(prepared, 'Drift test')).toMatchObject({
      outcome: 'changed',
      reason: 'preview_changed',
    });
    expect(await ledgerRows(account.orgId)).toHaveLength(0);
  });

  it('keeps successful rows when another organization in the batch fails', async () => {
    const staffId = randomUUID();
    const healthy = await createOrganization('Batch healthy');
    const drifting = await createOrganization('Batch drifting');
    const snapshots = await repository.loadSnapshots([
      healthy.orgId,
      drifting.orgId,
    ]);
    const evaluations = snapshots.map((snapshot) =>
      evaluateStandaloneApproval(snapshot, FREE_GRANT),
    );
    const previewId = await repository.savePreview(staffId, evaluations);
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${drifting.orgId}, ${randomUUID()}, 'owner')`;

    const results: ApprovalApplyResult[] = [];
    for (const [index, orgId] of [healthy.orgId, drifting.orgId].entries()) {
      results.push(
        await repository.approveOrganization(
          { orgId, fingerprint: evaluations[index].fingerprint },
          staffId,
          previewId,
          'Batch approval',
          FREE_GRANT,
        ),
      );
    }

    expect(results.map((result) => result.outcome)).toEqual([
      'approved',
      'changed',
    ]);
    expect(await ledgerRows(healthy.orgId)).toHaveLength(1);
    expect(await ledgerRows(drifting.orgId)).toHaveLength(0);
  });

  it.each([
    [
      'a Shopify source',
      async (orgId: string) => {
        await client`INSERT INTO integrations (org_id, platform_type, platform_store_url) VALUES (${orgId}, 'shopify', ${`${orgId}.myshopify.com`})`;
      },
      'native_source',
    ],
    [
      'a second owner',
      async (orgId: string) => {
        await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${randomUUID()}, 'owner')`;
      },
      'multiple_owners',
    ],
  ] as [string, (orgId: string) => Promise<void>, string][])(
    'never converts an organization with %s',
    async (_label, seed, reason) => {
      const account = await createOrganization(`Excluded ${reason}`);
      await seed(account.orgId);
      const prepared = await preview(account.orgId);

      expect(prepared.evaluation.row.reason).toBe(reason);
      expect(await approve(prepared, 'Excluded test')).toMatchObject({
        reason,
      });
      expect(await ledgerRows(account.orgId)).toHaveLength(0);
    },
  );

  it('coordinates with signup and converges on one source and one grant', async () => {
    const account = await createOrganization('Concurrent signup');
    let prepared = await preview(account.orgId);

    const [approval, provisioned] = await Promise.all([
      approve(prepared, 'Concurrent signup'),
      provisioning.provision(account.userId, 'Ignored retry name'),
    ]);

    expect(provisioned.organization.id).toBe(account.orgId);
    if (approval.outcome === 'changed') {
      prepared = await preview(account.orgId, prepared.staffId);
      expect((await approve(prepared, 'Concurrent retry')).outcome).toBe(
        'approved',
      );
    } else expect(approval.outcome).toBe('approved');
    const [state] =
      await client`SELECT count(*)::int AS count FROM integrations WHERE org_id = ${account.orgId}`;
    expect(state.count).toBe(1);
    expect(await ledgerRows(account.orgId)).toHaveLength(1);
  });

  it('denies authenticated writes to the credit ledger', async () => {
    await expect(
      client.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE authenticated');
        await tx.unsafe('DELETE FROM credit_ledger_entries WHERE false');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
