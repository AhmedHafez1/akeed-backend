import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { OrderIntakeRepository } from '../src/infrastructure/database/repositories/order-intake.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import {
  AdminQueryRepository,
  type AdminStoreListFilter,
} from '../src/modules/admin/admin-query.repository';
import { AdminHealthRuleService } from '../src/modules/admin/admin-health-rule.service';
import type { OrderIntakeRecord } from '../src/shared/commerce/order-intake.policy';
import {
  backfillOrderIntake,
  toIntakeRecord,
} from '../scripts/backfill-order-intake';

const h = creditUsageHarness();
const intake = new OrderIntakeRepository(h.db as never);
const admin = new AdminQueryRepository(h.db as never);
const rules = new AdminHealthRuleService(new ConfigService({}));
const HOUR = 60 * 60 * 1000;
// Fixed per run, so orders meant for one hour bucket never straddle two.
const RECENT = new Date(Date.now() - 2 * HOUR);
const BASELINE = new Date(Date.now() - 3 * 24 * HOUR);

beforeAll(async () => {
  await h.setup();
  await h.scaffold(tables.adminStoreLifecycles);
  // Apply the real migration twice: it must be re-runnable. Its lifecycle
  // columns already exist on the scaffold, so those statements are no-ops.
  const migration = readFileSync(
    resolve(__dirname, '../drizzle/0099_admin_store_signals.sql'),
    'utf8',
  ).replaceAll('public.', `"${h.namespace}".`);
  for (let pass = 0; pass < 2; pass++)
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.replace(/--.*$/gm, '').trim())
        await h.client.unsafe(statement);
});
afterAll(() => h.teardown());

function ago(ms: number) {
  return new Date(Date.now() - ms);
}

async function store(
  values: Partial<typeof tables.integrations.$inferInsert> = {},
) {
  const fixture = await h.merchant(0, 'shopify');
  await h.db
    .update(tables.integrations)
    .set({
      onboardingStatus: 'completed',
      isAutoVerifyEnabled: true,
      billingPlanId: 'pro',
      billingStatus: 'active',
      billingActivatedAt: ago(40 * 24 * HOUR).toISOString(),
      ...values,
    })
    .where(eq(tables.integrations.id, fixture.integrationId));
  return fixture;
}

function record(
  integrationId: string,
  overrides: Partial<OrderIntakeRecord> = {},
): OrderIntakeRecord {
  return {
    integrationId,
    externalOrderId: randomUUID(),
    receivedAt: RECENT,
    outcome: 'eligible',
    skipReason: null,
    paymentMethod: 'Cash on Delivery (COD)',
    ...overrides,
  };
}

async function orders(
  integrationId: string,
  count: number,
  overrides: Partial<OrderIntakeRecord> = {},
) {
  for (let index = 0; index < count; index++)
    await intake.record(record(integrationId, overrides));
}

const notCod = {
  outcome: 'skipped' as const,
  skipReason: 'non_cod_payment_method',
  paymentMethod: 'manual',
};

async function rowsFor(filter: AdminStoreListFilter = {}) {
  const { rows } = await admin.findStorePage(
    filter,
    { limit: 500, sort: 'installed_at', direction: 'desc' },
    {
      lowBalanceThreshold: 10,
      planLimits: { starter: 30, basic: 300, pro: 1000, business: 2500 },
      paidPlanIds: ['basic', 'pro', 'business'],
      healthSignals: (columns) => rules.signalsSql(columns),
    },
  );
  return rows;
}

async function signalsOf(integrationId: string) {
  const row = (await rowsFor()).find(
    (candidate) => candidate.integration_id === integrationId,
  );
  if (!row) throw new Error('store missing from the list');
  return {
    critical: row.critical_signals,
    attention: row.attention_signals,
    row,
  };
}

async function buckets(integrationId: string) {
  return h.db
    .select()
    .from(tables.integrationOrderIntake)
    .where(eq(tables.integrationOrderIntake.integrationId, integrationId));
}

