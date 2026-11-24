import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { ShippingNotificationsRepository } from '../src/infrastructure/database/repositories/shipping-notifications.repository';
import { ShippingNotificationsService } from '../src/modules/shipping-notifications/shipping-notifications.service';
import { ShopifyShippingEventSource } from '../src/infrastructure/spokes/shopify/services/shopify-shipping-event.source';
import { SHIPPING_NOTIFICATIONS_CONFIG } from '../src/shared/config/shipping-notifications.config';
import { needsActionReasonSql } from '../src/infrastructure/database/repositories/verification-needs-action.sql';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { usageAccountingFixture } from './contracts/usage-accounting-fixture';

/**
 * Shipping notifications over PostgreSQL: migration 0106 and its defaults,
 * the merchant's tag list, the one-query order context, one record per
 * verification and stage under concurrent and out-of-order events, the
 * record's checks, and tenant scoping.
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

const namespace = `shipping_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const repo = new ShippingNotificationsRepository(db as never);

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

const orgA = randomUUID();
const orgB = randomUUID();
const integrationA = randomUUID();
const integrationB = randomUUID();
const DAY = 86_400_000;

interface Seeded {
  orderId: string;
  verificationId: string;
  externalOrderId: string;
}

async function seed(
  overrides: {
    orgId?: string;
    integrationId?: string;
    isTest?: boolean;
    verification?: Partial<typeof tables.verifications.$inferInsert>;
  } = {},
): Promise<Seeded> {
  const orgId = overrides.orgId ?? orgA;
  const integrationId = overrides.integrationId ?? integrationA;
  const orderId = randomUUID();
  const verificationId = randomUUID();
  const externalOrderId = String(Math.floor(Math.random() * 1e12) + 1_000_000);
  await db.insert(tables.orders).values({
    id: orderId,
    orgId,
    integrationId,
    externalOrderId,
    orderNumber: '1001',
    customerPhone: '+201000000001',
    customerName: 'Customer',
    totalPrice: '100.00',
    currency: 'EGP',
    isTest: overrides.isTest ?? false,
  });
  await db.insert(tables.verifications).values({
    id: verificationId,
    orgId,
    orderId,
    status: 'confirmed',
    ...overrides.verification,
  });
  return { orderId, verificationId, externalOrderId };
}

function record(
  seeded: Seeded,
  overrides: Partial<
    typeof tables.verificationShippingNotifications.$inferInsert
  > = {},
) {
  return repo.insertIfNew({
    orgId: orgA,
    verificationId: seeded.verificationId,
    stage: 'shipped',
    trigger: 'fulfillment',
    status: 'pending',
    ...overrides,
  });
}

async function rowsFor(verificationId: string) {
  return client<
    { trigger: string; status: string; reason_code: string | null }[]
  >`SELECT trigger, status, reason_code FROM verification_shipping_notifications WHERE verification_id = ${verificationId}`;
}

/** Drizzle wraps the database error; the constraint is named on its cause. */
async function expectConstraint(work: Promise<unknown>, name: RegExp) {
  const error: unknown = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeDefined();
  const { message, cause } = error as {
    message?: string;
    cause?: { message?: string; constraint_name?: string };
  };
  expect([message, cause?.message, cause?.constraint_name].join(' ')).toMatch(
    name,
  );
}

function rawInsert(seeded: Seeded, columns: string, values: string) {
  return client.unsafe(
    `INSERT INTO verification_shipping_notifications (org_id, verification_id, stage, ${columns}) VALUES ('${orgA}', '${seeded.verificationId}', 'shipped', ${values})`,
  );
}

