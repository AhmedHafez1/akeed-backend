import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { AdminQueryRepository } from '../src/modules/admin/admin-query.repository';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { CreditUsageRepository } from '../src/infrastructure/database/repositories/credit-usage.repository';
import { WhatsappSenderReadRepository } from '../src/infrastructure/database/repositories/whatsapp-sender-read.repository';
import {
  adminStoreLifecycles,
  integrations,
  verifications,
  verificationMessageDispatches,
  whatsappConnections,
} from '../src/infrastructure/database/schema';

const h = creditUsageHarness();
const usage = new CreditUsageRepository(h.db);
const latest = new WhatsappSenderReadRepository(h.db);
const asOf = '2026-11-04T12:00:00.000Z';

async function completeUsage(orgId: string, timeZone: string, at: string) {
  const snapshot = await usage.read(orgId, timeZone, at);
  if (!snapshot) throw new Error('Expected complete usage fixture');
  return snapshot;
}

describe('merchant per-send usage on disposable PostgreSQL', () => {
  beforeAll(async () => {
    await h.setup();
    await h.scaffold(adminStoreLifecycles);
  });
  afterAll(h.teardown);

  async function send(
    source: Awaited<ReturnType<typeof h.merchant>>,
    at: string,
    own = false,
    kind: 'initial' | 'acknowledgment' = 'initial',
  ) {
    const input = await h.verification(source);
    if (kind === 'acknowledgment') {
      await h.db
        .update(integrations)
        .set({ acknowledgmentEnabled: true })
        .where(eq(integrations.id, source.integrationId));
      await h.db
        .update(verifications)
        .set({ status: 'confirmed', confirmationSource: 'customer' })
        .where(eq(verifications.id, input.verificationId));
    }
    let connectionId: string | null = null;
    if (own) {
      const [connection] = await h.db
        .insert(whatsappConnections)
        .values({
          orgId: source.orgId,
          wabaId: randomUUID(),
          phoneNumberId: randomUUID(),
          signupPath: 'coexistence',
          state: 'active',
          businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
        })
        .onConflictDoUpdate({
          target: whatsappConnections.orgId,
          set: { state: 'active' },
        })
        .returning();
      connectionId = connection.id;
    }
    const claim = await h.dispatches.claim({
      ...input,
      kind,
      ...(kind === 'acknowledgment'
        ? { repliedAt: new Date().toISOString() }
        : {}),
      sender: {
        kind: own ? 'merchant_own' : 'akeed_system',
        connectionId,
        reason: own ? 'own_number' : 'feature_off',
        units: 1,
      },
    });
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    await h.acceptance(claim.dispatch);
    await h.db
      .update(verificationMessageDispatches)
      .set({ acceptedAt: at })
      .where(eq(verificationMessageDispatches.id, claim.dispatch.id));
    return claim.dispatch;
  }

  it('counts both spare-funded sends on their actual days and shared thank-yous once', async () => {
    const source = await h.merchant(10);
    await send(source, '2026-11-02T12:00:00Z', true);
    await send(source, '2026-11-03T12:00:00Z', true);
    await send(source, '2026-11-04T10:00:00Z', false, 'acknowledgment');
    const result = await completeUsage(source.orgId, 'UTC', asOf);
    expect(result).toMatchObject({
      usedThisMonth: 4,
      bySender: { akeed: 2, ownNumber: 2 },
    });
    expect(result.daily.slice(-3).map((day) => day.credits)).toEqual([1, 1, 2]);
    expect(result.daily).toHaveLength(14);
    expect(await latest.lastAccepted(source.orgId)).toMatchObject({
      kind: 'merchant_own',
      acceptedAt: '2026-11-03T12:00:00.000Z',
    });
    expect((await completeUsage(randomUUID(), 'UTC', asOf)).usedThisMonth).toBe(
      0,
    );
  });

  it('restates refunds on the original day and separates local midnight and month boundaries', async () => {
    const source = await h.merchant(10);
    const refunded = await send(source, '2026-11-03T12:00:00Z', true);
    await h.db
      .update(verificationMessageDispatches)
      .set({ billingRefundedAt: '2026-11-04T10:00:00Z' })
      .where(eq(verificationMessageDispatches.id, refunded.id));
    await send(source, '2026-10-31T22:30:00Z');
    const utc = await completeUsage(source.orgId, 'UTC', asOf);
    const cairo = await completeUsage(source.orgId, 'Africa/Cairo', asOf);
    expect(utc.usedThisMonth).toBe(0);
    expect(cairo.usedThisMonth).toBe(2);
    expect(cairo.daily.find((day) => day.date === '2026-11-01')?.credits).toBe(
      2,
    );
    expect(cairo.daily.find((day) => day.date === '2026-11-03')?.credits).toBe(
      0,
    );
    expect(cairo.monthStart).toBe('2026-11-01');
  });

  it('keeps a complete 14-day window across DST without including future acceptance', async () => {
    const source = await h.merchant(10);
    await send(source, '2026-11-01T05:30:00Z');
    await send(source, '2026-11-01T06:30:00Z');
    await send(source, '2026-11-05T12:00:00Z');
    const result = await completeUsage(source.orgId, 'America/New_York', asOf);
    expect(result.usedThisMonth).toBe(4);
    expect(result.daily.find((day) => day.date === '2026-11-01')?.credits).toBe(
      4,
    );
    expect(new Set(result.daily.map((day) => day.date)).size).toBe(14);
  });

  it('reads legacy consumption evidence and its reversal without estimating a sender price', async () => {
    const source = await h.merchant(10);
    const dispatch = await send(source, '2026-11-03T12:00:00Z');
    // A disposable historical fixture: these columns did not exist when the
    // accepted consumption row was originally written. Production stays immutable.
    await h.client.unsafe(
      'ALTER TABLE verification_message_dispatches DISABLE TRIGGER dispatch_billing_immutable',
    );
    try {
      await h.db
        .update(verificationMessageDispatches)
        .set({ billingPool: null, billingCost: null })
        .where(eq(verificationMessageDispatches.id, dispatch.id));
    } finally {
      await h.client.unsafe(
        'ALTER TABLE verification_message_dispatches ENABLE TRIGGER dispatch_billing_immutable',
      );
    }
    expect((await completeUsage(source.orgId, 'UTC', asOf)).usedThisMonth).toBe(
      2,
    );
    await h.dispatches.recordProviderStatus(
      dispatch.id,
      'failed',
      new Date().toISOString(),
    );
    expect((await completeUsage(source.orgId, 'UTC', asOf)).usedThisMonth).toBe(
      0,
    );
  });

  it('uses partial and zero fallback costs and excludes billing-exempt traffic', async () => {
    const source = await h.merchant(10);
    for (const [cost, exempt] of [
      [1, false],
      [0, false],
      [2, true],
    ] as const) {
      const input = await h.verification(source);
      await h.db.insert(verificationMessageDispatches).values({
        orgId: source.orgId,
        integrationId: source.integrationId,
        verificationId: input.verificationId,
        dispatchKey: randomUUID(),
        kind: 'initial',
        accountingMode: 'prepaid_credit',
        state: 'accepted',
        senderKind: 'akeed_system',
        senderReason: 'outcome_unknown',
        billingPool: 'credits',
        billingCost: cost,
        acceptedAt: '2026-11-03T12:00:00Z',
        metadata: { billingExempt: exempt },
      });
    }
    expect(await completeUsage(source.orgId, 'UTC', asOf)).toMatchObject({
      usedThisMonth: 1,
      bySender: { akeed: 1, ownNumber: 0 },
    });
  });

  it('withholds totals when a legacy accepted send has no linked billing history', async () => {
    const source = await h.merchant(10);
    const input = await h.verification(source);
    await h.db.insert(verificationMessageDispatches).values({
      orgId: source.orgId,
      integrationId: source.integrationId,
      verificationId: input.verificationId,
      dispatchKey: randomUUID(),
      kind: 'initial',
      accountingMode: 'prepaid_credit',
      state: 'accepted',
      acceptedAt: '2026-11-03T12:00:00Z',
    });
    expect(await usage.read(source.orgId, 'UTC', asOf)).toBeNull();
    // Missing evidence for one tenant cannot make another tenant unavailable.
    expect((await completeUsage(randomUUID(), 'UTC', asOf)).usedThisMonth).toBe(
      0,
    );
  });

  it('reads admin pools and spare credits from persisted accounting, independently of the sender', async () => {
    const prepaid = await h.merchant(1);
    await send(prepaid, '2026-11-03T12:00:00Z', true);
    const shopify = await h.merchant(0, 'shopify');
    await send(shopify, '2026-11-03T12:00:00Z', true);
    const page = await new AdminQueryRepository(h.db as never).findStorePage(
      {},
      { limit: 100, sort: 'installed_at', direction: 'desc' },
      {
        lowBalanceThreshold: 10,
        planLimits: { starter: 30 },
        healthSignals: () => ({
          critical: sql`ARRAY[]::text[]`,
          attention: sql`ARRAY[]::text[]`,
        }),
      },
    );
    expect(page.rows.find((row) => row.org_id === prepaid.orgId)).toMatchObject(
      {
        credit_spare: 1,
        credit_available: 0,
        credit_balance_state: 'low',
        last_sender_kind: 'merchant_own',
        whatsapp_state: 'active',
      },
    );
    expect(page.rows.find((row) => row.org_id === shopify.orgId)).toMatchObject(
      { usage_used: 0, own_number_used: 1 },
    );
  });
});
