import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import {
  StandaloneOrganizationProvisioningRepository,
  buildStandaloneOrganizationSlug,
} from '../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import { evaluateStandalonePilot } from '../src/modules/admin/standalone-pilot.policy';
import { StandalonePilotRepository } from '../src/modules/admin/standalone-pilot.repository';

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

const namespace = `e03_pilot_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new StandalonePilotRepository(database);
const provisioning = new StandaloneOrganizationProvisioningRepository(
  database,
  standaloneCreditBillingConfigService(),
);
const usageRepository = new IntegrationMonthlyUsageRepository(database);
let created = false;

async function createOrganization(
  name: string,
  options: { source?: boolean; anchor?: string | null } = {},
) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await client`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${name}, ${buildStandaloneOrganizationSlug(userId)})`;
  await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')`;
  let integrationId: string | undefined;
  if (options.source) {
    integrationId = randomUUID();
    await client`INSERT INTO integrations (id, org_id, platform_type, platform_store_url, billing_activated_at) VALUES (${integrationId}, ${orgId}, 'standalone', ${`standalone:${orgId}`}, ${options.anchor ?? null})`;
  }
  return { orgId, userId, integrationId };
}

async function preview(orgId: string, staffId = randomUUID()) {
  const [snapshot] = await repository.loadSnapshots([orgId]);
  const evaluation = evaluateStandalonePilot(snapshot);
  const previewId = await repository.savePreview(staffId, [evaluation]);
  return {
    staffId,
    previewId,
    entry: { orgId, fingerprint: evaluation.fingerprint },
    evaluation,
  };
}

