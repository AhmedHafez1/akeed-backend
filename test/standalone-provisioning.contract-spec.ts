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
);
let created = false;

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
});