beforeAll(async () => {
  await client`CREATE SCHEMA ${client(namespace)}`;
  await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
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
    tables.verificationMessageDispatches,
    // Read by the needs-action rule's other branches.
    tables.verificationChangeRequests,
    tables.verificationAutoCancellations,
  ])
    await scaffold(table);
  // The new store columns came from the scaffold; drop them so the migration
  // adds them to a table that already holds rows.
  await client.unsafe(`
    ALTER TABLE integrations DROP COLUMN shipping_notifications_enabled;
    ALTER TABLE integrations DROP COLUMN shipping_fulfillment_trigger_enabled;
    ALTER TABLE integrations DROP COLUMN shipping_tags;
  `);

  await db.insert(tables.organizations).values([
    { id: orgA, name: 'Store A', slug: `store-${orgA}` },
    { id: orgB, name: 'Store B', slug: `store-${orgB}` },
  ]);
  await client`
    INSERT INTO integrations (id, org_id, platform_type, platform_store_url, is_active)
    VALUES (${integrationA}, ${orgA}, 'shopify', 'ship-a.myshopify.com', true),
           (${integrationB}, ${orgB}, 'shopify', 'ship-b.myshopify.com', true)`;

  // Twice, to prove it re-runs.
  await migrate('0106_shipping_notifications.sql');
  await migrate('0106_shipping_notifications.sql');
  await migrate('0107_shipping_sending.sql');
  await migrate('0107_shipping_sending.sql');
});

