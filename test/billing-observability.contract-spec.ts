import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  billingReconciliationAttempts,
  billingReconciliationFindings,
  billingReconciliationRuns,
  billingSettlementReports,
} from '../src/infrastructure/database/schema';
import { paymobBillingHarness } from './contracts/paymob-billing-harness';

const harness = paymobBillingHarness();
const { db } = harness;

describe('US-04.5-07 PostgreSQL billing observability foundation', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);

  it('keeps settlement evidence append-only and corrections explicit', async () => {
    const actorId = randomUUID();
    const [original] = await db
      .insert(billingSettlementReports)
      .values({
        providerReportId: 'paymob-settlement-2026-09-10',
        periodStart: '2026-09-09T00:00:00.000Z',
        periodEnd: '2026-09-10T00:00:00.000Z',
        settledAt: '2026-09-10T08:00:00.000Z',
        currency: 'EGP',
        transactionCount: 1,
        grossMinor: 20_000,
        refundedMinor: 0,
        chargebackMinor: 0,
        feeMinor: 500,
        vatMinor: 70,
        netMinor: 19_430,
        actorId,
        idempotencyKey: randomUUID(),
        evidence: 'Finance ticket FIN-100',
        reason: 'Record the provider settlement totals',
      })
      .returning();

    await expect(
      db
        .update(billingSettlementReports)
        .set({ feeMinor: 600 })
        .where(eq(billingSettlementReports.id, original.id)),
    ).rejects.toThrow();

    const [correction] = await db
      .insert(billingSettlementReports)
      .values({
        providerReportId: original.providerReportId,
        revision: 2,
        supersedesId: original.id,
        periodStart: original.periodStart,
        periodEnd: original.periodEnd,
        settledAt: original.settledAt,
        currency: original.currency,
        transactionCount: original.transactionCount,
        grossMinor: original.grossMinor,
        refundedMinor: original.refundedMinor,
        chargebackMinor: original.chargebackMinor,
        feeMinor: 600,
        vatMinor: original.vatMinor,
        netMinor: 19_330,
        actorId,
        idempotencyKey: randomUUID(),
        evidence: 'Corrected finance ticket FIN-101',
        reason: 'Correct the fee copied from the report',
      })
      .returning();

    expect(correction).toMatchObject({
      revision: 2,
      supersedesId: original.id,
    });
  });

  it('deduplicates runs, attempts and findings at the database boundary', async () => {
    const runKey = `manual:${randomUUID()}`;
    const [run] = await db
      .insert(billingReconciliationRuns)
      .values({
        runKey,
        trigger: 'manual',
        mode: 'report_only',
        triggeredBy: randomUUID(),
        reason: 'Contract verification',
      })
      .returning();

    await expect(
      db.insert(billingReconciliationRuns).values({
        runKey,
        trigger: 'manual',
        mode: 'report_only',
      }),
    ).rejects.toThrow();

    const targetKey = `account:${randomUUID()}`;
    await db.insert(billingReconciliationAttempts).values({
      runId: run.id,
      targetKind: 'account_invariant',
      targetKey,
      outcome: 'consistent',
    });
    await expect(
      db.insert(billingReconciliationAttempts).values({
        runId: run.id,
        targetKind: 'account_invariant',
        targetKey,
        outcome: 'consistent',
      }),
    ).rejects.toThrow();

    const fingerprint = 'a'.repeat(64);
    await db.insert(billingReconciliationFindings).values({
      fingerprint,
      code: 'projection_mismatch',
      severity: 'critical',
      nextAction: 'repair_projection',
      lastRunId: run.id,
    });
    await expect(
      db.insert(billingReconciliationFindings).values({
        fingerprint,
        code: 'projection_mismatch',
        severity: 'critical',
        nextAction: 'repair_projection',
      }),
    ).rejects.toThrow();
  });
});
