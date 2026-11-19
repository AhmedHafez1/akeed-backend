import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { AdminStoreDeletionRepository } from '../src/infrastructure/database/repositories/admin-store-deletion.repository';

const h = creditUsageHarness();
const deletions = new AdminStoreDeletionRepository(h.db as never);

beforeAll(async () => {
  await h.setup();
  // The harness builds only the tables its own suites need.
  const needed: PgTable[] = [
    tables.adminStoreLifecycles,
    tables.orderImportBatches,
    tables.verificationServiceMessages,
    tables.verificationSenderAttempts,
    tables.verificationChangeRequestEvents,
    tables.customerMessages,
    tables.creditReservations,
    tables.paymentProviderEvents,
    tables.billingReconciliationAttempts,
    tables.billingReconciliationFindings,
    tables.paymentPurchases,
  ];
  for (const table of needed) {
    const name = (table as unknown as Record<symbol, string>)[
      Symbol.for('drizzle:Name')
    ];
    const [exists] = await h.client<{ found: string | null }[]>`
      SELECT to_regclass(${`"${h.namespace}"."${name}"`})::text AS found`;
    if (!exists?.found) await h.scaffold(table);
  }
});
afterAll(() => h.teardown());

async function deadShopifyStore() {
  const fixture = await h.merchant(0, 'shopify');
  const userId = randomUUID();
  await h.db
    .insert(tables.memberships)
    .values({ orgId: fixture.orgId, userId, role: 'owner' });
  // An order that never got a message: kept by Akeed, but no usage.
  const verification = await h.verification(fixture);
  await h.db.insert(tables.webhookEvents).values({
    platform: 'shopify',
    jobType: 'order.create',
    idempotencyKey: randomUUID(),
    storeDomain: `${fixture.orgId}.myshopify.com`,
    orgId: fixture.orgId,
    integrationId: fixture.integrationId,
    status: 'completed',
    rawPayload: {},
  });
  return { ...fixture, userId, verification };
}

async function countFor(orgId: string) {
  const [row] = Array.from(
    await h.db.execute<Record<string, number>>(sql`
      SELECT
        (SELECT count(*) FROM organizations WHERE id = ${orgId})::int AS organizations,
        (SELECT count(*) FROM integrations WHERE org_id = ${orgId})::int AS integrations,
        (SELECT count(*) FROM orders WHERE org_id = ${orgId})::int AS orders,
        (SELECT count(*) FROM verifications WHERE org_id = ${orgId})::int AS verifications,
        (SELECT count(*) FROM webhook_events WHERE org_id = ${orgId})::int AS webhooks,
        (SELECT count(*) FROM memberships WHERE org_id = ${orgId})::int AS memberships
    `),
  );
  return row;
}

describe('admin store deletion', () => {
  it('removes a dead store and everything under its organization', async () => {
    const store = await deadShopifyStore();
    expect((await countFor(store.orgId)).orders).toBe(1);

    const result = await deletions.deleteOrganization(store);

    expect(result).toEqual({ deleted: true, userIds: [store.userId] });
    expect(await countFor(store.orgId)).toEqual({
      organizations: 0,
      integrations: 0,
      orders: 0,
      verifications: 0,
      webhooks: 0,
      memberships: 0,
    });
    await expect(
      deletions.findUsersWithoutOrganization([store.userId]),
    ).resolves.toEqual([store.userId]);
  });

  it('keeps a login that still belongs to another organization', async () => {
    const store = await deadShopifyStore();
    const other = await h.merchant(0, 'shopify');
    await h.db
      .insert(tables.memberships)
      .values({ orgId: other.orgId, userId: store.userId, role: 'owner' });

    await deletions.deleteOrganization(store);

    await expect(
      deletions.findUsersWithoutOrganization([store.userId]),
    ).resolves.toEqual([]);
  });

  it('refuses a store whose customer answered', async () => {
    const store = await deadShopifyStore();
    await h.db
      .update(tables.verifications)
      .set({ status: 'confirmed', confirmedAt: new Date().toISOString() })
      .where(eq(tables.verifications.id, store.verification.verificationId));

    await expect(deletions.deleteOrganization(store)).resolves.toEqual({
      deleted: false,
      reason: 'changed',
    });
    expect((await countFor(store.orgId)).organizations).toBe(1);
  });

  it('refuses a store with credit history, which is kept forever', async () => {
    const store = await h.merchant(5, 'standalone');

    await expect(deletions.deleteOrganization(store)).resolves.toEqual({
      deleted: false,
      reason: 'changed',
    });
  });

  it('refuses a store whose organization has another store', async () => {
    const store = await deadShopifyStore();
    await h.db.insert(tables.integrations).values({
      orgId: store.orgId,
      platformType: 'standalone',
      platformStoreUrl: `standalone:${randomUUID()}`,
    });

    await expect(deletions.deleteOrganization(store)).resolves.toEqual({
      deleted: false,
      reason: 'changed',
    });
  });

  it('reports an organization that is already gone', async () => {
    await expect(
      deletions.deleteOrganization({
        orgId: randomUUID(),
        integrationId: randomUUID(),
      }),
    ).resolves.toEqual({ deleted: false, reason: 'not_found' });
  });
});

