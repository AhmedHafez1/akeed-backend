import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  billingReconciliationAttempts,
  billingReconciliationFindings,
  billingReconciliationRuns,
  billingSettlementReports,
  creditAccounts,
  paymentProviderEvents,
  paymentPurchases,
  verificationMessageDispatches,
} from '../src/infrastructure/database/schema';
import {
  billingOperationsHarness,
  OPERATOR,
} from './contracts/billing-operations-harness';
import { BillingObservabilityRepository } from '../src/modules/admin/billing-observability.repository';
import { BillingObservabilityService } from '../src/modules/admin/billing-observability.service';
import type { SettlementInput } from '../src/modules/admin/billing-observability.types';
import type { PaymentInquiryResult } from '../src/shared/ports/payments.port';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';

/**
 * US-04.5-07 against real PostgreSQL with migration 0034 applied.
 *
 * Reconciliation is only as retry-safe as the unique keys and foreign keys
 * underneath it, and the metrics are only honest if they are computed from
 * the immutable purchase and ledger rows, so both halves run against the real
 * schema rather than a mocked repository.
 */
type Harness = ReturnType<typeof billingOperationsHarness>;

const PAYMOB_ENVIRONMENT = {
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: 'sandbox-hmac',
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
};

/** What the fake provider says about every reference a case did not script. */
const NOT_FOUND: PaymentInquiryResult = {
  outcome: 'not_found',
  code: 'not_found',
};