describe('order intake counts', () => {
  it('counts a store order once across duplicate and concurrent deliveries', async () => {
    const { integrationId } = await store();
    const first = record(integrationId, { externalOrderId: 'shopify-1001' });

    expect(await intake.record(first)).toBe(true);
    // A second Shopify delivery with another webhook id, and a retry.
    expect(await intake.record({ ...first, receivedAt: ago(HOUR) })).toBe(
      false,
    );
    const concurrent = record(integrationId, {
      externalOrderId: 'shopify-1002',
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => intake.record(concurrent)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const [bucket] = await buckets(integrationId);
    expect(bucket).toMatchObject({ received: 2, eligible: 2, skipped: 0 });
    expect(bucket.paymentMethods).toEqual({ 'Cash on Delivery (COD)': 2 });
  });

  it('counts every skip reason and payment method, capping distinct names', async () => {
    const { integrationId } = await store();
    const reasons = [
      'non_cod_payment_method',
      'missing_payment_signal',
      'auto_verify_disabled',
      'onboarding_incomplete',
      'billing_not_active',
      'integration_inactive',
      'normalisation_failed',
      'invalid_phone',
    ];
    for (const reason of reasons)
      await intake.record(
        record(integrationId, {
          outcome: 'skipped',
          skipReason: reason,
          paymentMethod: `method ${reason}`,
        }),
      );
    for (let index = 0; index < 4; index++)
      await intake.record(
        record(integrationId, { paymentMethod: `  extra   ${index} ` }),
      );
    await intake.record(record(integrationId, { paymentMethod: null }));

    const [bucket] = await buckets(integrationId);
    expect(bucket).toMatchObject({ received: 13, eligible: 5, skipped: 8 });
    expect(bucket.skippedByReason).toEqual(
      Object.fromEntries(reasons.map((reason) => [reason, 1])),
    );
    expect(Object.keys(bucket.paymentMethods)).toHaveLength(11);
    expect(bucket.paymentMethods).toMatchObject({
      'extra 0': 1,
      'extra 1': 1,
      other: 3,
    });
  });

  it('keeps 90 days of rows', async () => {
    const { integrationId } = await store();
    await intake.record(
      record(integrationId, { receivedAt: ago(91 * 24 * HOUR) }),
    );
    await intake.record(
      record(integrationId, { receivedAt: ago(89 * 24 * HOUR) }),
    );

    const result = await intake.deleteOlderThan(ago(90 * 24 * HOUR));

    expect(result.orders).toBeGreaterThanOrEqual(1);
    expect(result.buckets).toBeGreaterThanOrEqual(1);
    expect(await buckets(integrationId)).toHaveLength(1);
    const ledger = await h.db
      .select()
      .from(tables.integrationOrderIntakeOrders)
      .where(
        eq(tables.integrationOrderIntakeOrders.integrationId, integrationId),
      );
    expect(ledger).toHaveLength(1);
  });
});

describe('orders_not_eligible', () => {
  async function codStore() {
    const fixture = await store();
    await orders(fixture.integrationId, 8, { receivedAt: BASELINE });
    return fixture;
  }

  it('is critical when a COD store suddenly skips every order', async () => {
    const { integrationId } = await codStore();
    await orders(integrationId, 13, notCod);

    const { critical, attention, row } = await signalsOf(integrationId);

    expect(critical).toContain('orders_not_eligible');
    expect(attention).not.toContain('orders_not_eligible');
    expect(row).toMatchObject({
      intake_received_24h: 13,
      intake_skipped_24h: 13,
      intake_top_skip_reason: 'non_cod_payment_method',
      intake_top_payment_method: 'manual',
    });
  });

  it('never fires for a store that never had COD orders', async () => {
    const { integrationId } = await store();
    await orders(integrationId, 6, {
      ...notCod,
      receivedAt: ago(4 * 24 * HOUR),
    });
    await orders(integrationId, 12, notCod);

    const { critical, attention } = await signalsOf(integrationId);

    expect([...critical, ...attention]).not.toContain('orders_not_eligible');
  });

  it('waits for at least 5 orders in the last 24 hours', async () => {
    const { integrationId } = await codStore();
    await orders(integrationId, 4, notCod);

    const { critical, attention } = await signalsOf(integrationId);

    expect([...critical, ...attention]).not.toContain('orders_not_eligible');
  });

  it('asks for attention when the eligible share falls by more than half', async () => {
    const { integrationId } = await codStore();
    await orders(integrationId, 2);
    await orders(integrationId, 4, notCod);

    const { critical, attention } = await signalsOf(integrationId);

    expect(critical).not.toContain('orders_not_eligible');
    expect(attention).toContain('orders_not_eligible');
  });

  it('stays quiet for a normal day', async () => {
    const { integrationId } = await codStore();
    await orders(integrationId, 5);
    await orders(integrationId, 1, notCod);

    const { critical, attention } = await signalsOf(integrationId);

    expect([...critical, ...attention]).not.toContain('orders_not_eligible');
  });
});

describe('lost paying stores', () => {
  const integrationsRepo = new IntegrationsRepository(
    h.db as never,
    new ConfigService({}),
  );

  async function installed(integrationId: string, orgId: string, at: Date) {
    await h.db.insert(tables.adminStoreLifecycles).values({
      orgId,
      integrationId,
      installedAt: at.toISOString(),
      onboardingCompletedAt: at.toISOString(),
    });
  }

  it('marks an uninstalled store that was on an active paid plan as critical', async () => {
    const paid = await store({ shopifySubscriptionId: 'gid://synthetic/1' });
    await installed(paid.integrationId, paid.orgId, ago(40 * 24 * HOUR));
    await integrationsRepo.markShopifyUninstalled(
      paid.integrationId,
      ago(2 * HOUR).toISOString(),
    );
    const free = await store({ billingPlanId: 'starter' });
    await installed(free.integrationId, free.orgId, ago(40 * 24 * HOUR));
    await integrationsRepo.markShopifyUninstalled(
      free.integrationId,
      ago(2 * HOUR).toISOString(),
    );

    const paidSignals = await signalsOf(paid.integrationId);
    const freeSignals = await signalsOf(free.integrationId);

    expect(paidSignals.critical).toEqual(['paid_store_uninstalled']);
    expect(paidSignals.attention).toEqual([]);
    expect(paidSignals.row).toMatchObject({
      uninstall_plan_id: 'pro',
      uninstall_was_active: true,
    });
    expect(paidSignals.row.uninstall_paid_through_at).not.toBeNull();
    expect(freeSignals.critical).toEqual([]);
    expect(freeSignals.attention).toEqual(['store_uninstalled']);

    const [lifecycle] = await h.db
      .select()
      .from(tables.adminStoreLifecycles)
      .where(eq(tables.adminStoreLifecycles.integrationId, paid.integrationId));
    expect(lifecycle).toMatchObject({
      uninstallPlanId: 'pro',
      uninstallBillingStatus: 'active',
    });
  });

  it('does not treat a paid plan that was already cancelled as a lost paying store', async () => {
    const cancelled = await store({
      billingStatus: 'cancelled',
      billingCanceledAt: ago(10 * 24 * HOUR).toISOString(),
    });
    await installed(
      cancelled.integrationId,
      cancelled.orgId,
      ago(40 * 24 * HOUR),
    );
    await integrationsRepo.markShopifyUninstalled(
      cancelled.integrationId,
      ago(2 * HOUR).toISOString(),
    );

    const { critical, attention } = await signalsOf(cancelled.integrationId);

    expect(critical).toEqual([]);
    expect(attention).toEqual(['store_uninstalled']);
  });

  it('says a reinstalled store lost its plan instead of subscription_blocked', async () => {
    const reinstalled = await store({ billingStatus: 'cancelled' });
    await h.db.insert(tables.adminStoreLifecycles).values({
      orgId: reinstalled.orgId,
      integrationId: reinstalled.integrationId,
      installedAt: ago(40 * 24 * HOUR).toISOString(),
      uninstalledAt: ago(26 * HOUR).toISOString(),
      uninstallPlanId: 'pro',
      uninstallBillingStatus: 'active',
    });
    await installed(
      reinstalled.integrationId,
      reinstalled.orgId,
      ago(25 * HOUR),
    );
    const blocked = await store({ billingStatus: 'frozen' });
    await installed(blocked.integrationId, blocked.orgId, ago(40 * 24 * HOUR));

    const lost = await signalsOf(reinstalled.integrationId);
    const frozen = await signalsOf(blocked.integrationId);

    expect(lost.critical).toContain('reinstalled_without_plan');
    expect(lost.critical).not.toContain('subscription_blocked');
    expect(lost.row).toMatchObject({ previous_plan_id: 'pro' });
    expect(lost.row.previous_uninstalled_at).not.toBeNull();
    expect(frozen.critical).toContain('subscription_blocked');
    expect(frozen.critical).not.toContain('reinstalled_without_plan');
  });

  it('does not fire for a reinstalled store that has a plan again', async () => {
    const back = await store();
    await h.db.insert(tables.adminStoreLifecycles).values({
      orgId: back.orgId,
      integrationId: back.integrationId,
      installedAt: ago(40 * 24 * HOUR).toISOString(),
      uninstalledAt: ago(26 * HOUR).toISOString(),
      uninstallPlanId: 'pro',
      uninstallBillingStatus: 'active',
    });
    await installed(back.integrationId, back.orgId, ago(25 * HOUR));

    const { critical } = await signalsOf(back.integrationId);

    expect(critical).not.toContain('reinstalled_without_plan');
  });
});

describe('signal filter', () => {
  it('returns only stores carrying the signal', async () => {
    const skipping = await store();
    await orders(skipping.integrationId, 8, { receivedAt: BASELINE });
    await orders(skipping.integrationId, 9, notCod);
    const healthy = await store();
    await orders(healthy.integrationId, 8, { receivedAt: BASELINE });
    await orders(healthy.integrationId, 6);

    const rows = await rowsFor({ signal: 'orders_not_eligible' });
    const ids = rows.map((row) => row.integration_id);

    expect(ids).toContain(skipping.integrationId);
    expect(ids).not.toContain(healthy.integrationId);
    for (const row of rows)
      expect([...row.critical_signals, ...row.attention_signals]).toContain(
        'orders_not_eligible',
      );
  });
});

describe('store details order intake', () => {
  it('groups unique orders by local day with reasons and payment methods', async () => {
    const { integrationId } = await store();
    await orders(integrationId, 3, { receivedAt: BASELINE });
    await orders(integrationId, 5, notCod);

    const result = await admin.findStoreOrderIntake(
      integrationId,
      'Africa/Cairo',
      7,
    );

    expect(
      result.days.reduce((sum, day) => sum + Number(day.received), 0),
    ).toBe(8);
    expect(result.reasons).toEqual([
      { key: 'non_cod_payment_method', count: 5 },
    ]);
    expect(result.paymentMethods).toEqual([
      { key: 'manual', count: 5 },
      { key: 'Cash on Delivery (COD)', count: 3 },
    ]);
  });
});

describe('order intake backfill', () => {
  async function event(
    integrationId: string,
    orgId: string,
    values: {
      status: 'completed' | 'skipped';
      lastError?: string;
      id: number;
      gateway: string;
    },
  ) {
    await h.db.insert(tables.webhookEvents).values({
      platform: 'shopify',
      jobType: 'order.create',
      idempotencyKey: randomUUID(),
      storeDomain: `${orgId}.myshopify.com`,
      orgId,
      integrationId,
      status: values.status,
      lastError: values.lastError ?? null,
      rawPayload: {
        id: values.id,
        payment_gateway_names: [values.gateway],
        phone: '+201000000000',
      },
      receivedAt: ago(3 * HOUR).toISOString(),
    });
  }

  it('maps finished events and leaves out events without a trusted store', () => {
    const base = {
      id: randomUUID(),
      integration_id: randomUUID(),
      platform: 'shopify',
      idempotency_key: 'k',
      last_error: null,
      raw_payload: { id: 9, gateway: 'manual' },
      received_at: '2026-11-10T16:13:00.000Z',
    };
    expect(toIntakeRecord({ ...base, status: 'completed' })).toMatchObject({
      externalOrderId: '9',
      outcome: 'eligible',
      paymentMethod: 'manual',
    });
    expect(
      toIntakeRecord({
        ...base,
        status: 'skipped',
        last_error: 'non_cod_payment_method',
      }),
    ).toMatchObject({
      outcome: 'skipped',
      skipReason: 'non_cod_payment_method',
    });
    expect(
      toIntakeRecord({
        ...base,
        status: 'skipped',
        last_error: 'source_identity_mismatch',
      }),
    ).toBeNull();
    expect(toIntakeRecord({ ...base, status: 'failed' })).toBeNull();
    expect(
      toIntakeRecord({ ...base, integration_id: null, status: 'completed' }),
    ).toBeNull();
  });

  it('writes nothing on a dry run and counts each order once on apply', async () => {
    const { integrationId, orgId } = await store();
    await event(integrationId, orgId, {
      status: 'completed',
      id: 1,
      gateway: 'Cash on Delivery (COD)',
    });
    // The same order delivered twice under two webhook ids.
    await event(integrationId, orgId, {
      status: 'skipped',
      lastError: 'non_cod_payment_method',
      id: 2,
      gateway: 'manual',
    });
    await event(integrationId, orgId, {
      status: 'skipped',
      lastError: 'non_cod_payment_method',
      id: 2,
      gateway: 'manual',
    });

    const dry = await backfillOrderIntake(h.db as never);
    expect(dry.stores.get(integrationId)).toEqual({
      orders: 2,
      eligible: 1,
      skipped: { non_cod_payment_method: 1 },
      paymentMethods: { 'Cash on Delivery (COD)': 1, manual: 1 },
    });
    expect(dry.counted).toBe(0);
    expect(await buckets(integrationId)).toHaveLength(0);

    const applied = await backfillOrderIntake(h.db as never, { apply: true });
    expect(applied.counted).toBeGreaterThanOrEqual(2);
    const [bucket] = await buckets(integrationId);
    expect(bucket).toMatchObject({ received: 2, eligible: 1, skipped: 1 });

    const again = await backfillOrderIntake(h.db as never, { apply: true });
    expect(again.counted).toBe(0);
    const [unchanged] = await buckets(integrationId);
    expect(unchanged.received).toBe(2);
  });
});
