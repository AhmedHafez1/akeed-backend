import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { VerificationsService } from '../src/modules/verifications/verifications.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';

/**
 * The embedded dashboard's SQL over PostgreSQL: the one needs-action rule, the
 * tab counts, search, the value sum, the overview composition, manual
 * confirmation, and that none of it crosses from one shop to another.
 */

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
  )
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  return value;
}

const namespace = `overview_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 4,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });

async function scaffold(table: PgTable) {
  const definition = getTableConfig(table);
  const dialect = new PgDialect();
  const columns = definition.columns.map((column) => {
    let result = `"${column.name}" ${column.getSQLType()}`;
    if (column.notNull) result += ' NOT NULL';
    if (column.primary) result += ' PRIMARY KEY';
    if (column.default !== undefined) {
      const value = column.default;
      result +=
        ' DEFAULT ' +
        (value instanceof SQL
          ? dialect.sqlToQuery(value).sql
          : typeof value === 'boolean' || typeof value === 'number'
            ? String(value)
            : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`);
    }
    return result;
  });
  for (const unique of definition.uniqueConstraints)
    columns.push(
      `CONSTRAINT "${unique.name}" UNIQUE (${unique.columns.map((column) => `"${column.name}"`).join(', ')})`,
    );
  await client.unsafe(
    `CREATE TABLE "${definition.name}" (${columns.join(', ')})`,
  );
}