describe('0104 lifecycle resolution backfill', () => {
  const migration = readFileSync(
    resolve(__dirname, '../drizzle/0104_backfill_lifecycle_resolution.sql'),
    'utf8',
  );

  it('fills empty first-answer milestones from real answers since install', async () => {
    const store = await h.merchant(0, 'shopify');
    const installedAt = '2026-11-01T00:00:00.000Z';
    const [lifecycle] = await h.db
      .insert(tables.adminStoreLifecycles)
      .values({ ...store, installedAt })
      .returning();
    const before = await h.verification(store);
    await h.db
      .update(tables.verifications)
      .set({
        status: 'confirmed',
        confirmationSource: 'customer',
        confirmedAt: '2026-10-20T00:00:00.000Z',
      })
      .where(eq(tables.verifications.id, before.verificationId));
    const answered = await h.verification(store);
    await h.db
      .update(tables.verifications)
      .set({
        status: 'confirmed',
        confirmationSource: 'customer',
        confirmedAt: '2026-11-05T10:00:00.000Z',
      })
      .where(eq(tables.verifications.id, answered.verificationId));

    for (let pass = 0; pass < 2; pass++) await h.client.unsafe(migration);

    const [row] = await h.db
      .select()
      .from(tables.adminStoreLifecycles)
      .where(eq(tables.adminStoreLifecycles.id, lifecycle.id));
    expect(Date.parse(row.firstResolvedAt ?? '')).toBe(
      Date.parse('2026-11-05T10:00:00.000Z'),
    );
    expect(Date.parse(row.firstCustomerResponseAt ?? '')).toBe(
      Date.parse('2026-11-05T10:00:00.000Z'),
    );
    expect(Date.parse(row.firstRealConfirmedAt ?? '')).toBe(
      Date.parse('2026-11-05T10:00:00.000Z'),
    );
    expect(row.provenance).toMatchObject({ activation: 'backfilled' });
  });

  it('leaves a recorded milestone as it is', async () => {
    const store = await h.merchant(0, 'shopify');
    const [lifecycle] = await h.db
      .insert(tables.adminStoreLifecycles)
      .values({
        ...store,
        installedAt: '2026-11-01T00:00:00.000Z',
        firstResolvedAt: '2026-11-02T00:00:00.000Z',
        provenance: { activation: 'captured_exact' },
      })
      .returning();
    const answered = await h.verification(store);
    await h.db
      .update(tables.verifications)
      .set({
        status: 'canceled',
        cancellationSource: 'customer',
        canceledAt: '2026-11-06T00:00:00.000Z',
      })
      .where(eq(tables.verifications.id, answered.verificationId));

    await h.client.unsafe(migration);

    const [row] = await h.db
      .select()
      .from(tables.adminStoreLifecycles)
      .where(eq(tables.adminStoreLifecycles.id, lifecycle.id));
    expect(Date.parse(row.firstResolvedAt ?? '')).toBe(
      Date.parse('2026-11-02T00:00:00.000Z'),
    );
    expect(Date.parse(row.firstCustomerResponseAt ?? '')).toBe(
      Date.parse('2026-11-06T00:00:00.000Z'),
    );
    expect(row.firstRealConfirmedAt).toBeNull();
    expect(row.provenance).toEqual({ activation: 'captured_exact' });
  });
});
