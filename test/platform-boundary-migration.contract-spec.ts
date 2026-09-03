import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

function gateDatabaseUrl(): string {
  const value = process.env.E02_GATE_TEST_DATABASE_URL;
  if (!value) {
    throw new Error(
      'NOT RUN: E02_GATE_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NOT RUN: invalid E02 gate database URL (value withheld).');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e02_gate_test' ||
    url.username !== 'e02_gate_test' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e02_gate_test, database akeed_e02_gate_test, without query parameters.',
    );
  }
  return value;
}

const namespace = `e02_gate_${randomUUID().replaceAll('-', '')}`;
const client = postgres(gateDatabaseUrl(), {
  max: 2,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const orgId = randomUUID();
const integrationId = randomUUID();
const orderId = randomUUID();
const verificationId = randomUUID();
const usageId = randomUUID();
const webhookId = randomUUID();
const lifecycleId = randomUUID();
let created = false;

function migrationStatements(fileName: string): string[] {
  return readFileSync(resolve(__dirname, `../drizzle/${fileName}`), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(fileName: string): Promise<void> {
  for (const statement of migrationStatements(fileName)) {
    await client.unsafe(statement.replaceAll('"public".', `"${namespace}".`));
  }
}

async function retainedCounts() {
  const [counts] = await client<
    {
      integrations: number;
      orders: number;
      verifications: number;
      usage: number;
      webhooks: number;
      lifecycles: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM integrations) AS integrations,
      (SELECT count(*)::int FROM orders) AS orders,
      (SELECT count(*)::int FROM verifications) AS verifications,
      (SELECT count(*)::int FROM integration_monthly_usage) AS usage,
      (SELECT count(*)::int FROM webhook_events) AS webhooks,
      (SELECT count(*)::int FROM admin_store_lifecycles) AS lifecycles
  `;
  return counts;
}

describe('E02 expand/backfill/deploy rollback PostgreSQL rehearsal', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TYPE webhook_event_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'skipped');
      CREATE TABLE integrations (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        access_token text,
        webhook_secret text,
        shopify_subscription_id text,
        is_active boolean DEFAULT true,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT integrations_platform_type_check CHECK (platform_type = ANY (ARRAY['shopify', 'salla', 'zid', 'woocommerce']))
      );
      CREATE TABLE billing_free_plan_claims (
        id uuid PRIMARY KEY,
        platform_type text NOT NULL,
        CONSTRAINT billing_free_plan_claims_platform_type_check CHECK (platform_type = ANY (ARRAY['shopify', 'salla', 'zid', 'woocommerce']))
      );
      CREATE TABLE orders (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid,
        external_order_id text NOT NULL,
        customer_phone text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT orders_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE,
        UNIQUE (integration_id, external_order_id)
      );
      CREATE TABLE integration_monthly_usage (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        consumed_count integer DEFAULT 0 NOT NULL,
        CONSTRAINT integration_monthly_usage_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
      );
      CREATE TABLE verifications (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        order_id uuid NOT NULL,
        CONSTRAINT verifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
      CREATE TABLE webhook_events (
        id uuid PRIMARY KEY,
        platform text NOT NULL,
        job_type text NOT NULL,
        idempotency_key text NOT NULL,
        store_domain text NOT NULL,
        org_id uuid,
        integration_id uuid,
        status webhook_event_status DEFAULT 'pending' NOT NULL,
        attempts integer DEFAULT 0 NOT NULL,
        last_error text,
        raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
        received_at timestamptz DEFAULT now() NOT NULL,
        processed_at timestamptz,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        CONSTRAINT webhook_events_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE,
        CONSTRAINT webhook_events_platform_idempotency_key UNIQUE (platform, idempotency_key)
      );
      CREATE TABLE admin_store_lifecycles (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        CONSTRAINT admin_store_lifecycles_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
      );
    `);
    await client`
      INSERT INTO integrations (
        id, org_id, platform_type, platform_store_url, access_token,
        webhook_secret, shopify_subscription_id
      ) VALUES (
        ${integrationId}, ${orgId}, 'shopify', 'legacy.myshopify.com',
        'synthetic-encrypted-token', 'synthetic-webhook-secret',
        'gid://shopify/AppSubscription/synthetic'
      )
    `;
    await client`INSERT INTO billing_free_plan_claims VALUES (${randomUUID()}, 'shopify')`;
    await client`
      INSERT INTO orders (id, org_id, external_order_id, customer_phone)
      VALUES (${orderId}, ${orgId}, 'legacy-order', '+201000000000')
    `;
    await client`INSERT INTO verifications VALUES (${verificationId}, ${orgId}, ${orderId})`;
    await client`
      INSERT INTO integration_monthly_usage (id, org_id, integration_id, consumed_count)
      VALUES (${usageId}, ${orgId}, ${integrationId}, 7)
    `;
    await client`
      INSERT INTO webhook_events (
        id, platform, job_type, idempotency_key, store_domain, org_id
      ) VALUES (
        ${webhookId}, 'shopify', 'order.create', 'legacy-delivery',
        'legacy.myshopify.com', ${orgId}
      )
    `;
    await client`INSERT INTO admin_store_lifecycles VALUES (${lifecycleId}, ${orgId}, ${integrationId})`;
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('blocks rollout while ownership is ambiguous and reports the exception count', async () => {
    const ambiguousOrg = randomUUID();
    const firstSource = randomUUID();
    const secondSource = randomUUID();
    const ambiguousOrder = randomUUID();
    await client`
      INSERT INTO integrations (id, org_id, platform_type, platform_store_url)
      VALUES
        (${firstSource}, ${ambiguousOrg}, 'shopify', 'ambiguous-one.myshopify.com'),
        (${secondSource}, ${ambiguousOrg}, 'shopify', 'ambiguous-two.myshopify.com')
    `;
    await client`
      INSERT INTO orders (id, org_id, external_order_id, customer_phone)
      VALUES (${ambiguousOrder}, ${ambiguousOrg}, 'ambiguous-order', '+201000000001')
    `;

    const preflight = await client<
      { ambiguous_orders: number }[]
    >`SELECT count(*)::int AS ambiguous_orders FROM orders o WHERE o.integration_id IS NULL AND 1 < (SELECT count(*) FROM integrations i WHERE i.org_id = o.org_id)`;
    expect(preflight[0].ambiguous_orders).toBe(1);
    await expect(
      client.unsafe(
        migrationStatements(
          '0024_source_identity_and_history_retention.sql',
        )[0],
      ),
    ).rejects.toThrow('ambiguous_orders=1');

    await client`DELETE FROM orders WHERE id = ${ambiguousOrder}`;
    await client`DELETE FROM integrations WHERE id IN (${firstSource}, ${secondSource})`;
  });

  it('preserves legacy counts and Shopify ownership while applying 0023 through 0025', async () => {
    const before = await retainedCounts();

    await applyMigration('0023_expand_commerce_platform_contracts.sql');
    await applyMigration('0024_source_identity_and_history_retention.sql');
    await applyMigration('0025_recoverable_webhook_dispatch.sql');

    expect(await retainedCounts()).toEqual(before);
    const [retained] = await client<
      {
        access_token: string;
        webhook_secret: string;
        shopify_subscription_id: string;
        order_integration_id: string;
        webhook_integration_id: string;
        consumed_count: number;
        dispatch_required: boolean;
      }[]
    >`
      SELECT
        i.access_token,
        i.webhook_secret,
        i.shopify_subscription_id,
        o.integration_id AS order_integration_id,
        w.integration_id AS webhook_integration_id,
        u.consumed_count,
        w.dispatch_required
      FROM integrations i
      JOIN orders o ON o.org_id = i.org_id
      JOIN webhook_events w ON w.org_id = i.org_id
      JOIN integration_monthly_usage u ON u.integration_id = i.id
      WHERE i.id = ${integrationId}
    `;
    expect(retained).toEqual({
      access_token: 'synthetic-encrypted-token',
      webhook_secret: 'synthetic-webhook-secret',
      shopify_subscription_id: 'gid://shopify/AppSubscription/synthetic',
      order_integration_id: integrationId,
      webhook_integration_id: integrationId,
      consumed_count: 7,
      dispatch_required: true,
    });
  });

  it('supports an application-only rollback without deleting accepted new-platform data', async () => {
    const standaloneIntegration = randomUUID();
    const standaloneOrder = randomUUID();
    await client`
      INSERT INTO integrations (id, org_id, platform_type, platform_store_url)
      VALUES (${standaloneIntegration}, ${randomUUID()}, 'standalone', 'standalone:synthetic')
    `;
    const [standalone] = await client<
      { org_id: string }[]
    >`SELECT org_id FROM integrations WHERE id = ${standaloneIntegration}`;
    await client`
      INSERT INTO orders (id, org_id, integration_id, external_order_id, customer_phone)
      VALUES (${standaloneOrder}, ${standalone.org_id}, ${standaloneIntegration}, 'accepted-new-platform-order', '+201000000002')
    `;

    const rollbackCompatibleWebhook = randomUUID();
    await client`
      INSERT INTO webhook_events (
        id, platform, job_type, idempotency_key, store_domain, org_id,
        integration_id, status, raw_payload
      ) VALUES (
        ${rollbackCompatibleWebhook}, 'shopify', 'order.create',
        'rollback-compatible-delivery', 'legacy.myshopify.com', ${orgId},
        ${integrationId}, 'completed', '{}'::jsonb
      )
    `;

    expect(
      await client`SELECT id FROM orders WHERE id IN (${orderId}, ${standaloneOrder}) ORDER BY id`,
    ).toHaveLength(2);
    const [legacyShape] = await client<
      { dispatch_required: boolean; dispatch_attempts: number }[]
    >`SELECT dispatch_required, dispatch_attempts FROM webhook_events WHERE id = ${rollbackCompatibleWebhook}`;
    expect(legacyShape).toEqual({
      dispatch_required: false,
      dispatch_attempts: 0,
    });
    await expect(
      client`INSERT INTO integrations (id, org_id, platform_type, platform_store_url) VALUES (${randomUUID()}, ${randomUUID()}, 'magento', 'unsupported')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
