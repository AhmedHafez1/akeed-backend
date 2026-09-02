import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/infrastructure/database';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NOT RUN: invalid test database URL (value withheld).');
  }
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

const namespace = `e02_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 6,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const repository = new IntegrationMonthlyUsageRepository(
  drizzle(client, { schema }),
);
const service = new BillingEntitlementService(repository);
const identity = { id: randomUUID(), orgId: randomUUID() };
let created = false;

describe('provider-neutral entitlement PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(
      `CREATE FUNCTION "${namespace}".uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()'`,
    );
    await client.unsafe(
      `CREATE TABLE "${namespace}".integrations (id uuid PRIMARY KEY, org_id uuid NOT NULL, platform_type text NOT NULL, is_active boolean, billing_status text, billing_plan_id text, billing_activated_at timestamptz)`,
    );
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0005_chemical_lady_ursula.sql'),
      'utf8',
    );
    await client.unsafe(migration.split('--> statement-breakpoint')[0]);
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client`DELETE FROM ${client(namespace)}.integration_monthly_usage`;
    await client`DELETE FROM ${client(namespace)}.integrations`;
    await client`INSERT INTO ${client(namespace)}.integrations (id, org_id, platform_type, is_active, billing_status, billing_plan_id, billing_activated_at) VALUES (${identity.id}, ${identity.orgId}, 'standalone', true, 'not_required', 'starter', now())`;
  });

  it('serializes competing reservations at the existing 30-message limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 36 }, () =>
        service.reserveVerificationSlot(identity),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
    expect(
      results.filter((r) => r.reason === 'plan_limit_reached'),
    ).toHaveLength(6);
    const [usage] =
      await client`SELECT consumed_count, blocked_count FROM ${client(namespace)}.integration_monthly_usage`;
    expect(usage).toMatchObject({ consumed_count: 30, blocked_count: 6 });
  });

  it.each(['inactive', 'blocked'])(
    'rejects a %s source committed after the caller snapshot without reserving usage',
    async (change) => {
      const snapshot = await repository.getEntitlementSource(identity);
      if (!snapshot) throw new Error('Missing fixture');
      expect(service.evaluateAccess(snapshot).allowed).toBe(true);
      await client.begin(async (tx) => {
        if (change === 'inactive')
          await tx.unsafe(
            `UPDATE "${namespace}".integrations SET is_active = false WHERE id = $1`,
            [identity.id],
          );
        else
          await tx.unsafe(
            `UPDATE "${namespace}".integrations SET billing_status = 'frozen' WHERE id = $1`,
            [identity.id],
          );
      });
      const result = await service.reserveVerificationSlot(snapshot);
      expect(result).toMatchObject({
        allowed: false,
        reason:
          change === 'inactive' ? 'integration_inactive' : 'billing_not_active',
      });
      expect(
        await client`SELECT * FROM ${client(namespace)}.integration_monthly_usage`,
      ).toHaveLength(0);
    },
  );

  it('does not allow a caller to choose a different tenant or invent a larger plan', async () => {
    expect(
      (
        await service.reserveVerificationSlot({
          ...identity,
          orgId: randomUUID(),
        })
      ).allowed,
    ).toBe(false);
    const forged = {
      ...identity,
      billingPlanId: 'business',
      includedLimit: 2500,
    };
    expect(await service.reserveVerificationSlot(forged)).toMatchObject({
      allowed: true,
      includedLimit: 30,
      planId: 'starter',
    });
  });

  it('keeps periods and integrations separate and releases the original period', async () => {
    const first = await service.reserveVerificationSlot(identity);
    const otherId = randomUUID();
    await client`INSERT INTO ${client(namespace)}.integrations SELECT ${otherId}, org_id, platform_type, is_active, billing_status, billing_plan_id, billing_activated_at FROM ${client(namespace)}.integrations WHERE id = ${identity.id}`;
    await service.reserveVerificationSlot({ ...identity, id: otherId });
    await client`UPDATE ${client(namespace)}.integrations SET billing_activated_at = now() + interval '35 days' WHERE id = ${identity.id}`;
    const next = await service.reserveVerificationSlot(identity);
    expect(next.periodStart).not.toBe(first.periodStart);
    await service.releaseVerificationSlot({
      integrationId: identity.id,
      periodStart: first.periodStart,
    });
    const rows =
      await client`SELECT integration_id, period_start::text, consumed_count FROM ${client(namespace)}.integration_monthly_usage`;
    expect(rows).toHaveLength(3);
    expect(
      rows.find(
        (row) =>
          row.integration_id === identity.id &&
          row.period_start === first.periodStart,
      )?.consumed_count,
    ).toBe(0);
    expect(rows.filter((row) => row.consumed_count === 1)).toHaveLength(2);
  });
});