async function migrate(name: string) {
  const statements = readFileSync(
    resolve(__dirname, '../drizzle', name),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((part) => part.trim());
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const orgA = randomUUID();
const orgB = randomUUID();
const orgEmpty = randomUUID();
const integrationA = randomUUID();
const integrationB = randomUUID();
const integrationEmpty = randomUUID();

/** Verification ids by scenario, org A unless named otherwise. */
const ids = {
  deliveryFailed: randomUUID(),
  planFailed: randomUUID(),
  afterFollowUp: randomUUID(),
  readLongAgo: randomUUID(),
  readRecently: randomUUID(),
  noReply: randomUUID(),
  confirmed: randomUUID(),
  confirmedManually: randomUUID(),
  canceled: randomUUID(),
  testOrder: randomUUID(),
  outsidePeriod: randomUUID(),
  pending: randomUUID(),
  otherShop: randomUUID(),
};

interface Seed {
  id: string;
  orgId: string;
  integrationId: string;
  orderNumber: string;
  phone: string;
  total: string;
  isTest?: boolean;
  createdAt?: string;
  verification: Partial<typeof tables.verifications.$inferInsert>;
}

async function seed(row: Seed) {
  const orderId = randomUUID();
  await db.insert(tables.orders).values({
    id: orderId,
    orgId: row.orgId,
    integrationId: row.integrationId,
    externalOrderId: row.isTest ? `akeed-test-${orderId}` : `ext-${orderId}`,
    orderNumber: row.orderNumber,
    customerPhone: row.phone,
    customerName: 'Customer',
    totalPrice: row.total,
    currency: 'USD',
    isTest: row.isTest ?? false,
    createdAt: row.createdAt ?? ago(DAY),
  });
  await db.insert(tables.verifications).values({
    id: row.id,
    orgId: row.orgId,
    orderId,
    createdAt: row.createdAt ?? ago(DAY),
    ...row.verification,
  });
}

const sentAt = ago(DAY - HOUR);

let repository: VerificationsRepository;
let service: VerificationsService;
const finalizeVerification = jest.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  await client`CREATE SCHEMA ${client(namespace)}`;
  await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  for (const candidate of Object.values(tables)) {
    if (
      typeof candidate === 'function' &&
      'enumName' in candidate &&
      'enumValues' in candidate
    ) {
      const values = candidate.enumValues as string[];
      await client.unsafe(
        `CREATE TYPE "${String(candidate.enumName)}" AS ENUM (${values.map((item) => `'${item}'`).join(', ')})`,
      );
    }
  }
  for (const table of [
    tables.organizations,
    tables.integrations,
    tables.orders,
    tables.verifications,
    tables.webhookEvents,
  ])
    await scaffold(table);
  await client.unsafe(
    `ALTER TABLE "verifications" DROP COLUMN "confirmation_source"`,
  );
  await migrate('0043_verification_confirmation_source.sql');

  for (const [orgId, integrationId, slug] of [
    [orgA, integrationA, 'shop-a'],
    [orgB, integrationB, 'shop-b'],
    [orgEmpty, integrationEmpty, 'shop-empty'],
  ]) {
    await db
      .insert(tables.organizations)
      .values({ id: orgId, name: slug, slug });
    await db.insert(tables.integrations).values({
      id: integrationId,
      orgId,
      platformType: 'shopify',
      platformStoreUrl: `${slug}.myshopify.com`,
      isActive: true,
      timezone: 'UTC',
      escalationDelayMinutes: 360,
    });
  }

  const a = { orgId: orgA, integrationId: integrationA };
  await seed({
    ...a,
    id: ids.deliveryFailed,
    orderNumber: '1127',
    phone: '+201000000001',
    total: '1025.00',
    verification: {
      status: 'failed',
      lastSentAt: sentAt,
      metadata: {
        reason: 'provider_delivery_failed',
        providerErrorCode: 131026,
      },
    },
  });
  await seed({
    ...a,
    id: ids.planFailed,
    orderNumber: '1126',
    phone: '+201000000002',
    total: '5000.00',
    verification: {
      status: 'failed',
      metadata: { reason: 'plan_limit_reached' },
    },
  });
  await seed({
    ...a,
    id: ids.afterFollowUp,
    orderNumber: '1138',
    phone: '+201007611456',
    total: '2629.95',
    verification: {
      status: 'read',
      lastSentAt: sentAt,
      deliveredAt: sentAt,
      readAt: ago(2 * HOUR),
      followUpSentAt: ago(3 * HOUR),
      followUpAttempts: 1,
    },
  });
  await seed({
    ...a,
    id: ids.readLongAgo,
    orderNumber: '1129',
    phone: '+201000000004',
    total: '49.95',
    verification: {
      status: 'read',
      lastSentAt: sentAt,
      deliveredAt: sentAt,
      readAt: ago(14 * HOUR),
    },
  });
  await seed({
    ...a,
    id: ids.readRecently,
    orderNumber: '1130',
    phone: '+201000000005',
    total: '9999.00',
    verification: {
      status: 'read',
      lastSentAt: sentAt,
      deliveredAt: sentAt,
      readAt: ago(HOUR),
    },
  });
  await seed({
    ...a,
    id: ids.noReply,
    orderNumber: '1131',
    phone: '+201000000006',
    total: '10.00',
    verification: {
      status: 'no_reply',
      lastSentAt: sentAt,
      noReplyAt: ago(HOUR),
    },
  });
  await seed({
    ...a,
    id: ids.confirmed,
    orderNumber: '1132',
    phone: '+201000000007',
    total: '100.00',
    verification: {
      status: 'confirmed',
      lastSentAt: sentAt,
      deliveredAt: sentAt,
      readAt: sentAt,
      confirmedAt: ago(HOUR),
      confirmationSource: 'customer',
    },
  });
  await seed({
    ...a,
    id: ids.confirmedManually,
    orderNumber: '1133',
    phone: '+201000000008',
    total: '50.00',
    verification: {
      status: 'confirmed',
      lastSentAt: sentAt,
      confirmedAt: ago(HOUR),
      confirmationSource: 'merchant_manual',
    },
  });
  await seed({
    ...a,
    id: ids.canceled,
    orderNumber: '1134',
    phone: '+201000000009',
    total: '30.00',
    verification: {
      status: 'canceled',
      lastSentAt: sentAt,
      canceledAt: ago(HOUR),
      cancellationSource: 'customer',
    },
  });
  await seed({
    ...a,
    id: ids.testOrder,
    orderNumber: '1135',
    phone: '+201000000010',
    total: '70.00',
    isTest: true,
    verification: { status: 'no_reply', lastSentAt: sentAt },
  });
  await seed({
    ...a,
    id: ids.outsidePeriod,
    orderNumber: '1001',
    phone: '+201000000011',
    total: '80.00',
    createdAt: ago(40 * DAY),
    verification: { status: 'no_reply', lastSentAt: ago(40 * DAY) },
  });
  await seed({
    ...a,
    id: ids.pending,
    orderNumber: '1136',
    phone: '+201000000012',
    total: '20.00',
    verification: { status: 'pending' },
  });
  // Same order number and phone as a shop-A order, in another shop.
  await seed({
    orgId: orgB,
    integrationId: integrationB,
    id: ids.otherShop,
    orderNumber: '1138',
    phone: '+201007611456',
    total: '777.00',
    verification: { status: 'no_reply', lastSentAt: sentAt },
  });

  repository = new VerificationsRepository(db);
  service = new VerificationsService(
    repository,
    {
      readEntitlement: jest
        .fn()
        .mockResolvedValue({ consumedCount: 27, includedLimit: 30 }),
    } as never,
    new IntegrationsRepository(db as never, { get: () => undefined } as never),
    {} as never,
    { supports: () => true } as never,
    { finalizeVerification } as never,
  );
});

