import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/infrastructure/database';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';

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

const namespace = `e02_identity_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 2,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const repository = new OrdersRepository(drizzle(client, { schema }));
const org1 = randomUUID();
const org2 = randomUUID();
const source1 = randomUUID();
const source2 = randomUUID();
const source3 = randomUUID();
let created = false;

describe('source identity and retention PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TABLE integrations (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        access_token text,
        webhook_secret text,
        expires_at timestamptz,
        is_active boolean DEFAULT true,
        billing_status text,
        pending_billing_plan_id text,
        billing_canceled_at timestamptz,
        billing_status_updated_at timestamptz,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE orders (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid,
        external_order_id text NOT NULL,
        order_number text,
        customer_phone text NOT NULL,
        customer_name text,
        customer_email text,
        total_price numeric(12,2),
        currency text DEFAULT 'SAR',
        payment_method text,
        raw_payload jsonb,
        is_test boolean DEFAULT false NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT orders_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE,
        UNIQUE (integration_id, external_order_id)
      );
      CREATE TABLE integration_monthly_usage (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
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
        org_id uuid,
        integration_id uuid,
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT webhook_events_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
      );
      CREATE TABLE admin_store_lifecycles (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        CONSTRAINT admin_store_lifecycles_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
      );
    `);
    await client`
      INSERT INTO integrations (id, org_id, platform_type, platform_store_url, access_token)
      VALUES
        (${source1}, ${org1}, 'shopify', 'one.example', 'credential-1'),
        (${source2}, ${org1}, 'standalone', 'two.example', 'credential-2'),
        (${source3}, ${org2}, 'shopify', 'three.example', 'credential-3')
    `;
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('stops on ambiguity, scopes duplicate IDs, preserves disconnect history, and permits explicit redaction', async () => {
    const ambiguousOrder = randomUUID();
    await client`
      INSERT INTO orders (id, org_id, external_order_id, customer_phone)
      VALUES (${ambiguousOrder}, ${org1}, 'ambiguous', '+201000000000')
    `;
    const migration = readFileSync(
      resolve(
        __dirname,
        '../drizzle/0024_source_identity_and_history_retention.sql',
      ),
      'utf8',
    );
    const statements = migration.split('--> statement-breakpoint');
    await expect(client.unsafe(statements[0])).rejects.toThrow(
      'ambiguous_orders=1',
    );
    await client`DELETE FROM orders WHERE id = ${ambiguousOrder}`;

    const order1 = randomUUID();
    const order2 = randomUUID();
    const order3 = randomUUID();
    await client`
      INSERT INTO orders (id, org_id, integration_id, external_order_id, customer_phone)
      VALUES
        (${order1}, ${org1}, ${source1}, 'shared-external-id', '+201000000001'),
        (${order2}, ${org1}, ${source2}, 'shared-external-id', '+201000000002'),
        (${order3}, ${org2}, ${source3}, 'shared-external-id', '+201000000003')
    `;
    await client`INSERT INTO verifications VALUES (${randomUUID()}, ${org1}, ${order1})`;
    await client`INSERT INTO integration_monthly_usage VALUES (${randomUUID()}, ${org1}, ${source1})`;
    await client`INSERT INTO webhook_events (id, org_id, integration_id) VALUES (${randomUUID()}, ${org1}, ${source1})`;
    await client`INSERT INTO admin_store_lifecycles VALUES (${randomUUID()}, ${org1}, ${source1})`;

    for (const statement of statements) await client.unsafe(statement);

    await expect(
      repository.findBySourceExternalId({
        orgId: org1,
        integrationId: source1,
        externalOrderId: 'shared-external-id',
      }),
    ).resolves.toMatchObject({ id: order1 });
    await expect(
      repository.findBySourceExternalId({
        orgId: org1,
        integrationId: source2,
        externalOrderId: 'shared-external-id',
      }),
    ).resolves.toMatchObject({ id: order2 });
    await expect(
      repository.findBySourceExternalId({
        orgId: org2,
        integrationId: source1,
        externalOrderId: 'shared-external-id',
      }),
    ).resolves.toBeUndefined();

    await expect(
      client`
        INSERT INTO orders (id, org_id, integration_id, external_order_id, customer_phone)
        VALUES (${randomUUID()}, ${org2}, ${source1}, 'forged-owner', '+201000000004')
      `,
    ).rejects.toThrow();

    await client`
      UPDATE integrations
      SET is_active = false, access_token = NULL, webhook_secret = NULL
      WHERE id = ${source1}
    `;
    const [history] = await client`
      SELECT
        (SELECT count(*)::int FROM orders WHERE integration_id = ${source1}) AS orders,
        (SELECT count(*)::int FROM verifications WHERE order_id = ${order1}) AS verifications,
        (SELECT count(*)::int FROM integration_monthly_usage WHERE integration_id = ${source1}) AS usage
    `;
    expect(history).toMatchObject({ orders: 1, verifications: 1, usage: 1 });
    await expect(
      client`DELETE FROM integrations WHERE id = ${source1}`,
    ).rejects.toThrow();

    await client`DELETE FROM webhook_events WHERE integration_id = ${source1}`;
    await client`DELETE FROM integration_monthly_usage WHERE integration_id = ${source1}`;
    await client`DELETE FROM verifications WHERE order_id = ${order1}`;
    await client`DELETE FROM orders WHERE integration_id = ${source1}`;
    await client`DELETE FROM admin_store_lifecycles WHERE integration_id = ${source1}`;
    await client`DELETE FROM integrations WHERE id = ${source1}`;
    expect(
      await client`SELECT id FROM integrations WHERE id = ${source1}`,
    ).toHaveLength(0);
  });
});
