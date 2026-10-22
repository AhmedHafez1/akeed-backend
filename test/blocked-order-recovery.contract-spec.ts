/* eslint-disable @typescript-eslint/require-await -- the in-memory fakes keep the async signatures of the repositories they replace. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { CapacityRecoveryService } from '../src/modules/capacity-recovery/capacity-recovery.service';
import { UsageAlertsRepository } from '../src/infrastructure/database/repositories/usage-alerts.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import {
  integrations,
  orders,
  verificationMessageDispatches,
  verifications,
} from '../src/infrastructure/database/schema';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../src/shared/config/usage-alerts.config';
import { CAPACITY_BLOCK_REASONS } from '../src/shared/verification/capacity-block';

const harness = creditUsageHarness();
const { client, db, credits, dispatches, merchant, verification, balance } =
  harness;
const verificationsRepo = new VerificationsRepository(db as never);
const alerts = new UsageAlertsRepository(db as never);

const HOUR = 3_600_000;

/** 0073 without its enum statement: the scaffold already has 'blocked'. */
async function applyUsageAlertsMigration() {
  for (const statement of readFileSync(
    resolve(__dirname, '../drizzle/0073_usage_alerts_and_blocked_orders.sql'),
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (statement.trim() && !statement.includes('pg_enum'))
      await client.unsafe(statement);
  }
}

type Source = Awaited<ReturnType<typeof merchant>>;

async function orderAt(
  source: Source,
  status: 'blocked' | 'failed' | 'sent',
  options: {
    reason?: string;
    hoursOld?: number;
    lastSentAt?: string | null;
    isTest?: boolean;
  } = {},
) {
  const input = await verification(source);
  const createdAt = new Date(
    Date.now() - (options.hoursOld ?? 1) * HOUR,
  ).toISOString();
  await db
    .update(verifications)
    .set({
      status,
      createdAt,
      lastSentAt: options.lastSentAt ?? null,
      metadata: {
        reason: options.reason ?? 'INSUFFICIENT_CREDITS',
        kind: 'initial',
      },
    })
    .where(eq(verifications.id, input.verificationId));
  const [row] = await db
    .select({ orderId: verifications.orderId })
    .from(verifications)
    .where(eq(verifications.id, input.verificationId));
  await db
    .update(orders)
    .set({ createdAt, isTest: options.isTest ?? false })
    .where(eq(orders.id, row.orderId));
  return input;
}

async function statusOf(verificationId: string) {
  const [row] = await db
    .select({ status: verifications.status, metadata: verifications.metadata })
    .from(verifications)
    .where(eq(verifications.id, verificationId));
  return row;
}

/**
 * Recovery over the real repository and ledger. The send path is reduced to
 * what decides duplicates and charges: the dispatch ledger's claim, then the
 * status the hub would project.
 */
async function recoveryFor(
  source: Source,
  options: { failFirstHandoff?: boolean } = {},
) {
  let failed = false;
  const [record] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, source.integrationId));
  const sendable = {
    ...record,
    isAutoVerifyEnabled: true,
    onboardingStatus: 'completed',
  };
  const claims: string[] = [];
  const hub = {
    resumeInitialSend: async (verificationId: string) => {
      // An enqueue that throws after the reopen committed.
      if (options.failFirstHandoff && !failed) {
        failed = true;
        throw new Error('enqueue failed');
      }
      const result = await dispatches.claim({
        ...source,
        verificationId,
        kind: 'initial',
        templateName: 'cod_verification',
        languageCode: 'en',
        leaseUntil: new Date(Date.now() + 600_000).toISOString(),
      });
      if (result.outcome === 'claimed') {
        claims.push(verificationId);
        await db
          .update(verifications)
          .set({ status: 'sent', lastSentAt: new Date().toISOString() })
          .where(eq(verifications.id, verificationId));
        return;
      }
      await db
        .update(verifications)
        .set({
          status: 'blocked',
          metadata: { reason: 'INSUFFICIENT_CREDITS', kind: 'initial' },
        })
        .where(eq(verifications.id, verificationId));
    },
  };
  const entitlements = {
    evaluateAccess: () => ({ reason: null }),
    hasAvailableSlot: async () => {
      const summary = await credits.getSummary(source.orgId);
      return (summary?.availableCredits ?? 0) >= 1
        ? { available: true, reason: null }
        : { available: false, reason: 'INSUFFICIENT_CREDITS' };
    },
  };
  const settings = parseUsageAlertsConfig({});
  const service = new CapacityRecoveryService(
    verificationsRepo,
    { findActiveByOrg: async () => [sendable] } as never,
    entitlements as never,
    hub as never,
    { evaluateOrg: async () => undefined } as never,
    {
      get: (key: string) =>
        key === USAGE_ALERTS_CONFIG ? settings : undefined,
    } as never,
  );
  return { service, claims };
}

