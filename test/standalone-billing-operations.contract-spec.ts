import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  billingOperationsHarness,
  OPERATOR,
} from './contracts/billing-operations-harness';
import {
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
      await harness.callbacks.ingest(harness.paymob.event(purchase.reference));

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
});
