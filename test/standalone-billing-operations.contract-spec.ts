import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  billingOperationsHarness,
  OPERATOR,
} from './contracts/billing-operations-harness';
import {
  creditAccounts,
  paymentPurchases,
  verificationMessageDispatches,
} from '../src/infrastructure/database/schema';

/**
 * US-04.5-06 against real PostgreSQL.
 *
 * Staff operations lean on the same unique indexes, CHECK constraints and
 * triggers as the money paths they reconcile, so the guarantees are only
 * meaningful against the real schema with the real migrations applied.
 */
const harness = billingOperationsHarness();
const { db, credits, approvals, operations } = harness;

async function staffAdjust(orgId: string, quantity: number) {
  await db.transaction((tx) =>
    credits.postLedgerEntry(tx, {
      orgId,
      type: 'staff_adjustment',
      quantity,
      idempotencyKey: `fixture:${randomUUID()}`,
      actorId: randomUUID(),
      reason: 'Synthetic fixture',
    }),
  );
}

/** Each settlement gets its own provider transaction, as in production. */
async function settle(reference: string) {
  return harness.callbacks.ingest(
    harness.paymob.event(reference, {
      payment: { providerTransactionId: `txn-${randomUUID()}` },
    }),
  );
}

async function listed(query: Parameters<typeof approvals.list>[1]) {
  const page = await approvals.list(OPERATOR, { limit: 100, ...query });
  return page.rows.map((row) => row.orgId);
}