function observability(harness: Harness, environment = {}) {
  const repository = new BillingObservabilityRepository(harness.db);
  const producer = {
    enqueue: jest.fn().mockResolvedValue({
      id: randomUUID(),
      status: 'queued',
      mode: 'local_only',
    }),
    mode: () => 'local_only',
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new BillingObservabilityService(
    repository,
    harness.operationsRepository,
    harness.reconciliation,
    producer as never,
    audit as never,
    standaloneCreditBillingConfigService({
      ...PAYMOB_ENVIRONMENT,
      ...environment,
    }),
  );
  return { repository, producer, audit, service };
}

type Observability = ReturnType<typeof observability>;

async function scan(target: Observability, settlementId?: string) {
  const run = await target.repository.createRun({
    runKey: `${settlementId ? 'settlement' : 'manual'}:${randomUUID()}`,
    trigger: settlementId ? 'settlement' : 'manual',
    mode: 'local_only',
    settlementId,
  });
  await target.service.processRun(run.id);
  return target.repository.run(run.id);
}

async function openFindings(target: Observability, orgId: string) {
  return target.repository.openFindingsForOrganization(orgId);
}

async function codes(target: Observability, orgId: string) {
  return (await openFindings(target, orgId)).map((row) => row.code).sort();
}

/** Each settlement gets its own provider transaction, as in production. */
function settle(harness: Harness, reference: string) {
  return harness.callbacks.ingest(
    harness.paymob.event(reference, {
      payment: { providerTransactionId: `txn-${randomUUID()}` },
    }),
  );
}

async function purchase(
  harness: Harness,
  merchant: Awaited<ReturnType<Harness['merchant']>>,
) {
  const created = await harness.billing.createPurchase(
    merchant.user,
    `key-${randomUUID()}`,
    100,
  );
  return created.reference;
}

async function settledPurchase(
  harness: Harness,
  merchant: Awaited<ReturnType<Harness['merchant']>>,
) {
  const reference = await purchase(harness, merchant);
  await settle(harness, reference);
  return reference;
}

/** A pending purchase whose checkout window closed two hours ago. */
async function stalePurchase(
  harness: Harness,
  merchant: Awaited<ReturnType<Harness['merchant']>>,
) {
  const reference = await purchase(harness, merchant);
  await harness.db
    .update(paymentPurchases)
    .set({
      checkoutExpiresAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    })
    .where(eq(paymentPurchases.reference, reference));
  return reference;
}

async function staffAdjust(harness: Harness, orgId: string, quantity: number) {
  await harness.db.transaction((tx) =>
    harness.credits.postLedgerEntry(tx, {
      orgId,
      type: 'staff_adjustment',
      quantity,
      idempotencyKey: `fixture:${randomUUID()}`,
      actorId: randomUUID(),
      reason: 'Synthetic fixture',
    }),
  );
}

/** The database clock, to the millisecond, so windows match row timestamps. */
async function databaseNow(harness: Harness, offsetMs = 0) {
  const [row] = await harness.db.execute<{ ms: string }>(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`,
  );
  return new Date(Number(row.ms) + offsetMs).toISOString();
}

describe('US-04.5-07 PostgreSQL billing reconciliation', () => {
  const harness = billingOperationsHarness();
  const { db } = harness;
  let local: Observability;
  let operations: Harness['operationsRepository'];

  beforeAll(async () => {
    await harness.setup();
    local = observability(harness, {
      STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED: 'false',
    });
    operations = harness.operationsRepository;
  });
  afterAll(harness.teardown);
  afterEach(() => jest.restoreAllMocks());

  describe('durable evidence', () => {
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
      await expect(
        db
          .delete(billingSettlementReports)
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
      // One correction per row: a fork in the chain is refused.
      await expect(
        db.insert(billingSettlementReports).values({
          ...correction,
          id: undefined,
          revision: 3,
          supersedesId: original.id,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
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

    it('refuses unknown attempt kinds, settlement runs without a report, and cross-tenant references', async () => {
      const run = await local.repository.createRun({
        runKey: `manual:${randomUUID()}`,
        trigger: 'manual',
        mode: 'local_only',
      });
      await expect(
        db.insert(billingReconciliationAttempts).values({
          runId: run.id,
          targetKind: 'arbitrary_target',
          targetKey: 'x',
          outcome: 'consistent',
        }),
      ).rejects.toThrow();
      await expect(
        db.insert(billingReconciliationRuns).values({
          runKey: `settlement:${randomUUID()}`,
          trigger: 'settlement',
          mode: 'local_only',
        }),
      ).rejects.toThrow();

      const owner = await harness.merchant(0);
      const other = await harness.merchant(0);
      const reference = await purchase(harness, owner);
      const row = await harness.purchaseRow(reference);
      await expect(
        db.insert(billingReconciliationFindings).values({
          fingerprint: 'b'.repeat(64),
          code: 'stale_pending',
          severity: 'attention',
          nextAction: 'retry_provider_inquiry',
          orgId: other.orgId,
          purchaseId: row.id,
        }),
      ).rejects.toThrow();
      await expect(
        db.insert(billingReconciliationAttempts).values({
          runId: run.id,
          orgId: other.orgId,
          purchaseId: row.id,
          targetKind: 'provider_inquiry',
          targetKey: reference,
          outcome: 'resolved',
        }),
      ).rejects.toThrow();
      await expect(
        db.insert(billingReconciliationFindings).values({
          fingerprint: 'c'.repeat(64),
          code: 'stale_pending',
          severity: 'attention',
          nextAction: 'retry_provider_inquiry',
          purchaseId: row.id,
        }),
      ).rejects.toThrow();
    });

    it('scopes an account view to its own findings', async () => {
      const first = await harness.merchant(30);
      const second = await harness.merchant(30);
      await harness.driftProjection(first.orgId, 3);
      await scan(local);
      expect(await codes(local, first.orgId)).toEqual(['projection_mismatch']);
      expect(await codes(local, second.orgId)).toEqual([]);
      await harness.driftProjection(first.orgId, -3);
    });

    it('retains open findings and evidence and prunes only expired history', async () => {
      const merchant = await harness.merchant(0);
      const old = new Date(Date.now() - 181 * 86_400_000).toISOString();
      const ancient = new Date(Date.now() - 366 * 86_400_000).toISOString();
      const [expired] = await db
        .insert(billingReconciliationRuns)
        .values({
          runKey: `manual:${randomUUID()}`,
          trigger: 'manual',
          mode: 'local_only',
          status: 'completed',
          completedAt: old,
        })
        .returning();
      await db.insert(billingReconciliationAttempts).values({
        runId: expired.id,
        targetKind: 'account_invariant',
        targetKey: merchant.orgId,
        outcome: 'consistent',
        attemptedAt: old,
      });
      const recent = await local.repository.createRun({
        runKey: `manual:${randomUUID()}`,
        trigger: 'manual',
        mode: 'local_only',
      });
      await local.repository.recordAttempt({
        runId: recent.id,
        targetKind: 'account_invariant',
        targetKey: merchant.orgId,
        outcome: 'consistent',
        durationMs: 0,
      });
      const finding = (code: string, status: 'open' | 'resolved') => ({
        fingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        code,
        severity: 'attention' as const,
        nextAction: 'resolve_debt',
        orgId: merchant.orgId,
        status,
        firstSeenAt: ancient,
        resolvedAt: status === 'resolved' ? ancient : null,
      });
      const [resolvedOld] = await db
        .insert(billingReconciliationFindings)
        .values(finding('credit_debt', 'resolved'))
        .returning();
      const [openOld] = await db
        .insert(billingReconciliationFindings)
        .values(finding('credit_debt', 'open'))
        .returning();
      const settlements = await db.select().from(billingSettlementReports);

      await local.repository.cleanup();

      expect(await local.repository.run(expired.id)).toBeUndefined();
      expect(
        await local.repository.hasAttempt(
          recent.id,
          'account_invariant',
          merchant.orgId,
        ),
      ).toBe(true);
      const remaining = await db
        .select({ id: billingReconciliationFindings.id })
        .from(billingReconciliationFindings)
        .where(eq(billingReconciliationFindings.orgId, merchant.orgId));
      expect(remaining.map((row) => row.id)).toEqual([openOld.id]);
      expect(remaining.map((row) => row.id)).not.toContain(resolvedOld.id);
      expect(await db.select().from(billingSettlementReports)).toHaveLength(
        settlements.length,
      );
      await db
        .update(billingReconciliationFindings)
        .set({ status: 'resolved', resolvedAt: new Date().toISOString() })
        .where(eq(billingReconciliationFindings.id, openOld.id));
    });
  });

  describe('runs', () => {
    it('returns one run for a repeated key and completes it once', async () => {
      const runKey = `settlement-less:${randomUUID()}`;
      const first = await local.repository.createRun({
        runKey,
        trigger: 'manual',
        mode: 'local_only',
      });
      const again = await local.repository.createRun({
        runKey,
        trigger: 'manual',
        mode: 'local_only',
      });
      expect(again.id).toBe(first.id);

      await local.service.processRun(first.id);
      const read = jest.spyOn(operations, 'readReconciliation');
      await local.service.processRun(first.id);
      expect(read).not.toHaveBeenCalled();
      expect(await local.repository.run(first.id)).toMatchObject({
        status: 'completed',
      });
    });

    it('opens, resolves and reopens a finding only on complete scans', async () => {
      const merchant = await harness.merchant(30);
      await harness.driftProjection(merchant.orgId, 1);
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([
        expect.objectContaining({
          code: 'projection_mismatch',
          severity: 'critical',
          nextAction: 'repair_projection',
        }),
      ]);

      await harness.driftProjection(merchant.orgId, -1);
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([]);

      await harness.driftProjection(merchant.orgId, 2);
      await scan(local);
      const [reopened] = await openFindings(local, merchant.orgId);
      expect(reopened).toMatchObject({
        code: 'projection_mismatch',
        status: 'open',
        resolvedAt: null,
      });
      expect(reopened.occurrenceCount).toBeGreaterThan(1);
      await harness.driftProjection(merchant.orgId, -2);
      await scan(local);
    });

    it('never resolves unseen findings when a scan fails part-way', async () => {
      const merchant = await harness.merchant(30);
      await harness.driftProjection(merchant.orgId, 4);
      await scan(local);
      await harness.driftProjection(merchant.orgId, -4);

      const failing = await local.repository.createRun({
        runKey: `manual:${randomUUID()}`,
        trigger: 'manual',
        mode: 'local_only',
      });
      jest
        .spyOn(operations, 'readReconciliation')
        .mockRejectedValueOnce(new Error('database unavailable'));
      await expect(local.service.processRun(failing.id)).rejects.toThrow(
        'database unavailable',
      );
      expect(await local.repository.run(failing.id)).toMatchObject({
        status: 'failed',
      });
      expect(await codes(local, merchant.orgId)).toEqual([
        'projection_mismatch',
      ]);

      // The retry of the same run completes it, and only then resolves.
      await local.service.processRun(failing.id);
      expect(await local.repository.run(failing.id)).toMatchObject({
        status: 'completed',
      });
      expect(await codes(local, merchant.orgId)).toEqual([]);
    });

    it('resumes a failed run without repeating a completed target', async () => {
      const merchant = await harness.merchant(30);
      const run = await local.repository.createRun({
        runKey: `manual:${randomUUID()}`,
        trigger: 'manual',
        mode: 'local_only',
      });
      await local.repository.recordAttempt({
        runId: run.id,
        orgId: merchant.orgId,
        targetKind: 'account_invariant',
        targetKey: merchant.orgId,
        outcome: 'consistent',
        durationMs: 1,
      });
      await db
        .update(billingReconciliationRuns)
        .set({ status: 'failed' })
        .where(eq(billingReconciliationRuns.id, run.id));
      const read = jest.spyOn(operations, 'readReconciliation');

      await local.service.processRun(run.id);

      expect(read.mock.calls.map(([orgId]) => orgId)).not.toContain(
        merchant.orgId,
      );
      expect(await local.repository.run(run.id)).toMatchObject({
        status: 'completed',
      });
    });

    it('continues a run whose worker stalled while running', async () => {
      const merchant = await harness.merchant(30);
      const run = await local.repository.createRun({
        runKey: `manual:${randomUUID()}`,
        trigger: 'manual',
        mode: 'local_only',
      });
      await db
        .update(billingReconciliationRuns)
        .set({ status: 'running' })
        .where(eq(billingReconciliationRuns.id, run.id));
      await local.service.processRun(run.id);
      expect(await local.repository.run(run.id)).toMatchObject({
        status: 'completed',
      });
      expect(
        await local.repository.hasAttempt(
          run.id,
          'account_invariant',
          merchant.orgId,
        ),
      ).toBe(true);
    });

    it('pages accounts and purchases in keyset batches without skipping any', async () => {
      const paged = observability(harness, {
        STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED: 'false',
        STANDALONE_BILLING_RECONCILIATION_BATCH_SIZE: '2',
      });
      const merchants = await Promise.all(
        [1, 2, 3, 4, 5].map(() => harness.merchant(10)),
      );
      const references: string[] = [];
      for (const merchant of merchants.slice(0, 3))
        references.push(await stalePurchase(harness, merchant));
      const pages = jest.spyOn(paged.repository, 'organizationIds');
      const candidates = jest.spyOn(paged.repository, 'candidates');

      const run = await scan(paged);

      expect(pages.mock.calls.length).toBeGreaterThan(2);
      expect(candidates.mock.calls.length).toBeGreaterThan(1);
      for (const merchant of merchants)
        expect(
          await paged.repository.hasAttempt(
            run.id,
            'account_invariant',
            merchant.orgId,
          ),
        ).toBe(true);
      for (const reference of references)
        expect(
          await paged.repository.hasAttempt(run.id, 'purchase_scan', reference),
        ).toBe(true);
    });

    it('pages the staff queue by last seen without repeats', async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await local.repository.listFindings({ limit: 2, cursor });
        for (const row of page.rows) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
        }
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      const all = await db
        .select({ id: billingReconciliationFindings.id })
        .from(billingReconciliationFindings);
      expect(seen.size).toBe(all.length);
      expect(pages).toBeGreaterThan(1);
    });
  });

  describe('local detectors', () => {
    it('flags a stale pending purchase with the action the configuration allows', async () => {
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      const inquire = jest.spyOn(harness.paymob, 'inquire');
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([
        expect.objectContaining({
          code: 'stale_pending',
          nextAction: 'enable_scheduled_inquiry',
          safeContext: { reference },
        }),
      ]);
      // The inquiry switch is off: nothing was asked of Paymob.
      expect(inquire).not.toHaveBeenCalled();
    });

    it('flags debt, refunds and chargebacks for finance follow-up', async () => {
      const merchant = await harness.merchant(0);
      const refunded = await settledPurchase(harness, merchant);
      const disputed = await settledPurchase(harness, merchant);
      const action = (
        reference: string,
        kind: 'refund' | 'chargeback_open',
        providerReference: string,
      ) =>
        harness.operations.recordProviderAction({
          userId: OPERATOR,
          orgId: merchant.orgId,
          reference,
          action: kind,
          providerReference,
          amountMinor: 20_000,
          currency: 'EGP',
          evidence: 'Paymob dashboard transaction',
          reason: 'Finance confirmed with Paymob',
          requestId: 'req-observability',
        });
      await staffAdjust(harness, merchant.orgId, -150);
      await action(refunded, 'refund', `rf-${randomUUID()}`);
      await action(disputed, 'chargeback_open', `cb-${randomUUID()}`);

      await scan(local);

      const findings = await openFindings(local, merchant.orgId);
      expect(findings.map((row) => row.code).sort()).toEqual([
        'chargeback_state',
        'credit_debt',
        'refund_state',
      ]);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'credit_debt',
            nextAction: 'resolve_debt',
          }),
          expect.objectContaining({
            code: 'refund_state',
            nextAction: 'review_refund_dispute',
          }),
        ]),
      );
    });

    it('flags a quarantined callback whose trusted facts do not match', async () => {
      const merchant = await harness.merchant(0);
      const reference = await purchase(harness, merchant);
      await harness.callbacks.ingest(
        harness.paymob.event(reference, {
          amountMinor: 19_999,
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([
        expect.objectContaining({
          code: 'trusted_data_mismatch',
          severity: 'critical',
          safeContext: expect.objectContaining({
            errorCode: 'amount_mismatch',
          }) as unknown,
        }),
      ]);
      expect((await harness.ledger(merchant.orgId)).map((e) => e.type)).toEqual(
        [],
      );
    });

    it('flags one provider identifier attached to two purchases', async () => {
      const merchant = await harness.merchant(0);
      const first = await harness.purchaseRow(
        await purchase(harness, merchant),
      );
      const second = await harness.purchaseRow(
        await purchase(harness, merchant),
      );
      const transaction = `txn-${randomUUID()}`;
      for (const row of [first, second])
        await db.insert(paymentProviderEvents).values({
          orgId: merchant.orgId,
          purchaseId: row.id,
          provider: 'paymob',
          providerTransactionId: transaction,
          fingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
          payloadHash: createHash('sha256').update(randomUUID()).digest('hex'),
          verified: true,
          resultCode: 'recorded',
        });
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([
        expect.objectContaining({
          code: 'duplicate_provider_id',
          nextAction: 'investigate_sources',
          purchaseId: expect.stringMatching(
            new RegExp(`^(${first.id}|${second.id})$`),
          ) as unknown,
        }),
      ]);
    });

    it('names purchase grants that disagree with their verified status', async () => {
      const merchant = await harness.merchant(0);
      const granted = await settledPurchase(harness, merchant);
      const ungranted = await purchase(harness, merchant);
      await db
        .update(paymentPurchases)
        .set({ status: 'failed' })
        .where(eq(paymentPurchases.reference, granted));
      await db
        .update(paymentPurchases)
        .set({ status: 'successful' })
        .where(eq(paymentPurchases.reference, ungranted));

      await scan(local);

      expect(await codes(local, merchant.orgId)).toEqual([
        'grant_without_verified_success',
        'provider_success_without_grant',
      ]);
    });

    it('names contradictory reservation rows', async () => {
      const merchant = await harness.merchant(30);
      const send = await harness.ambiguousSend(merchant);
      await db
        .update(verificationMessageDispatches)
        .set({ state: 'rejected' })
        .where(eq(verificationMessageDispatches.id, send.dispatchId));
      await scan(local);
      expect(await openFindings(local, merchant.orgId)).toEqual([
        expect.objectContaining({
          code: 'source_contradiction',
          nextAction: 'investigate_sources',
          safeContext: expect.objectContaining({
            code: 'reservation_held_on_settled_dispatch',
          }) as unknown,
        }),
      ]);
    });
  });

  describe('scheduled inquiry', () => {
    function inquiring(reportOnly: boolean) {
      return observability(harness, {
        STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED: 'true',
        STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY: String(reportOnly),
      });
    }

    function answer(
      reference: string,
      result: Awaited<ReturnType<Harness['paymob']['inquire']>>,
    ) {
      return jest
        .spyOn(harness.paymob, 'inquire')
        .mockImplementation((input) =>
          input.reference === reference
            ? Promise.resolve(result)
            : Promise.resolve(NOT_FOUND),
        );
    }

    function askedAbout(
      spy: ReturnType<typeof answer>,
      reference: string,
    ): number {
      return spy.mock.calls.filter(([input]) => input.reference === reference)
        .length;
    }

    it('reports a provider success in report-only mode without changing money', async () => {
      const target = inquiring(true);
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      const inquire = answer(
        reference,
        harness.paymob.foundInquiry(reference, {
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );

      await scan(target);

      expect(askedAbout(inquire, reference)).toBe(1);
      expect(await harness.purchaseRow(reference)).toMatchObject({
        status: 'pending',
        reconciliationAttempts: 0,
      });
      await harness.balance(merchant.orgId, 10);
      expect(await codes(target, merchant.orgId)).toEqual([
        'provider_success_without_grant',
        'stale_pending',
      ]);
    });

    it('ingests a provider success canonically in active mode, exactly once', async () => {
      const target = inquiring(false);
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      const found = harness.paymob.foundInquiry(reference, {
        payment: { providerTransactionId: `txn-${randomUUID()}` },
      });
      answer(reference, found);

      await scan(target);
      await scan(target);

      expect(await harness.purchaseRow(reference)).toMatchObject({
        status: 'successful',
      });
      await harness.balance(merchant.orgId, 110);
      expect(
        (await harness.ledger(merchant.orgId)).filter(
          (entry) => entry.type === 'purchase',
        ),
      ).toHaveLength(1);
    });

    it('flags a provider answer that contradicts the stored terms', async () => {
      const target = inquiring(true);
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      answer(
        reference,
        harness.paymob.foundInquiry(reference, {
          currency: 'USD',
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );
      await scan(target);
      expect(await openFindings(target, merchant.orgId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'trusted_data_mismatch',
            safeContext: expect.objectContaining({
              errorCode: 'currency_mismatch',
            }) as unknown,
          }),
        ]),
      );
      expect(await codes(target, merchant.orgId)).not.toContain(
        'provider_success_without_grant',
      );
    });

    it('backs a timed-out inquiry off without touching the purchase, then resolves it', async () => {
      const target = inquiring(true);
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      const inquire = jest
        .spyOn(harness.paymob, 'inquire')
        .mockImplementation((input) =>
          input.reference === reference
            ? Promise.reject(new Error('socket timeout'))
            : Promise.resolve(NOT_FOUND),
        );

      const first = await scan(target);
      expect(askedAbout(inquire, reference)).toBe(1);
      expect(await harness.purchaseRow(reference)).toMatchObject({
        status: 'pending',
        reconciliationRequired: false,
        reconciliationAttempts: 0,
        nextReconciliationAt: null,
      });
      const [attempt] = await db
        .select()
        .from(billingReconciliationAttempts)
        .where(
          and(
            eq(billingReconciliationAttempts.runId, first.id),
            eq(billingReconciliationAttempts.targetKind, 'provider_inquiry'),
            eq(billingReconciliationAttempts.targetKey, reference),
          ),
        );
      expect(attempt).toMatchObject({
        outcome: 'deferred',
        errorCode: 'inquiry_failed',
      });
      const poison = () =>
        openFindings(target, merchant.orgId).then((rows) =>
          rows.find((row) => row.code === 'provider_inquiry_deferred'),
        );
      const deferred = await poison();
      expect(deferred).toMatchObject({
        retryCount: 1,
        nextAction: 'retry_provider_inquiry',
        safeContext: { reference, providerCode: 'inquiry_failed' },
      });
      expect(Date.parse(deferred!.nextAttemptAt!)).toBeGreaterThan(
        Date.now() + 10 * 60_000,
      );

      // Inside the backoff window the next run leaves Paymob alone.
      await scan(target);
      expect(askedAbout(inquire, reference)).toBe(1);
      expect(await poison()).toMatchObject({ retryCount: 1 });

      // Once due, the provider is asked again; a clean answer resolves it.
      await db
        .update(billingReconciliationFindings)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000).toISOString() })
        .where(eq(billingReconciliationFindings.id, deferred!.id));
      inquire.mockResolvedValue(NOT_FOUND);
      await scan(target);
      expect(askedAbout(inquire, reference)).toBe(2);
      expect(await poison()).toBeUndefined();
      expect(await harness.purchaseRow(reference)).toMatchObject({
        status: 'pending',
      });
    });

    it('doubles the backoff for a rate-limited provider', async () => {
      const target = inquiring(true);
      const merchant = await harness.merchant(10);
      const reference = await stalePurchase(harness, merchant);
      answer(reference, { outcome: 'unknown', code: 'provider_unavailable' });
      await scan(target);
      const [first] = (await openFindings(target, merchant.orgId)).filter(
        (row) => row.code === 'provider_inquiry_deferred',
      );
      await db
        .update(billingReconciliationFindings)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000).toISOString() })
        .where(eq(billingReconciliationFindings.id, first.id));
      await scan(target);
      const [second] = (await openFindings(target, merchant.orgId)).filter(
        (row) => row.code === 'provider_inquiry_deferred',
      );
      expect(second).toMatchObject({
        id: first.id,
        retryCount: 2,
        safeContext: { reference, providerCode: 'provider_unavailable' },
      });
      expect(Date.parse(second.nextAttemptAt!)).toBeGreaterThan(
        Date.now() + 25 * 60_000,
      );
    });
  });
});

describe('US-04.5-07 PostgreSQL product and finance metrics', () => {
  const harness = billingOperationsHarness();
  const { db } = harness;
  let target: Observability;

  beforeAll(async () => {
    await harness.setup();
    target = observability(harness);
  });
  afterAll(harness.teardown);
  afterEach(() => jest.restoreAllMocks());

  async function window<T>(work: () => Promise<T>) {
    const from = await databaseNow(harness);
    const value = await work();
    const to = await databaseNow(harness, 1);
    return { from, to, value };
  }

  async function liability() {
    const { finance } = await target.service.health();
    return {
      credits: finance.unspentPaidCredits,
      minor: finance.unspentPaidCreditLiabilityMinor,
    };
  }

  async function consume(merchant: Awaited<ReturnType<Harness['merchant']>>) {
    const input = await harness.verification(merchant);
    const claimed = await harness.dispatches.claim(input);
    if (claimed.outcome !== 'claimed')
      throw new Error(`Expected claim, received ${claimed.outcome}`);
    await harness.dispatches.markAccepted({
      dispatchId: claimed.dispatch.id,
      providerMessageId: randomUUID(),
      sentAt: new Date().toISOString(),
    });
    return claimed.dispatch;
  }

  it('deduplicates checkout and revenue under callback replay and page refresh', async () => {
    const before = await liability();
    const { from, to } = await window(async () => {
      const merchant = await harness.merchant(30);
      const reference = await purchase(harness, merchant);
      const event = harness.paymob.event(reference, {
        payment: { providerTransactionId: `txn-${randomUUID()}` },
      });
      await harness.callbacks.ingest(event);
      await harness.callbacks.ingest(event);
    });

    await target.service.health(from, to);
    const health = await target.service.health(from, to);

    expect(health.product).toMatchObject({
      checkoutStarts: 1,
      successfulPurchases: 1,
      firstPurchases: 1,
      repeatPurchases: 0,
      launchGrants: 1,
      freeCreditsGranted: 30,
      purchaseStates: { successful: 1 },
      paidConversionPercent: 100,
    });
    expect(health.finance).toMatchObject({
      purchasedCredits: 100,
      grossMinor: 20_000,
      payingOrganizations: 1,
      netRevenueMinor: null,
      feeMinor: null,
      vatMinor: null,
      arppuMinor: null,
      revenuePerAcceptedMessageMinor: null,
    });
    expect(health.settlementCoverage.complete).toBe(false);
    // Free credits are not cash: only the paid batch is a liability.
    expect(await liability()).toEqual({
      credits: before.credits + 100,
      minor: before.minor + 20_000,
    });
  });

  it('classifies first and repeat purchases per organization', async () => {
    const { from, to } = await window(async () => {
      const repeat = await harness.merchant(0);
      await settledPurchase(harness, repeat);
      await settledPurchase(harness, repeat);
      await settledPurchase(harness, await harness.merchant(0));
      await purchase(harness, await harness.merchant(0));
    });
    const health = await target.service.health(from, to);
    expect(health.product).toMatchObject({
      checkoutStarts: 4,
      successfulPurchases: 3,
      firstPurchases: 2,
      repeatPurchases: 1,
      purchaseSizeDistribution: [{ quantity: 100, count: 3 }],
      purchaseStates: { pending: 1, successful: 3 },
      paidConversionPercent: 75,
    });
    expect(health.finance).toMatchObject({
      payingOrganizations: 2,
      purchasedCredits: 300,
      grossMinor: 60_000,
    });
  });

  it('spends non-cash credits before paid credits and prices liability from the purchase', async () => {
    const merchant = await harness.merchant(30);
    const before = await liability();
    await settledPurchase(harness, merchant);
    await staffAdjust(harness, merchant.orgId, 10);
    expect(await liability()).toEqual({
      credits: before.credits + 100,
      minor: before.minor + 20_000,
    });
    // 40 non-cash credits absorb the first 40; the last 5 come from cash.
    await staffAdjust(harness, merchant.orgId, -45);
    expect(await liability()).toEqual({
      credits: before.credits + 95,
      minor: before.minor + 19_000,
    });
  });

  it('restores the source allocation when a failed send is reversed', async () => {
    const merchant = await harness.merchant(0);
    const before = await liability();
    const {
      from,
      to,
      value: dispatch,
    } = await window(async () => {
      await settledPurchase(harness, merchant);
      return consume(merchant);
    });
    expect(await liability()).toEqual({
      credits: before.credits + 99,
      minor: before.minor + 19_800,
    });
    expect((await target.service.health(from, to)).product).toMatchObject({
      initialConsumption: 1,
      followUpConsumption: 0,
      failureReversals: 0,
    });

    await harness.dispatches.recordProviderStatus(
      dispatch.id,
      'failed',
      new Date(Date.now() + 1_000).toISOString(),
    );
    expect(await liability()).toEqual({
      credits: before.credits + 100,
      minor: before.minor + 20_000,
    });
  });

  it('reports refund and chargeback arithmetic from immutable reversals', async () => {
    const merchant = await harness.merchant(0);
    const before = await liability();
    const action = (
      reference: string,
      kind: 'refund' | 'chargeback_open' | 'chargeback_won',
      amountMinor: number,
      providerReference: string,
    ) =>
      harness.operations.recordProviderAction({
        userId: OPERATOR,
        orgId: merchant.orgId,
        reference,
        action: kind,
        providerReference,
        amountMinor,
        currency: 'EGP',
        evidence: 'Paymob dashboard transaction',
        reason: 'Finance confirmed with Paymob',
        requestId: 'req-metrics',
      });
    const { from, to } = await window(async () => {
      const refunded = await settledPurchase(harness, merchant);
      const disputed = await settledPurchase(harness, merchant);
      await action(refunded, 'refund', 4_000, 'rf-metrics');
      await action(disputed, 'chargeback_open', 20_000, 'cb-metrics');
      return disputed;
    }).then(async (range) => {
      expect(await liability()).toEqual({
        credits: before.credits + 80,
        minor: before.minor + 16_000,
      });
      await action(range.value, 'chargeback_won', 20_000, 'cb-metrics');
      return range;
    });

    const health = await target.service.health(from, to);
    expect(health.finance).toMatchObject({
      grossMinor: 40_000,
      refundedMinor: 4_000,
      chargebackMinor: 20_000,
    });
    expect(await liability()).toEqual({
      credits: before.credits + 180,
      minor: before.minor + 36_000,
    });
  });

  describe('settlement summaries', () => {
    const base = (
      overrides: Partial<SettlementInput> &
        Pick<SettlementInput, 'periodStart' | 'periodEnd'>,
    ): SettlementInput => ({
      providerReportId: 'paymob-report-contract',
      settledAt: new Date().toISOString(),
      currency: 'EGP',
      transactionCount: 1,
      grossMinor: 20_000,
      refundedMinor: 0,
      chargebackMinor: 0,
      feeMinor: 500,
      vatMinor: 70,
      netMinor: 19_430,
      evidence: 'Finance drive / settlements / contract',
      reason: 'Record the Paymob settlement report',
      ...overrides,
    });

    it('requires an idempotency key and treats a replay as the same entry', async () => {
      const settlement = base({
        providerReportId: `paymob-report-${randomUUID()}`,
        periodStart: '2020-01-01T00:00:00.000Z',
        periodEnd: '2020-01-02T00:00:00.000Z',
        transactionCount: 0,
        grossMinor: 0,
        feeMinor: 0,
        vatMinor: 0,
        netMinor: 0,
      });
      await expect(
        target.service.recordSettlement({ userId: OPERATOR, settlement }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_IDEMPOTENCY_KEY_REQUIRED' },
      });
      await expect(
        target.service.recordSettlement({
          userId: OPERATOR,
          idempotencyKey: 'bad key!',
          settlement,
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_IDEMPOTENCY_KEY_INVALID' },
      });
      await expect(
        target.service.recordSettlement({
          userId: OPERATOR,
          idempotencyKey: `key-${randomUUID()}`,
          settlement: { ...settlement, periodEnd: settlement.periodStart },
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_SETTLEMENT_PERIOD_INVALID' },
      });

      const key = `key-${randomUUID()}`;
      target.producer.enqueue.mockClear();
      const first = await target.service.recordSettlement({
        userId: OPERATOR,
        idempotencyKey: key,
        settlement,
      });
      const replay = await target.service.recordSettlement({
        userId: OPERATOR,
        idempotencyKey: key,
        settlement,
      });
      expect(replay).toMatchObject({ id: first.id, duplicate: true });
      expect(target.producer.enqueue).toHaveBeenCalledTimes(1);
      expect(target.producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'settlement',
          settlementId: first.id,
          runKey: `settlement:${first.id}`,
        }),
      );
      expect(target.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'standalone-billing.settlement.record',
        }),
      );
      await expect(
        target.service.recordSettlement({
          userId: OPERATOR,
          idempotencyKey: key,
          settlement: { ...settlement, feeMinor: 1, netMinor: -1 },
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_IDEMPOTENCY_CONFLICT' },
      });
      await expect(
        target.service.recordSettlement({
          userId: OPERATOR,
          idempotencyKey: `key-${randomUUID()}`,
          settlement: { ...settlement, supersedesId: randomUUID() },
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_SETTLEMENT_NOT_FOUND' },
      });
    });

    it('compares exact counts and minor units, and corrects by appending', async () => {
      const merchant = await harness.merchant(0);
      const { from, to } = await window(async () => {
        await settledPurchase(harness, merchant);
        await consume(merchant);
      });
      expect(
        (await target.service.health(from, to)).finance.netRevenueMinor,
      ).toBeNull();

      const providerReportId = `paymob-report-${randomUUID()}`;
      const exact = base({
        providerReportId,
        periodStart: from,
        periodEnd: to,
      });
      const original = await target.service.recordSettlement({
        userId: OPERATOR,
        idempotencyKey: `key-${randomUUID()}`,
        settlement: exact,
      });
      await scan(target, original.id);
      const settlementFindings = (id: string) =>
        db
          .select()
          .from(billingReconciliationFindings)
          .where(
            and(
              eq(billingReconciliationFindings.settlementId, id),
              eq(billingReconciliationFindings.status, 'open'),
            ),
          );
      expect(await settlementFindings(original.id)).toEqual([]);

      // One piastre of gross is a finding; the correction supersedes, never edits.
      const drifted = await target.service.recordSettlement({
        userId: OPERATOR,
        idempotencyKey: `key-${randomUUID()}`,
        settlement: {
          ...exact,
          supersedesId: original.id,
          grossMinor: 20_001,
          netMinor: 19_431,
          reason: 'Correct the gross copied from the report',
        },
      });
      expect(drifted).toMatchObject({
        revision: 2,
        supersedesId: original.id,
      });
      await scan(target, drifted.id);
      expect(await settlementFindings(drifted.id)).toEqual([
        expect.objectContaining({
          code: 'settlement_difference',
          nextAction: 'review_settlement',
          safeContext: expect.objectContaining({
            differences: expect.objectContaining({
              grossMinor: 1,
              netMinor: 1,
              transactionCount: 0,
              providerArithmeticMinor: 0,
            }) as unknown,
          }) as unknown,
        }),
      ]);
      await expect(
        target.service.recordSettlement({
          userId: OPERATOR,
          idempotencyKey: `key-${randomUUID()}`,
          settlement: { ...exact, supersedesId: original.id },
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_SETTLEMENT_CONFLICT' },
      });

      const corrected = await target.service.recordSettlement({
        userId: OPERATOR,
        idempotencyKey: `key-${randomUUID()}`,
        settlement: {
          ...exact,
          supersedesId: drifted.id,
          reason: 'Restore the reported gross',
        },
      });
      expect(await settlementFindings(drifted.id)).toEqual([]);
      await scan(target, corrected.id);
      expect(await settlementFindings(corrected.id)).toEqual([]);

      const history = await target.service.listSettlements(50);
      const chain = history.rows.filter(
        (row) => row.providerReportId === providerReportId,
      );
      expect(chain.map((row) => [row.revision, row.effective])).toEqual([
        [3, true],
        [2, false],
        [1, false],
      ]);
      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await target.service.listSettlements(1, cursor);
        walked.push(...page.rows.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(walked).toEqual(history.rows.map((row) => row.id));

      const health = await target.service.health(from, to);
      expect(health.settlementCoverage).toMatchObject({
        complete: true,
        reports: 1,
      });
      expect(health.finance).toMatchObject({
        grossMinor: 20_000,
        feeMinor: 500,
        vatMinor: 70,
        netRevenueMinor: 19_430,
        payingOrganizations: 1,
        arppuMinor: 19_430,
        revenuePerAcceptedMessageMinor: 19_430,
      });
      // Settlement evidence changes no purchase and grants nothing.
      expect(
        (await harness.ledger(merchant.orgId)).filter(
          (entry) => entry.type === 'purchase',
        ),
      ).toHaveLength(1);
      // A range wider than the coverage is not claimed complete.
      const wider = await target.service.health(
        new Date(Date.parse(from) - 3_600_000).toISOString(),
        to,
      );
      expect(wider.settlementCoverage.complete).toBe(false);
      expect(wider.finance.netRevenueMinor).toBeNull();
    });
  });

  it('keeps every account projection consistent throughout', async () => {
    const accounts = await db
      .select({ orgId: creditAccounts.orgId })
      .from(creditAccounts);
    for (const account of accounts)
      expect(await harness.credits.checkInvariant(account.orgId)).toMatchObject(
        { consistent: true },
      );
  });
});