/** Reopens a blocked order as recovery does, handed over `minutesAgo`. */
async function reopenedAt(
  input: { verificationId: string; orgId: string },
  minutesAgo: number,
) {
  expect(
    await verificationsRepo.reopenRetryableInitialFailure(
      input.verificationId,
      input.orgId,
      { capacityResume: true },
    ),
  ).toBe(true);
  const resumedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await db
    .update(verifications)
    .set({
      metadata: sql`${verifications.metadata} || jsonb_build_object('capacity_resumed_at', ${resumedAt}::text)`,
    })
    .where(eq(verifications.id, input.verificationId));
}

const strandedBefore = () => new Date(Date.now() - 15 * 60_000).toISOString();

describe('PostgreSQL blocked-order recovery', () => {
  beforeAll(async () => {
    await harness.setup();
    await applyUsageAlertsMigration();
  });
  afterAll(harness.teardown);

  it('lists blocked and recent unsent capacity failures, oldest first', async () => {
    const source = await merchant(5);
    const older = await orderAt(source, 'blocked', { hoursOld: 6 });
    const legacy = await orderAt(source, 'failed', {
      reason: 'plan_limit_reached',
      hoursOld: 3,
    });
    const newer = await orderAt(source, 'blocked', { hoursOld: 1 });
    // Never candidates: a test order, a legacy failure past the cutoff, one
    // that reached the provider, and one that failed for another reason.
    await orderAt(source, 'blocked', { isTest: true });
    await orderAt(source, 'failed', { hoursOld: 30 });
    await orderAt(source, 'failed', { lastSentAt: new Date().toISOString() });
    await orderAt(source, 'failed', { reason: 'provider_not_accepted' });
    await orderAt(await merchant(5), 'blocked');

    const candidates = await verificationsRepo.listCapacityRecoveryCandidates({
      orgId: source.orgId,
      reasons: CAPACITY_BLOCK_REASONS,
      legacyFailedSince: new Date(Date.now() - 24 * HOUR).toISOString(),
      limit: 50,
    });

    expect(candidates.map((row) => row.verificationId)).toEqual([
      older.verificationId,
      legacy.verificationId,
      newer.verificationId,
    ]);
    expect(candidates[1]).toMatchObject({
      reason: 'plan_limit_reached',
      integrationId: source.integrationId,
    });
    expect(await verificationsRepo.countBlocked(source.orgId)).toBe(2);
    expect(await verificationsRepo.listOrgsWithBlocked(500)).toContain(
      source.orgId,
    );
  });

  it('sends each order once and holds one credit when two runs overlap', async () => {
    const source = await merchant(1);
    const blocked = [
      await orderAt(source, 'blocked', { hoursOld: 3 }),
      await orderAt(source, 'blocked', { hoursOld: 2 }),
      await orderAt(source, 'blocked', { hoursOld: 1 }),
    ];
    const first = await recoveryFor(source);
    const second = await recoveryFor(source);

    await Promise.all([
      first.service.recover(source.orgId),
      second.service.recover(source.orgId),
    ]);

    const claimed = [...first.claims, ...second.claims];
    expect(claimed).toHaveLength(1);
    await balance(source.orgId, 1, 1);
    const statuses = await Promise.all(
      blocked.map(
        async (input) => (await statusOf(input.verificationId)).status,
      ),
    );
    expect(statuses.filter((status) => status === 'sent')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'blocked')).toHaveLength(2);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.verificationId, claimed[0]),
          eq(verificationMessageDispatches.kind, 'initial'),
        ),
      );
    expect(count).toBe(1);
  });

  it('resumes the rest after a recharge without resending the first', async () => {
    const source = await merchant(1);
    const blocked = [
      await orderAt(source, 'blocked', { hoursOld: 2 }),
      await orderAt(source, 'blocked', { hoursOld: 1 }),
    ];
    const run = await recoveryFor(source);
    await run.service.recover(source.orgId);
    expect(run.claims).toEqual([blocked[0].verificationId]);

    await harness.adjust(source.orgId, 5);
    await run.service.recover(source.orgId);

    expect(run.claims).toEqual(blocked.map((input) => input.verificationId));
    await balance(source.orgId, 6, 2);
  });

  it('moves a stale order to the merchant and never sends it', async () => {
    const source = await merchant(5);
    const stale = await orderAt(source, 'blocked', { hoursOld: 30 });
    const run = await recoveryFor(source);

    await expect(run.service.recover(source.orgId)).resolves.toMatchObject({
      stale: 1,
      resumed: 0,
    });

    expect(run.claims).toEqual([]);
    expect(await statusOf(stale.verificationId)).toMatchObject({
      status: 'failed',
      metadata: expect.objectContaining({
        reason: 'capacity_block_stale',
        blocked_reason: 'INSUFFICIENT_CREDITS',
      }) as Record<string, unknown>,
    });
    // The merchant can still retry it.
    expect(
      await verificationsRepo.reopenRetryableInitialFailure(
        stale.verificationId,
        source.orgId,
      ),
    ).toBe(true);
    await balance(source.orgId, 5, 0);
  });

  it('never marks a sent order as stale', async () => {
    const source = await merchant(5);
    const sent = await orderAt(source, 'sent', {
      lastSentAt: new Date().toISOString(),
    });

    expect(
      await verificationsRepo.markCapacityBlockUnsent({
        verificationId: sent.verificationId,
        orgId: source.orgId,
        reason: 'capacity_block_stale',
        blockedReason: null,
      }),
    ).toBe(false);
    expect((await statusOf(sent.verificationId)).status).toBe('sent');
  });

  it('records each plan level once per period under concurrent evaluation', async () => {
    const source = await merchant(5, 'shopify');
    const claim = (cycleKey: string) =>
      alerts.claim({
        orgId: source.orgId,
        integrationId: source.integrationId,
        kind: 'plan_usage',
        level: '80',
        cycleKey,
      });

    const ids = await Promise.all(
      Array.from({ length: 6 }, () => claim('2026-10-01')),
    );

    expect(ids.filter(Boolean)).toHaveLength(1);
    expect(await claim('2026-10-31')).not.toBeNull();
  });

  it('opens one credit incident at a time and a new one after recovery', async () => {
    const source = await merchant(5);
    const claim = () =>
      alerts.claim({
        orgId: source.orgId,
        integrationId: source.integrationId,
        kind: 'credit_balance',
        level: 'low',
        cycleKey: 'incident',
      });

    const ids = await Promise.all(Array.from({ length: 6 }, claim));
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect(await claim()).toBeNull();

    expect(await alerts.resolveOpenCreditAlerts(source.orgId, ['low'])).toBe(1);
    expect(await claim()).not.toBeNull();
  });
  it('blocks again a handoff that never reached the send path', async () => {
    const source = await merchant(5);
    const stranded = await orderAt(source, 'blocked');
    await reopenedAt(stranded, 20);
    expect((await statusOf(stranded.verificationId)).metadata).toMatchObject({
      blocked_reason: 'INSUFFICIENT_CREDITS',
    });
    expect(
      await verificationsRepo.listOrgsWithBlocked(500, strandedBefore()),
    ).toContain(source.orgId);

    expect(
      await verificationsRepo.returnStrandedCapacityResumes({
        orgId: source.orgId,
        olderThan: strandedBefore(),
      }),
    ).toBe(1);

    const row = await statusOf(stranded.verificationId);
    expect(row.status).toBe('blocked');
    expect(row.metadata).toMatchObject({
      reason: 'INSUFFICIENT_CREDITS',
      kind: 'initial',
    });
    expect(row.metadata).not.toHaveProperty('capacity_resumed_at');
  });

  it('leaves a recent, dispatched or scheduled handoff alone', async () => {
    const source = await merchant(5);
    const recent = await orderAt(source, 'blocked');
    await reopenedAt(recent, 2);
    const dispatched = await orderAt(source, 'blocked');
    await reopenedAt(dispatched, 20);
    const claim = await dispatches.claim({
      ...source,
      verificationId: dispatched.verificationId,
      kind: 'initial',
      templateName: 'cod_verification',
      languageCode: 'en',
      leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(claim.outcome).toBe('claimed');
    const scheduled = await orderAt(source, 'blocked');
    await reopenedAt(scheduled, 20);
    await db
      .update(verifications)
      .set({ nextRetryAt: new Date(Date.now() + 3_600_000).toISOString() })
      .where(eq(verifications.id, scheduled.verificationId));
    // A merchant retry is not a capacity handoff.
    const retried = await orderAt(source, 'blocked');
    await verificationsRepo.reopenRetryableInitialFailure(
      retried.verificationId,
      source.orgId,
    );

    expect(
      await verificationsRepo.returnStrandedCapacityResumes({
        orgId: source.orgId,
        olderThan: strandedBefore(),
      }),
    ).toBe(0);
    for (const input of [recent, dispatched, scheduled, retried]) {
      expect((await statusOf(input.verificationId)).status).toBe('pending');
    }
  });

  it('sends an interrupted handoff exactly once on the next run', async () => {
    const source = await merchant(5);
    const blocked = await orderAt(source, 'blocked');
    const run = await recoveryFor(source, { failFirstHandoff: true });

    await expect(run.service.recover(source.orgId)).rejects.toThrow(
      'enqueue failed',
    );
    expect((await statusOf(blocked.verificationId)).status).toBe('blocked');

    await run.service.recover(source.orgId);
    await run.service.recover(source.orgId);

    expect(run.claims).toEqual([blocked.verificationId]);
    await balance(source.orgId, 5, 1);
  });

  it('pages candidates past a cursor', async () => {
    const source = await merchant(5);
    const rows = [
      await orderAt(source, 'blocked', { hoursOld: 3 }),
      await orderAt(source, 'blocked', { hoursOld: 2 }),
      await orderAt(source, 'blocked', { hoursOld: 1 }),
    ];
    const page = (after?: { createdAt: string; id: string }) =>
      verificationsRepo.listCapacityRecoveryCandidates({
        orgId: source.orgId,
        reasons: CAPACITY_BLOCK_REASONS,
        legacyFailedSince: new Date(Date.now() - 24 * HOUR).toISOString(),
        limit: 2,
        ...(after ? { after } : {}),
      });

    const first = await page();
    const last = first[first.length - 1];
    const second = await page({
      createdAt: last.createdAt!,
      id: last.verificationId,
    });

    expect([...first, ...second].map((row) => row.verificationId)).toEqual(
      rows.map((row) => row.verificationId),
    );
  });
});