describe('Standalone pilot PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, plan_type text DEFAULT 'free', wa_phone_number_id text, wa_business_account_id text, wa_access_token text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL, role text DEFAULT 'owner', created_at timestamptz DEFAULT now(), UNIQUE(org_id,user_id));
      CREATE TABLE credit_accounts (
        org_id uuid PRIMARY KEY REFERENCES organizations(id),
        status text NOT NULL DEFAULT 'pending_approval',
        posted_balance integer NOT NULL DEFAULT 0,
        held_credits integer NOT NULL DEFAULT 0,
        approved_by uuid,
        approved_at timestamptz,
        approval_reason text,
        version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
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
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA ${namespace} TO anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ${namespace} TO anon, authenticated, service_role;
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

  it('activates Starter atomically, preserves usage, and makes replay a no-op', async () => {
    const account = await createOrganization('Existing account', {
      source: true,
      anchor: '2026-08-01T00:00:00Z',
    });
    await client`INSERT INTO integration_monthly_usage (org_id, integration_id, period_start, included_limit, consumed_count, blocked_count) VALUES (${account.orgId}, ${account.integrationId!}, '2026-08-01', 30, 7, 2)`;
    const prepared = await preview(account.orgId);
    const first = await repository.applyOrganization(
      prepared.entry,
      prepared.staffId,
      prepared.previewId,
      'Approved support request',
    );
    const repeated = await repository.applyOrganization(
      prepared.entry,
      prepared.staffId,
      prepared.previewId,
      'Approved support request',
    );
    expect(first.outcome).toBe('activated');
    expect(repeated).toMatchObject({
      outcome: 'already_applied',
      auditId: first.auditId,
    });
    const [source] =
      await client`SELECT billing_plan_id, billing_status, billing_activated_at FROM integrations WHERE id = ${account.integrationId!}`;
    expect(source).toMatchObject({
      billing_plan_id: 'starter',
      billing_status: 'not_required',
    });
    expect(new Date(source.billing_activated_at as string).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    const [usage] =
      await client`SELECT consumed_count, blocked_count FROM integration_monthly_usage WHERE integration_id = ${account.integrationId!}`;
    expect(usage).toMatchObject({ consumed_count: 7, blocked_count: 2 });
    const [auditCount] =
      await client`SELECT count(*)::int AS count FROM admin_access_audit WHERE action = 'standalone-pilot.activate' AND metadata->>'orgId' = ${account.orgId}`;
    expect(auditCount.count).toBe(1);
  });

  it('rolls back source and entitlement when the activation audit fails', async () => {
    const account = await createOrganization('Audit rollback');
    const prepared = await preview(account.orgId);
    await client.unsafe(
      `CREATE FUNCTION ${namespace}.reject_activation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'standalone-pilot.activate' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_activation_audit BEFORE INSERT ON admin_access_audit FOR EACH ROW EXECUTE FUNCTION ${namespace}.reject_activation_audit();`,
    );
    const failure = await repository
      .applyOrganization(
        prepared.entry,
        prepared.staffId,
        prepared.previewId,
        'Rollback test',
      )
      .catch((error: unknown) => error);
    expect(String((failure as { cause?: Error }).cause?.message)).toContain(
      'synthetic audit failure',
    );
    await client`DROP TRIGGER reject_activation_audit ON admin_access_audit`;
    await client.unsafe(`DROP FUNCTION ${namespace}.reject_activation_audit()`);
    const [count] =
      await client`SELECT count(*)::int AS count FROM integrations WHERE org_id = ${account.orgId}`;
    expect(count.count).toBe(0);
  });

  it('coordinates with signup and converges to one source and one entitlement', async () => {
    const account = await createOrganization('Concurrent account');
    let prepared = await preview(account.orgId);
    const [applyResult, provisionResult] = await Promise.all([
      repository.applyOrganization(
        prepared.entry,
        prepared.staffId,
        prepared.previewId,
        'Concurrent pilot',
      ),
      provisioning.provision(account.userId, 'Ignored retry name'),
    ]);
    expect(provisionResult.organization.id).toBe(account.orgId);
    if (applyResult.outcome === 'changed') {
      prepared = await preview(account.orgId, prepared.staffId);
      expect(
        (
          await repository.applyOrganization(
            prepared.entry,
            prepared.staffId,
            prepared.previewId,
            'Concurrent pilot retry',
          )
        ).outcome,
      ).toBe('activated');
    } else expect(applyResult.outcome).toBe('activated');
    const [state] =
      await client`SELECT count(*)::int AS count, min(billing_plan_id) AS plan, min(billing_status) AS status FROM integrations WHERE org_id = ${account.orgId}`;
    expect(state).toMatchObject({
      count: 1,
      plan: 'starter',
      status: 'not_required',
    });
  });

  it('rejects a stale preview without modifying new ownership', async () => {
    const account = await createOrganization('Stale account');
    const prepared = await preview(account.orgId);
    await client`INSERT INTO memberships (org_id, user_id, role) VALUES (${account.orgId}, ${randomUUID()}, 'owner')`;
    expect(
      await repository.applyOrganization(
        prepared.entry,
        prepared.staffId,
        prepared.previewId,
        'Stale test',
      ),
    ).toMatchObject({ outcome: 'changed', reason: 'preview_changed' });
    const [count] =
      await client`SELECT count(*)::int AS count FROM integrations WHERE org_id = ${account.orgId}`;
    expect(count.count).toBe(0);
  });

  it('enforces the Starter quota after activation', async () => {
    const account = await createOrganization('Quota account');
    const prepared = await preview(account.orgId);
    const activated = await repository.applyOrganization(
      prepared.entry,
      prepared.staffId,
      prepared.previewId,
      'Quota test',
    );
    const reservations = await Promise.all(
      Array.from({ length: 31 }, () =>
        usageRepository.reserveMonthlyVerificationSlot({
          id: activated.integrationId!,
          orgId: account.orgId,
        }),
      ),
    );
    expect(
      reservations.filter((reservation) => reservation.allowed),
    ).toHaveLength(30);
    expect(
      reservations.filter(
        (reservation) => reservation.reason === 'plan_limit_reached',
      ),
    ).toHaveLength(1);
  });

  it.each(['integrations', 'integration_monthly_usage', 'admin_access_audit'])(
    'preserves tenant reads but denies authenticated writes to %s',
    async (table) => {
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe('SET LOCAL ROLE authenticated');
          await tx.unsafe(`SELECT 1 FROM ${table} LIMIT 1`);
          await tx.unsafe(`DELETE FROM ${table} WHERE false`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    },
  );
});