afterAll(async () => {
  await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`;
  await client.end();
});

describe('shipping notifications against PostgreSQL', () => {
  describe('migration and settings', () => {
    it('leaves existing stores off, with the fulfillment trigger on and no tags', async () => {
      const stores = await client<
        {
          shipping_notifications_enabled: boolean;
          shipping_fulfillment_trigger_enabled: boolean;
          shipping_tags: string[];
        }[]
      >`SELECT shipping_notifications_enabled, shipping_fulfillment_trigger_enabled, shipping_tags FROM integrations ORDER BY platform_store_url`;
      expect(stores).toEqual([
        {
          shipping_notifications_enabled: false,
          shipping_fulfillment_trigger_enabled: true,
          shipping_tags: [],
        },
        {
          shipping_notifications_enabled: false,
          shipping_fulfillment_trigger_enabled: true,
          shipping_tags: [],
        },
      ]);
    });

    it('round-trips tags in any script and refuses more than ten', async () => {
      const tags = ['شحن', 'Shipped', 'Kargoda', 'تم الشحن'];
      await db
        .update(tables.integrations)
        .set({ shippingTags: tags, shippingNotificationsEnabled: true })
        .where(eq(tables.integrations.id, integrationA));
      const [row] = await db
        .select({ tags: tables.integrations.shippingTags })
        .from(tables.integrations)
        .where(eq(tables.integrations.id, integrationA));
      expect(row.tags).toEqual(tags);

      await expectConstraint(
        db
          .update(tables.integrations)
          .set({
            shippingTags: Array.from({ length: 11 }, (_, i) => `t${i}`),
          })
          .where(eq(tables.integrations.id, integrationA))
          .execute(),
        /integrations_shipping_tags_count_check/,
      );
    });
  });

  describe('order context', () => {
    it('finds the verification and settings in one query', async () => {
      const seeded = await seed();
      const context = await repo.findShippingContext({
        orgId: orgA,
        integrationId: integrationA,
        externalOrderId: seeded.externalOrderId,
      });
      expect(context).toMatchObject({
        verificationId: seeded.verificationId,
        verificationStatus: 'confirmed',
        verificationCanceledAt: null,
        merchantCanceledAt: null,
        orderIsTest: false,
        shippingNotificationsEnabled: true,
        shippingFulfillmentTriggerEnabled: true,
        shippingTags: ['شحن', 'Shipped', 'Kargoda', 'تم الشحن'],
      });
      expect(typeof context?.orderCreatedAt).toBe('string');
    });

    it("never resolves another store's order", async () => {
      const seeded = await seed();
      await expect(
        repo.findShippingContext({
          orgId: orgB,
          integrationId: integrationB,
          externalOrderId: seeded.externalOrderId,
        }),
      ).resolves.toBeNull();
      await expect(
        repo.findShippingContext({
          orgId: orgB,
          integrationId: integrationA,
          externalOrderId: seeded.externalOrderId,
        }),
      ).resolves.toBeNull();
      await expect(
        repo.findShippingContext({
          orgId: orgA,
          integrationId: integrationB,
          externalOrderId: seeded.externalOrderId,
        }),
      ).resolves.toBeNull();
      await expect(
        repo.findShippingContext({
          orgId: orgA,
          integrationId: integrationA,
          externalOrderId: '999',
        }),
      ).resolves.toBeNull();
    });

    it('uses the unique order key', async () => {
      const plan = await client.unsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT 1 FROM orders WHERE integration_id = '${integrationA}' AND external_order_id = '1'`,
      );
      // Tiny tables may scan; the unique key must exist for the lookup.
      const indexes = await client<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname = ${namespace} AND tablename = 'orders'`;
      expect(plan.length).toBeGreaterThan(0);
      expect(
        indexes.some((index) =>
          /\(integration_id, external_order_id\)/.test(index.indexdef),
        ),
      ).toBe(true);
    });
  });

  describe('one record per verification and stage', () => {
    it('inserts once under concurrent events', async () => {
      const seeded = await seed();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => record(seeded)),
      );
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      expect(await rowsFor(seeded.verificationId)).toHaveLength(1);
    });

    it('keeps the first record when a tag arrives after the fulfillment', async () => {
      const seeded = await seed();
      expect(await record(seeded)).not.toBeNull();
      expect(
        await record(seeded, { trigger: 'tag', matchedTag: 'Shipped' }),
      ).toBeNull();
      expect(await rowsFor(seeded.verificationId)).toEqual([
        { trigger: 'fulfillment', status: 'pending', reason_code: null },
      ]);
    });

    it('keeps a failed record when a later event would be eligible', async () => {
      const seeded = await seed();
      await record(seeded, { status: 'failed', reasonCode: 'order_cancelled' });
      expect(await record(seeded)).toBeNull();
      expect(await rowsFor(seeded.verificationId)).toEqual([
        {
          trigger: 'fulfillment',
          status: 'failed',
          reason_code: 'order_cancelled',
        },
      ]);
    });

    it('reads only within the merchant', async () => {
      const seeded = await seed();
      await record(seeded);
      await expect(
        repo.findByVerification({
          orgId: orgB,
          verificationId: seeded.verificationId,
          stage: 'shipped',
        }),
      ).resolves.toBeNull();
      await expect(
        repo.findByVerification({
          orgId: orgA,
          verificationId: seeded.verificationId,
          stage: 'shipped',
        }),
      ).resolves.toMatchObject({ status: 'pending' });
    });

    it('refuses a record filed under another merchant', async () => {
      const seeded = await seed();
      await expectConstraint(
        record(seeded, { orgId: orgB }),
        /verification_shipping_notifications_verification_fkey/,
      );
    });

    it('goes with its verification', async () => {
      const seeded = await seed();
      await record(seeded);
      await client`DELETE FROM verifications WHERE id = ${seeded.verificationId}`;
      expect(await rowsFor(seeded.verificationId)).toHaveLength(0);
    });
  });

  describe('checks', () => {
    it.each([
      [
        'a failure without a reason',
        'trigger, status',
        "'fulfillment', 'failed'",
      ],
      [
        'a reason on a pending record',
        'trigger, status, reason_code',
        "'fulfillment', 'pending', 'order_too_old'",
      ],
      [
        'an unknown reason',
        'trigger, status, reason_code',
        "'fulfillment', 'failed', 'because'",
      ],
      ['a tag trigger without its tag', 'trigger', "'tag'"],
      [
        'a fulfillment carrying a tag',
        'trigger, matched_tag',
        "'fulfillment', 'Shipped'",
      ],
      ['an unknown trigger', 'trigger', "'manual'"],
      ['an unknown status', 'trigger, status', "'fulfillment', 'lost'"],
      [
        'a plain http tracking link',
        'trigger, tracking_url',
        "'fulfillment', 'http://track.example/1'",
      ],
      [
        'an empty tracking number',
        'trigger, tracking_number',
        "'fulfillment', ''",
      ],
    ])('refuses %s', async (_label, columns, values) => {
      const seeded = await seed();
      await expect(rawInsert(seeded, columns, values)).rejects.toThrow(
        /verification_shipping_notifications_/,
      );
    });

    it('refuses an unknown stage', async () => {
      const seeded = await seed();
      await expect(
        client.unsafe(
          `INSERT INTO verification_shipping_notifications (org_id, verification_id, stage, trigger) VALUES ('${orgA}', '${seeded.verificationId}', 'delivered', 'fulfillment')`,
        ),
      ).rejects.toThrow(/verification_shipping_notifications_stage_check/);
    });

    it('accepts an https tracking link and a tag record', async () => {
      const first = await seed();
      await expect(
        record(first, {
          trackingNumber: '1Z999',
          trackingUrl: 'https://track.example/1Z999',
        }),
      ).resolves.not.toBeNull();
      const second = await seed();
      await expect(
        record(second, { trigger: 'tag', matchedTag: 'تم الشحن' }),
      ).resolves.not.toBeNull();
    });
  });

  describe('store order events end to end', () => {
    function service() {
      const automation = {
        enqueueShippingSend: jest.fn(() => Promise.resolve()),
      };
      const config = {
        get: (key: string) =>
          key === SHIPPING_NOTIFICATIONS_CONFIG ? { enabled: true } : undefined,
      };
      return {
        automation,
        shipping: new ShippingNotificationsService(
          [new ShopifyShippingEventSource()],
          repo,
          automation as never,
          config as never,
        ),
      };
    }

    function payload(seeded: Seeded, overrides: Record<string, unknown> = {}) {
      return {
        id: seeded.externalOrderId,
        created_at: new Date(Date.now() - DAY).toISOString(),
        cancelled_at: null,
        test: false,
        tags: 'Akeed: Verified',
        fulfillment_status: 'fulfilled',
        fulfillments: [
          {
            status: 'success',
            tracking_number: '1Z999',
            tracking_url: 'https://track.example/1Z999',
          },
        ],
        ...overrides,
      };
    }

    it('records a fulfilled order once, however often the event is processed', async () => {
      const seeded = await seed();
      const { shipping, automation } = service();
      const event = {
        platform: 'shopify' as const,
        orgId: orgA,
        integrationId: integrationA,
        rawPayload: payload(seeded),
      };
      await expect(shipping.handleStoreOrderUpdate(event)).resolves.toEqual({
        handled: true,
      });
      await expect(shipping.handleStoreOrderUpdate(event)).resolves.toEqual({
        skipped: true,
        reason: 'already_recorded',
      });
      const [row] = await client<
        {
          trigger: string;
          status: string;
          tracking_number: string;
          tracking_url: string;
        }[]
      >`SELECT trigger, status, tracking_number, tracking_url FROM verification_shipping_notifications WHERE verification_id = ${seeded.verificationId}`;
      expect(row).toEqual({
        trigger: 'fulfillment',
        status: 'pending',
        tracking_number: '1Z999',
        tracking_url: 'https://track.example/1Z999',
      });
      expect(automation.enqueueShippingSend).toHaveBeenCalledTimes(2);
    });

    it('records a tagged order in Arabic, ignoring Akeed tags', async () => {
      const seeded = await seed();
      const { shipping } = service();
      await shipping.handleStoreOrderUpdate({
        platform: 'shopify',
        orgId: orgA,
        integrationId: integrationA,
        rawPayload: payload(seeded, {
          fulfillment_status: null,
          fulfillments: [],
          tags: 'Akeed: Verified, تم الشحن ',
        }),
      });
      const [row] = await client<{ trigger: string; matched_tag: string }[]>`
        SELECT trigger, matched_tag FROM verification_shipping_notifications WHERE verification_id = ${seeded.verificationId}`;
      expect(row).toEqual({ trigger: 'tag', matched_tag: 'تم الشحن' });
    });

    it('records a store-cancelled order as failed and an old one too', async () => {
      const cancelled = await seed();
      const old = await seed();
      const { shipping, automation } = service();
      for (const [seeded, overrides] of [
        [cancelled, { cancelled_at: new Date().toISOString() }],
        [old, { created_at: new Date(Date.now() - 31 * DAY).toISOString() }],
      ] as const) {
        await shipping.handleStoreOrderUpdate({
          platform: 'shopify',
          orgId: orgA,
          integrationId: integrationA,
          rawPayload: payload(seeded, overrides),
        });
      }
      expect(await rowsFor(cancelled.verificationId)).toEqual([
        {
          trigger: 'fulfillment',
          status: 'failed',
          reason_code: 'order_cancelled',
        },
      ]);
      expect(await rowsFor(old.verificationId)).toEqual([
        {
          trigger: 'fulfillment',
          status: 'failed',
          reason_code: 'order_too_old',
        },
      ]);
      expect(automation.enqueueShippingSend).not.toHaveBeenCalled();
    });

    it('writes nothing for a test order or for an order of another store', async () => {
      const testOrder = await seed({ isTest: true });
      const foreign = await seed({ orgId: orgB, integrationId: integrationB });
      const { shipping } = service();
      await expect(
        shipping.handleStoreOrderUpdate({
          platform: 'shopify',
          orgId: orgA,
          integrationId: integrationA,
          rawPayload: payload(testOrder),
        }),
      ).resolves.toEqual({ skipped: true, reason: 'test_order' });
      await expect(
        shipping.handleStoreOrderUpdate({
          platform: 'shopify',
          orgId: orgA,
          integrationId: integrationA,
          rawPayload: payload(foreign),
        }),
      ).resolves.toEqual({ skipped: true, reason: 'order_not_owned' });
      expect(await rowsFor(testOrder.verificationId)).toHaveLength(0);
      expect(await rowsFor(foreign.verificationId)).toHaveLength(0);
    });

    it('drops events for a store with the feature off', async () => {
      const seeded = await seed({ orgId: orgB, integrationId: integrationB });
      const { shipping } = service();
      await expect(
        shipping.handleStoreOrderUpdate({
          platform: 'shopify',
          orgId: orgB,
          integrationId: integrationB,
          rawPayload: payload(seeded),
        }),
      ).resolves.toEqual({ skipped: true, reason: 'shipping_feature_off' });
      expect(await rowsFor(seeded.verificationId)).toHaveLength(0);
    });
  });

  describe('Shipped message replies, needs action and receipts', () => {
    const shipping = new ShippingNotificationsService(
      [new ShopifyShippingEventSource()],
      repo,
      { enqueueShippingSend: jest.fn() } as never,
      {
        get: (key: string) =>
          key === SHIPPING_NOTIFICATIONS_CONFIG ? { enabled: true } : undefined,
      } as never,
    );
    const owner = { orgId: orgA, userId: randomUUID(), role: 'owner' as const };

    /** A sent Shipped message: an accepted dispatch linked to its record. */
    async function sentRecord(
      overrides: Partial<
        typeof tables.verificationShippingNotifications.$inferInsert
      > = {},
    ) {
      const seeded = await seed();
      const [dispatch] = await db
        .insert(tables.verificationMessageDispatches)
        .values({
          orgId: orgA,
          integrationId: integrationA,
          verificationId: seeded.verificationId,
          kind: 'shipping_shipped',
          generation: 1,
          dispatchKey: `${seeded.verificationId}:shipping_shipped:1`,
          state: 'accepted',
          providerMessageId: `wamid.${randomUUID()}`,
          acceptedAt: new Date().toISOString(),
        })
        .returning();
      const row = await record(seeded, {
        status: 'sent',
        dispatchId: dispatch.id,
        ...overrides,
      });
      return { seeded, dispatch, row: row! };
    }

    async function reasonOf(verificationId: string) {
      const [row] = await db
        .select({ reason: needsActionReasonSql() })
        .from(tables.verifications)
        .where(eq(tables.verifications.id, verificationId));
      return row?.reason ?? null;
    }

    async function replyOf(verificationId: string) {
      const [row] = await client<
        {
          customer_reply: string | null;
          needs_action_resolved_at: string | null;
        }[]
      >`SELECT customer_reply, needs_action_resolved_at FROM verification_shipping_notifications WHERE verification_id = ${verificationId}`;
      return row;
    }

    it('keeps only the first of concurrent taps and sets delivery_request once', async () => {
      const { seeded } = await sentRecord();
      const replies = [
        'reschedule',
        'address',
        'home',
        'reschedule',
        'address',
        'home',
      ] as const;
      const results = await Promise.all(
        replies.map((reply) =>
          shipping.recordCustomerReply({
            orgId: orgA,
            verificationId: seeded.verificationId,
            reply,
            at: new Date().toISOString(),
          }),
        ),
      );
      expect(results.filter((result) => result.recorded)).toHaveLength(1);
      const stored = await replyOf(seeded.verificationId);
      expect(replies).toContain(stored.customer_reply);
      const winner = results.find((result) => result.recorded)!;
      expect(winner.deliveryRequest).toBe(stored.customer_reply !== 'home');
      expect(await reasonOf(seeded.verificationId)).toBe(
        stored.customer_reply === 'home' ? null : 'delivery_request',
      );
    });

    it('a reschedule shows delivery_request until the merchant marks it done, once', async () => {
      const { seeded } = await sentRecord();
      await shipping.recordCustomerReply({
        orgId: orgA,
        verificationId: seeded.verificationId,
        reply: 'reschedule',
        at: new Date().toISOString(),
      });
      // A later tap changes nothing.
      expect(
        await shipping.recordCustomerReply({
          orgId: orgA,
          verificationId: seeded.verificationId,
          reply: 'home',
          at: new Date().toISOString(),
        }),
      ).toEqual({ recorded: false, deliveryRequest: false });
      expect(await reasonOf(seeded.verificationId)).toBe('delivery_request');
      const resolved = await shipping.resolveNeedsAction(
        owner,
        seeded.verificationId,
      );
      expect(typeof resolved.resolvedAt).toBe('string');
      expect(await reasonOf(seeded.verificationId)).toBeNull();
      await expect(
        shipping.resolveNeedsAction(owner, seeded.verificationId),
      ).rejects.toMatchObject({
        response: { code: 'SHIPPING_NOTHING_TO_RESOLVE' },
      });
    });

    it('I will be home is recorded and needs nothing', async () => {
      const { seeded } = await sentRecord();
      await shipping.recordCustomerReply({
        orgId: orgA,
        verificationId: seeded.verificationId,
        reply: 'home',
        at: new Date().toISOString(),
      });
      expect((await replyOf(seeded.verificationId)).customer_reply).toBe(
        'home',
      );
      expect(await reasonOf(seeded.verificationId)).toBeNull();
      await expect(
        shipping.resolveNeedsAction(owner, seeded.verificationId),
      ).rejects.toMatchObject({
        response: { code: 'SHIPPING_NOTHING_TO_RESOLVE' },
      });
    });

    it('ignores a tap or a resolution from another store', async () => {
      const { seeded } = await sentRecord();
      expect(
        await shipping.recordCustomerReply({
          orgId: orgB,
          verificationId: seeded.verificationId,
          reply: 'address',
          at: new Date().toISOString(),
        }),
      ).toEqual({ recorded: false, deliveryRequest: false });
      expect((await replyOf(seeded.verificationId)).customer_reply).toBeNull();
      await shipping.recordCustomerReply({
        orgId: orgA,
        verificationId: seeded.verificationId,
        reply: 'address',
        at: new Date().toISOString(),
      });
      await expect(
        shipping.resolveNeedsAction(
          { ...owner, orgId: orgB },
          seeded.verificationId,
        ),
      ).rejects.toMatchObject({
        response: { code: 'SHIPPING_NOTIFICATION_NOT_FOUND' },
      });
      expect(await reasonOf(seeded.verificationId)).toBe('delivery_request');
    });

    it('refuses a viewer', async () => {
      const { seeded } = await sentRecord();
      await expect(
        shipping.resolveNeedsAction(
          { ...owner, role: 'viewer' },
          seeded.verificationId,
        ),
      ).rejects.toMatchObject({
        response: { code: 'VERIFICATION_ROLE_REQUIRED' },
      });
    });

    it('never records a tap on a message that was not sent', async () => {
      const seeded = await seed();
      await record(seeded);
      expect(
        await shipping.recordCustomerReply({
          orgId: orgA,
          verificationId: seeded.verificationId,
          reply: 'address',
          at: new Date().toISOString(),
        }),
      ).toEqual({ recorded: false, deliveryRequest: false });
    });

    it.each(['no_phone', 'not_on_whatsapp'] as const)(
      'a record failed with %s needs action until marked done',
      async (reason) => {
        const seeded = await seed();
        await record(seeded, { status: 'failed', reasonCode: reason });
        expect(await reasonOf(seeded.verificationId)).toBe(
          'shipping_not_reachable',
        );
        await shipping.resolveNeedsAction(owner, seeded.verificationId);
        expect(await reasonOf(seeded.verificationId)).toBeNull();
      },
    );

    it('a record failed for allowance needs no action', async () => {
      const seeded = await seed();
      await record(seeded, { status: 'failed', reasonCode: 'allowance_low' });
      expect(await reasonOf(seeded.verificationId)).toBeNull();
    });

    it('checks the reply and the resolution', async () => {
      const seeded = await seed();
      await expectConstraint(
        rawInsert(
          seeded,
          'trigger, customer_reply, customer_replied_at',
          `'fulfillment', 'cancel', now()`,
        ),
        /verification_shipping_notifications_reply_check/,
      );
      await expectConstraint(
        rawInsert(seeded, 'trigger, customer_reply', `'fulfillment', 'home'`),
        /verification_shipping_notifications_reply_check/,
      );
      await expectConstraint(
        rawInsert(
          seeded,
          'trigger, customer_reply, customer_replied_at, needs_action_resolved_at',
          `'fulfillment', 'home', now(), now()`,
        ),
        /verification_shipping_notifications_resolution_check/,
      );
    });

    it('receipts move the record forward only, and never the verification', async () => {
      const { seeded, dispatch, row } = await sentRecord();
      const ledger = new VerificationMessageDispatchesRepository(
        db as never,
        usageAccountingFixture(),
      );
      await ledger.recordProviderStatus(
        dispatch.id,
        'read',
        new Date().toISOString(),
      );
      await ledger.recordProviderStatus(
        dispatch.id,
        'delivered',
        new Date().toISOString(),
      );
      const [after] = await db
        .select()
        .from(tables.verificationShippingNotifications)
        .where(eq(tables.verificationShippingNotifications.id, row.id));
      expect(after.status).toBe('read');
      const [verification] = await db
        .select()
        .from(tables.verifications)
        .where(eq(tables.verifications.id, seeded.verificationId));
      expect(verification.status).toBe('confirmed');
      expect(verification.deliveredAt).toBeNull();
    });
  });
});