describe('US-04.5-06 PostgreSQL staff billing operations', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);
  afterEach(() => jest.restoreAllMocks());

  describe('inspection', () => {
    it('filters accounts by balance, status and reconciliation state before paging', async () => {
      const healthy = await harness.merchant(50);
      const low = await harness.merchant(5);
      const zero = await harness.merchant(0);
      const debt = await harness.merchant(10);
      await staffAdjust(debt.orgId, -15);
      const flagged = await harness.merchant(50);
      const purchase = await harness.billing.createPurchase(
        flagged.user,
        `key-${randomUUID()}`,
        100,
      );
      await db
        .update(paymentPurchases)
        .set({
          reconciliationRequired: true,
          reconciliationCode: 'callback_mismatch',
        })
        .where(eq(paymentPurchases.reference, purchase.reference));

      expect(await listed({ balance: 'low' })).toEqual(
        expect.arrayContaining([low.orgId]),
      );
      expect(await listed({ balance: 'low' })).not.toContain(healthy.orgId);
      expect(await listed({ balance: 'zero' })).toContain(zero.orgId);
      expect(await listed({ balance: 'zero' })).not.toContain(low.orgId);
      expect(await listed({ balance: 'debt' })).toEqual(
        expect.arrayContaining([debt.orgId]),
      );
      expect(await listed({ balance: 'debt' })).not.toContain(zero.orgId);
      const reconciliation = await listed({ reconciliation: 'required' });
      expect(reconciliation).toContain(flagged.orgId);
      expect(reconciliation).not.toContain(healthy.orgId);
      expect(await listed({ accountStatus: 'active' })).toContain(
        healthy.orgId,
      );
      expect(await listed({ accountStatus: 'suspended' })).not.toContain(
        healthy.orgId,
      );

      const page = await approvals.list(OPERATOR, { limit: 100 });
      expect(page.rows.find((row) => row.orgId === debt.orgId)).toMatchObject({
        billing: { debtCredits: 5, balanceState: 'debt' },
      });
      expect(
        page.rows.find((row) => row.orgId === flagged.orgId),
      ).toMatchObject({
        billing: { flaggedPurchases: 1, reconciliationRequired: true },
      });
      expect(page.operations).toEqual({ enabled: true, operator: true });
    });

    it('reconciles one account from its ledger, holds, purchases and events without leaking internals', async () => {
      const merchant = await harness.merchant(30);
      const other = await harness.merchant(30);
      await harness.ambiguousSend(merchant);
      await harness.ambiguousSend(other);
      const purchase = await harness.billing.createPurchase(
        merchant.user,
        `key-${randomUUID()}`,
        100,
      );
      await settle(purchase.reference);

      const detail = await operations.accountDetail(OPERATOR, merchant.orgId);
      expect(detail.account).toMatchObject({
        postedBalance: 130,
        heldCredits: 1,
        availableCredits: 129,
      });
      expect(detail.reconciliation).toMatchObject({
        consistent: true,
        ledgerBalance: 130,
        reservationHolds: 1,
        contradictions: [],
      });
      expect(detail.mutationsBlocked).toBe(false);
      expect(detail.holds.items).toHaveLength(1);
      expect(detail.holds.items[0]).toMatchObject({
        dispatchState: 'outcome_unknown',
        accountingMode: 'prepaid_credit',
        providerMessageIdRecorded: false,
      });
      expect(detail.purchases.items[0]).toMatchObject({
        reference: purchase.reference,
        status: 'successful',
      });
      expect(detail.events.items[0]).toMatchObject({
        purchaseRef: purchase.reference,
        resultCode: 'granted',
        verified: true,
      });
      expect(detail.ledger.items.map((entry) => entry.type).sort()).toEqual([
        'free_grant',
        'purchase',
      ]);

      const serialized = JSON.stringify(detail);
      for (const secret of [
        'payloadHash',
        'fingerprint',
        'requestHash',
        'requestKey',
        'customerPhone',
        '+201000000000',
        'providerIntentionId',
      ])
        expect(serialized).not.toContain(secret);
      // Nothing of the other tenant's send reaches this tenant's detail.
      const foreign = await operations.accountDetail(OPERATOR, other.orgId);
      expect(serialized).not.toContain(foreign.holds.items[0].dispatchId);
    });

    it('makes a drifted projection prominent and blocks mutations', async () => {
      const merchant = await harness.merchant(30);
      await harness.driftProjection(merchant.orgId, 7);
      const detail = await operations.accountDetail(OPERATOR, merchant.orgId);
      expect(detail.reconciliation).toMatchObject({
        consistent: false,
        postedBalance: 37,
        ledgerBalance: 30,
        postedDifference: -7,
      });
      expect(detail.mutationsBlocked).toBe(true);
      expect(await listed({ reconciliation: 'required' })).toContain(
        merchant.orgId,
      );
    });

    it('names contradictory source rows', async () => {
      const merchant = await harness.merchant(30);
      const send = await harness.ambiguousSend(merchant);
      // A hold outliving the send that settled it can only come from a write
      // that skipped the accounting path.
      await db
        .update(verificationMessageDispatches)
        .set({ state: 'rejected' })
        .where(eq(verificationMessageDispatches.id, send.dispatchId));
      const detail = await operations.accountDetail(OPERATOR, merchant.orgId);
      expect(detail.reconciliation?.contradictions).toEqual([
        expect.objectContaining({
          code: 'reservation_held_on_settled_dispatch',
        }),
      ]);
      expect(detail.mutationsBlocked).toBe(true);
    });

    it('answers an unknown organization with not found', async () => {
      await expect(
        operations.accountDetail(OPERATOR, randomUUID()),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_ACCOUNT_NOT_FOUND' },
      });
    });
  });

  describe('credit adjustments', () => {
    const reason = 'Goodwill credit approved by finance ticket FIN-12';

    async function adjust(
      orgId: string,
      quantity: number,
      key = `adj-${randomUUID()}`,
    ) {
      const preview = await operations.previewAdjustment(
        OPERATOR,
        orgId,
        quantity,
      );
      const apply = () =>
        operations.applyAdjustment({
          userId: OPERATOR,
          orgId,
          previewId: preview.previewId,
          fingerprint: preview.fingerprint,
          reason,
          idempotencyKey: key,
          requestId: 'req-adjust',
        });
      return { preview, apply, key };
    }

    it('posts a positive adjustment with ledger, projection and audit together', async () => {
      const merchant = await harness.merchant(30);
      const { preview, apply } = await adjust(merchant.orgId, 20);
      expect(preview).toMatchObject({
        before: { postedBalance: 30, availableCredits: 30 },
        after: { postedBalance: 50, availableCredits: 50 },
      });
      await expect(apply()).resolves.toMatchObject({
        outcome: 'applied',
        quantity: 20,
        before: { postedBalance: 30 },
        after: { postedBalance: 50 },
      });
      await harness.balance(merchant.orgId, 50);
      const entries = (await harness.ledger(merchant.orgId)).filter(
        (entry) => entry.type === 'staff_adjustment',
      );
      expect(entries).toEqual([
        expect.objectContaining({
          quantity: 20,
          actorId: OPERATOR,
          reason,
          postedBalanceBefore: 30,
          postedBalanceAfter: 50,
        }),
      ]);
      const audit = (await harness.auditRows(merchant.orgId)).find(
        (row) => row.action === 'standalone-billing.adjustment.apply',
      );
      expect(audit).toMatchObject({
        userId: OPERATOR,
        requestId: 'req-adjust',
        metadata: expect.objectContaining({
          quantity: 20,
          reason,
          postedBalanceBefore: 30,
          postedBalanceAfter: 50,
        }) as unknown,
      });
    });

    it('turns a negative adjustment past zero into debt', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, -40);
      await expect(apply()).resolves.toMatchObject({
        after: { postedBalance: -10, debtCredits: 10, availableCredits: 0 },
      });
      await harness.balance(merchant.orgId, -10);
    });

    it('answers a repeated or lost-response apply as a no-op', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      await apply();
      await expect(apply()).resolves.toMatchObject({
        outcome: 'duplicate',
        quantity: 5,
        after: { postedBalance: 35 },
      });
      await harness.balance(merchant.orgId, 35);
    });

    it('serializes two concurrent applies of one preview into one posting', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      const results = await Promise.all([apply(), apply()]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'applied',
        'duplicate',
      ]);
      await harness.balance(merchant.orgId, 35);
    });

    it('refuses a second key for a preview and a reused key for another preview', async () => {
      const merchant = await harness.merchant(30);
      const first = await adjust(merchant.orgId, 5);
      await first.apply();
      await expect(
        operations.applyAdjustment({
          userId: OPERATOR,
          orgId: merchant.orgId,
          previewId: first.preview.previewId,
          fingerprint: first.preview.fingerprint,
          reason,
          idempotencyKey: `adj-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_PREVIEW_ALREADY_APPLIED' },
      });
      const second = await adjust(merchant.orgId, 7, first.key);
      await expect(second.apply()).rejects.toMatchObject({
        response: { code: 'BILLING_IDEMPOTENCY_CONFLICT' },
      });
      await harness.balance(merchant.orgId, 35);
    });

    it('refuses a preview made stale by a concurrent send', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      await harness.ambiguousSend(merchant);
      await expect(apply()).rejects.toMatchObject({
        response: { code: 'BILLING_PREVIEW_STALE' },
      });
      await harness.balance(merchant.orgId, 30);
    });

    it('refuses a preview made stale by a verified purchase', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      const purchase = await harness.billing.createPurchase(
        merchant.user,
        `key-${randomUUID()}`,
        100,
      );
      await settle(purchase.reference);
      await expect(apply()).rejects.toMatchObject({
        response: { code: 'BILLING_PREVIEW_STALE' },
      });
      await harness.balance(merchant.orgId, 130);
    });

    it('rolls the ledger entry back when the audit row cannot be written', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      jest
        .spyOn(harness.operationsRepository, 'insertAudit')
        .mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(apply()).rejects.toThrow('audit unavailable');
      await harness.balance(merchant.orgId, 30);
      await expect(apply()).resolves.toMatchObject({ outcome: 'applied' });
      await harness.balance(merchant.orgId, 35);
    });

    it('blocks adjustments while the projection has drifted', async () => {
      const merchant = await harness.merchant(30);
      const { apply } = await adjust(merchant.orgId, 5);
      await harness.driftProjection(merchant.orgId, 3);
      await expect(apply()).rejects.toMatchObject({
        response: { code: 'CREDIT_PROJECTION_MISMATCH' },
      });
      await expect(
        operations.previewAdjustment(OPERATOR, merchant.orgId, 5),
      ).rejects.toMatchObject({
        response: { code: 'CREDIT_PROJECTION_MISMATCH' },
      });
    });

    it('refuses an account that was never approved', async () => {
      const merchant = await harness.merchant(0);
      await db
        .update(creditAccounts)
        .set({
          status: 'pending_approval',
          version: sql`${creditAccounts.version} + 1`,
        })
        .where(eq(creditAccounts.orgId, merchant.orgId));
      await expect(
        operations.previewAdjustment(OPERATOR, merchant.orgId, 5),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_ACCOUNT_NOT_APPROVED' },
      });
    });

    it('never applies a preview for another staff member or tenant', async () => {
      const merchant = await harness.merchant(30);
      const other = await harness.merchant(30);
      const { preview } = await adjust(merchant.orgId, 5);
      for (const attempt of [
        { userId: randomUUID(), orgId: merchant.orgId },
        { userId: OPERATOR, orgId: other.orgId },
      ])
        await expect(
          operations.applyAdjustment({
            ...attempt,
            previewId: preview.previewId,
            fingerprint: preview.fingerprint,
            reason,
            idempotencyKey: `adj-${randomUUID()}`,
          }),
        ).rejects.toMatchObject({
          response: { code: 'BILLING_PREVIEW_NOT_FOUND' },
        });
      await harness.balance(merchant.orgId, 30);
      await harness.balance(other.orgId, 30);
    });
  });
});
