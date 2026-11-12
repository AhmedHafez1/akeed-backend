import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { PlanRequiredNoticesRepository } from '../src/infrastructure/database/repositories/plan-required-notices.repository';

const h = creditUsageHarness();
const notices = new PlanRequiredNoticesRepository(h.db);
beforeAll(async () => {
  await h.setup();
  await h.scaffold(tables.adminStoreLifecycles);
  // Scaffold is generated from today's schema; apply the real forward migration against its prior shape.
  await h.client.unsafe(
    'ALTER TABLE admin_store_lifecycles DROP CONSTRAINT admin_store_lifecycles_identity_key',
  );
  const migration = readFileSync(
    resolve(__dirname, '../drizzle/0098_plan_required_notices.sql'),
    'utf8',
  ).replaceAll('public.', `"${h.namespace}".`);
  for (let pass = 0; pass < 2; pass++) {
    for (const statement of migration.split('--> statement-breakpoint'))
      await h.client.unsafe(statement);
  }
});
afterAll(() => h.teardown());
beforeEach(async () => {
  await h.client`DELETE FROM plan_required_notices`;
});

async function merchant(status = 'cancelled') {
  const fixture = await h.merchant(0, 'shopify');
  await h.db
    .update(tables.integrations)
    .set({
      billingStatus: status,
      billingPlanId: 'pro',
      onboardingStatus: 'pending',
      notificationEmail: 'synthetic@example.test',
    })
    .where(eq(tables.integrations.id, fixture.integrationId));
  return fixture;
}

it('completes setup atomically and claims one email across concurrent submissions and later visits', async () => {
  const source = await merchant();
  const first = await Promise.all(
    Array.from({ length: 5 }, () =>
      notices.completeSetup(source.orgId, source.integrationId),
    ),
  );
  expect(first.filter(Boolean)).toHaveLength(1);
  expect(await h.db.select().from(tables.planRequiredNotices)).toHaveLength(1);
  expect(
    (
      await h.db
        .select()
        .from(tables.integrations)
        .where(eq(tables.integrations.id, source.integrationId))
    )[0].onboardingStatus,
  ).toBe('completed');
  await notices.completeSetup(source.orgId, source.integrationId);
  expect(await h.db.select().from(tables.planRequiredNotices)).toHaveLength(1);
});

it('does not create notices for active or live paid-through plans, or another tenant', async () => {
  const active = await merchant('active');
  await notices.completeSetup(active.orgId, active.integrationId);
  const resumed = await merchant('paid_through');
  await h.db
    .update(tables.integrations)
    .set({ paidThroughAt: '2099-01-01T00:00:00Z' })
    .where(eq(tables.integrations.id, resumed.integrationId));
  await notices.completeSetup(resumed.orgId, resumed.integrationId);
  expect(await notices.completeSetup(randomUUID(), active.integrationId)).toBe(
    false,
  );
  expect(await h.db.select().from(tables.planRequiredNotices)).toHaveLength(0);
});

it('creates a new notice for a new installation and rejects foreign lifecycle ownership', async () => {
  const source = await merchant();
  await notices.completeSetup(source.orgId, source.integrationId);
  const [old] = await h.db
    .select()
    .from(tables.adminStoreLifecycles)
    .where(eq(tables.adminStoreLifecycles.integrationId, source.integrationId));
  await h.db
    .update(tables.adminStoreLifecycles)
    .set({ uninstalledAt: new Date().toISOString() })
    .where(eq(tables.adminStoreLifecycles.id, old.id));
  await notices.completeSetup(source.orgId, source.integrationId);
  expect(await h.db.select().from(tables.planRequiredNotices)).toHaveLength(2);
  const other = await merchant();
  await expect(
    h.db.insert(tables.planRequiredNotices).values({
      orgId: other.orgId,
      integrationId: other.integrationId,
      lifecycleId: old.id,
    }),
  ).rejects.toThrow();
});

it('recovers an interrupted claim, fences old attempts and preserves the email snapshot', async () => {
  const source = await merchant();
  await notices.completeSetup(source.orgId, source.integrationId);
  const first = (await notices.claim())!;
  const payload = {
    to: 'synthetic@example.test',
    subject: 'Synthetic',
    text: 'Synthetic',
    html: '<p>Synthetic</p>',
    idempotencyKey: 'stable-key',
  };
  expect(await notices.prepare(first, payload)).toBe(true);
  expect(await notices.claim()).toBeNull();
  await h.db
    .update(tables.planRequiredNotices)
    .set({ leaseUntil: '2020-01-01T00:00:00Z' })
    .where(eq(tables.planRequiredNotices.id, first.id));
  const second = (await notices.claim())!;
  expect(second.attempts).toBe(2);
  expect(second.emailPayload).toEqual(payload);
  await notices.settle(first, 'sent');
  expect((await h.db.select().from(tables.planRequiredNotices))[0].status).toBe(
    'sending',
  );
  await notices.settle(second, 'sent');
  expect(await notices.claim()).toBeNull();
});

it('counts distinct billing-related skips only within this installation and 48 hours', async () => {
  const source = await merchant();
  const now = new Date();
  await h.db.insert(tables.adminStoreLifecycles).values({
    orgId: source.orgId,
    integrationId: source.integrationId,
    installedAt: new Date(now.getTime() - 72 * 3_600_000).toISOString(),
  });
  const insert = (
    id: string,
    reason = 'billing_not_active',
    ageHours = 1,
    orgId = source.orgId,
    integrationId = source.integrationId,
  ) =>
    h.db.insert(tables.webhookEvents).values({
      platform: 'shopify',
      jobType: 'order.create',
      storeDomain: 'synthetic.myshopify.com',
      orgId,
      integrationId,
      idempotencyKey: randomUUID(),
      rawPayload: { id },
      status: 'skipped',
      lastError: reason,
      receivedAt: new Date(now.getTime() - ageHours * 3_600_000).toISOString(),
    });
  await insert('101');
  await insert('101');
  await insert('102');
  await insert('old', 'billing_not_active', 50);
  await insert('not-cod', 'not_cod');
  const other = await merchant();
  await insert(
    'foreign',
    'billing_not_active',
    1,
    other.orgId,
    other.integrationId,
  );
  const [integration] = await h.db
    .select()
    .from(tables.integrations)
    .where(eq(tables.integrations.id, source.integrationId));
  expect(await notices.countMissedOrders(integration, now)).toMatchObject({
    count: 2,
  });
  const [order] = await h.db
    .insert(tables.orders)
    .values({
      orgId: source.orgId,
      integrationId: source.integrationId,
      externalOrderId: '101',
      customerPhone: '+201000000000',
      totalPrice: '100',
    })
    .returning();
  await h.db
    .insert(tables.verifications)
    .values({ orgId: source.orgId, orderId: order.id, status: 'confirmed' });
  expect(await notices.countMissedOrders(integration, now)).toMatchObject({
    count: 1,
  });
});

it('cascades notice envelopes when an installation is deleted', async () => {
  const source = await merchant();
  await notices.completeSetup(source.orgId, source.integrationId);
  await h.db
    .delete(tables.adminStoreLifecycles)
    .where(eq(tables.adminStoreLifecycles.integrationId, source.integrationId));
  expect(await h.db.select().from(tables.planRequiredNotices)).toHaveLength(0);
});