afterAll(async () => {
  await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`;
  await client.end();
});

const period = () => ({ startAt: ago(30 * DAY), endAt: ago(-DAY) });
const needsAction = () => ({
  now: new Date().toISOString(),
  escalationDelayMinutes: 360,
});
const owner = (orgId: string): AuthenticatedUser => ({
  userId: randomUUID(),
  orgId,
  role: 'owner',
  source: 'shopify',
});

describe('0043 migration', () => {
  it('is re-runnable and rejects an unknown confirmation source', async () => {
    await migrate('0043_verification_confirmation_source.sql');
    await expect(
      client.unsafe(
        `UPDATE "verifications" SET "confirmation_source" = 'bogus' WHERE id = '${ids.pending}'`,
      ),
    ).rejects.toThrow(/verifications_confirmation_source_check/);
  });
});

describe('needs-action rule', () => {
  it('assigns each case its reason and leaves the rest out', async () => {
    const rows = await repository.findNeedsActionTop(
      orgA,
      period(),
      needsAction(),
      50,
    );
    expect(rows.map((row) => [row.id, row.actionReason])).toEqual([
      [ids.afterFollowUp, 'no_reply_after_follow_up'],
      [ids.deliveryFailed, 'delivery_failed'],
      [ids.readLongAgo, 'read_no_reply'],
      [ids.noReply, 'no_reply'],
    ]);
  });

  it('caps the dashboard card and orders it by value', async () => {
    const rows = await repository.findNeedsActionTop(
      orgA,
      period(),
      needsAction(),
      2,
    );
    expect(rows.map((row) => row.order.totalPrice)).toEqual([
      '2629.95',
      '1025.00',
    ]);
  });

  it('honors the escalation delay for read-but-unanswered', async () => {
    const rows = await repository.findNeedsActionTop(
      orgA,
      period(),
      { now: new Date().toISOString(), escalationDelayMinutes: 30 },
      50,
    );
    expect(rows.map((row) => row.id)).toContain(ids.readRecently);
  });
});

describe('tab counts and list filters', () => {
  it('counts every tab over the same rows the list shows', async () => {
    const counts = await repository.countByTab(orgA, period(), needsAction());
    expect(counts).toEqual({
      all: 11,
      needs_action: 4,
      confirmed: 2,
      canceled: 1,
      failed: 2,
    });

    for (const tab of [
      'needs_action',
      'confirmed',
      'canceled',
      'failed',
    ] as const) {
      const total = await repository.countByOrg(
        orgA,
        undefined,
        period(),
        undefined,
        {
          tab,
          needsAction: needsAction(),
        },
      );
      expect(total).toBe(counts[tab]);
    }
  });

  it('searches by order number prefix and by phone digits, within the shop', async () => {
    const byNumber = await repository.findByOrg(orgA, undefined, period(), {
      searchDigits: '1138',
      needsAction: needsAction(),
    });
    expect(byNumber.map((row) => row.id)).toEqual([ids.afterFollowUp]);
    expect(byNumber[0].actionReason).toBe('no_reply_after_follow_up');

    const byPhone = await repository.findByOrg(orgA, undefined, period(), {
      searchDigits: '1007611456',
    });
    expect(byPhone.map((row) => row.id)).toEqual([ids.afterFollowUp]);

    const wildcard = await repository.findByOrg(orgA, undefined, period(), {
      searchDigits: '99999999',
    });
    expect(wildcard).toEqual([]);
  });
});

describe('overview aggregate', () => {
  it('counts real orders in the period, with send-restricted numerators', async () => {
    const counts = await repository.getOverviewCounts(
      orgA,
      period(),
      needsAction(),
    );
    expect(counts).toEqual({
      sent: 8,
      delivered: 4,
      read: 4,
      confirmed: 2,
      confirmedAfterSend: 2,
      customerConfirmedAfterSend: 1,
      customerCanceled: 1,
      customerCanceledAfterSend: 1,
      needsAction: 4,
    });
  });

  it('sums confirmed value per currency in SQL', async () => {
    await expect(
      repository.getConfirmedValueByCurrency(orgA, period()),
    ).resolves.toEqual([{ currency: 'USD', amount: '150.00' }]);
  });

  it('composes the dashboard for one shop', async () => {
    const overview = await service.getOverview(orgA, {
      date_range: 'last_30_days',
    });
    expect(overview.kpis).toEqual({
      confirmed: { count: 2, value: [{ currency: 'USD', amount: '150.00' }] },
      canceled_before_shipping: { count: 1 },
      confirmation_rate: { rate: 25, confirmed: 2, sent: 8 },
    });
    expect(overview.usage).toEqual({
      used: 27,
      limit: 30,
      percent: 90,
      state: 'warning',
    });
    expect(overview.needs_action.count).toBe(4);
    expect(overview.needs_action.items[0]).toMatchObject({
      verification_id: ids.afterFollowUp,
      order_number: '1138',
      platform: 'shopify',
      reason: { type: 'no_reply_after_follow_up' },
    });
    expect(Date.parse(overview.needs_action.items[0].reason.since ?? '')).toBe(
      Date.parse(sentAt),
    );
    expect(overview.needs_action.items[1].reason).toMatchObject({
      type: 'delivery_failed',
      failure_code: '131026',
    });
    expect(overview.needs_action.items[2].reason).toMatchObject({
      type: 'read_no_reply',
      hours: 14,
    });
  });

  it('reports an empty shop as zeros with no rate', async () => {
    const overview = await service.getOverview(orgEmpty, {});
    expect(overview.kpis.confirmation_rate).toEqual({
      rate: null,
      confirmed: 0,
      sent: 0,
    });
    expect(overview.funnel.sent).toEqual({ count: 0, percent_of_sent: null });
    expect(overview.needs_action).toEqual({ count: 0, items: [] });
  });
});

describe('shop isolation', () => {
  it('never shows another shop its rows, counts or search hits', async () => {
    const overview = await service.getOverview(orgB, {});
    expect(
      overview.needs_action.items.map((item) => item.verification_id),
    ).toEqual([ids.otherShop]);

    const list = await service.listByOrg(orgB, { q: '1138' });
    expect(list.data.map((row) => row.id)).toEqual([ids.otherShop]);
    expect(list.page_context?.tab_counts).toEqual({
      all: 1,
      needs_action: 1,
      confirmed: 0,
      canceled: 0,
      failed: 0,
    });
  });

  it('refuses to confirm another shop’s verification', async () => {
    await expect(
      service.confirmManually(owner(orgB), ids.noReply),
    ).rejects.toBeInstanceOf(NotFoundException);
    const untouched = await repository.findByIdForOrg(ids.noReply, orgA);
    expect(untouched?.status).toBe('no_reply');
  });
});

describe('manual confirmation', () => {
  it('confirms through the customer path and records it as manual', async () => {
    const user = owner(orgA);
    await expect(service.confirmManually(user, ids.noReply)).resolves.toEqual({
      success: true,
      verificationId: ids.noReply,
      status: 'confirmed',
    });
    const row = await repository.findByIdForOrg(ids.noReply, orgA);
    expect(row).toMatchObject({
      status: 'confirmed',
      confirmationSource: 'merchant_manual',
      metadata: { manualConfirmedBy: user.userId },
    });
    expect(row?.confirmedAt).toEqual(expect.any(String));
    expect(finalizeVerification).toHaveBeenCalledWith(ids.noReply, 'confirmed');

    await expect(service.confirmManually(user, ids.noReply)).resolves.toEqual({
      success: true,
      verificationId: ids.noReply,
      status: 'confirmed',
      alreadyConfirmed: true,
    });
  });

  it('does not confirm an order nothing was sent for', async () => {
    await expect(
      service.confirmManually(owner(orgA), ids.pending),
    ).rejects.toMatchObject({
      response: { code: 'VERIFICATION_NOT_CONFIRMABLE' },
    });
  });
});
