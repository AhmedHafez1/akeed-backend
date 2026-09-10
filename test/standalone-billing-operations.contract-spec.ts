import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  billingOperationsHarness,
  OPERATOR,
} from './contracts/billing-operations-harness';
import {
  creditAccounts,
  creditLedgerEntries,
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

  describe('ambiguous send resolution', () => {
    const reason = 'Checked Meta message status with support';

    function resolve(
      send: { orgId: string; dispatchId: string },
      resolution: 'accepted' | 'not_accepted',
      orgId = send.orgId,
    ) {
      return operations.resolveDispatch({
        userId: OPERATOR,
        orgId,
        dispatchId: send.dispatchId,
        resolution,
        providerMessageId:
          resolution === 'accepted' ? `wamid.${send.dispatchId}` : undefined,
        evidence: 'Meta Business Manager delivery report',
        reason,
        requestId: 'req-resolve',
      });
    }

    async function consumptions(orgId: string) {
      return (await harness.ledger(orgId)).filter(
        (entry) => entry.type === 'consumption',
      );
    }

    it('consumes the held credit once when resolved as accepted, and allows no retry', async () => {
      const merchant = await harness.merchant(30);
      const send = await harness.ambiguousSend(merchant);
      await harness.balance(merchant.orgId, 30);
      await expect(resolve(send, 'accepted')).resolves.toMatchObject({
        outcome: 'accepted',
        duplicate: false,
      });
      await expect(resolve(send, 'accepted')).resolves.toMatchObject({
        outcome: 'accepted',
        duplicate: true,
      });
      expect(await consumptions(merchant.orgId)).toHaveLength(1);
      expect(await credits.getSummary(merchant.orgId)).toMatchObject({
        postedBalance: 29,
        heldCredits: 0,
      });
      await expect(harness.dispatches.claim(send)).resolves.toMatchObject({
        outcome: 'accepted',
      });
      const [audit] = (await harness.auditRows(merchant.orgId)).filter(
        (row) => row.action === 'message-dispatch.resolve',
      );
      expect(audit).toMatchObject({
        userId: OPERATOR,
        requestId: 'req-resolve',
        metadata: expect.objectContaining({
          dispatchId: send.dispatchId,
          resolution: 'accepted',
          evidence: 'Meta Business Manager delivery report',
          reason,
        }) as unknown,
      });
    });

    it('releases the held credit once when resolved as not accepted, and permits the next generation', async () => {
      const merchant = await harness.merchant(30);
      const send = await harness.ambiguousSend(merchant);
      await expect(harness.dispatches.claim(send)).resolves.toMatchObject({
        outcome: 'outcome_unknown',
      });
      await expect(resolve(send, 'not_accepted')).resolves.toMatchObject({
        outcome: 'rejected',
      });
      await expect(resolve(send, 'not_accepted')).resolves.toMatchObject({
        outcome: 'rejected',
        duplicate: true,
      });
      await harness.balance(merchant.orgId, 30);
      expect(await consumptions(merchant.orgId)).toHaveLength(0);
      const retry = await harness.dispatches.claim(send);
      expect(retry).toMatchObject({
        outcome: 'claimed',
        dispatch: { generation: 2 },
      });
      expect(await credits.getSummary(merchant.orgId)).toMatchObject({
        postedBalance: 30,
        heldCredits: 1,
      });
    });

    it('settles a race between opposite resolutions exactly once', async () => {
      const merchant = await harness.merchant(30);
      const send = await harness.ambiguousSend(merchant);
      const results = await Promise.allSettled([
        resolve(send, 'accepted'),
        resolve(send, 'not_accepted'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const summary = await credits.getSummary(merchant.orgId);
      expect(summary?.heldCredits).toBe(0);
      expect([29, 30]).toContain(summary?.postedBalance);
      expect(await credits.checkInvariant(merchant.orgId)).toMatchObject({
        consistent: true,
      });
    });

    it('refuses a dispatch that belongs to another tenant', async () => {
      const merchant = await harness.merchant(30);
      const other = await harness.merchant(30);
      const foreign = await harness.ambiguousSend(other);
      await expect(
        resolve(foreign, 'not_accepted', merchant.orgId),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_DISPATCH_NOT_FOUND' },
      });
      expect(await credits.getSummary(other.orgId)).toMatchObject({
        heldCredits: 1,
      });
    });
  });

  describe('purchase inquiry', () => {
    const reason = 'Merchant reports the card was charged';

    async function pending(merchant: {
      user: Parameters<typeof harness.billing.createPurchase>[0];
    }) {
      return harness.billing.createPurchase(
        merchant.user,
        `key-${randomUUID()}`,
        100,
      );
    }

    function inquire(orgId: string, reference: string) {
      return operations.reconcilePurchase({
        userId: OPERATOR,
        orgId,
        reference,
        reason,
        requestId: 'req-inquiry',
      });
    }

    it('grants a verified success through the ordinary ingestion path, once', async () => {
      const merchant = await harness.merchant(30);
      const purchase = await pending(merchant);
      harness.paymob.nextInquiry(
        harness.paymob.foundInquiry(purchase.reference, {
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        ingest: { outcome: 'granted' },
        purchase: { status: 'successful', reconciliationRequired: false },
      });
      await harness.balance(merchant.orgId, 130);
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_PURCHASE_NOT_ELIGIBLE' },
      });
      const [audit] = (await harness.auditRows(merchant.orgId)).filter(
        (row) => row.action === 'standalone-billing.purchase.reconcile',
      );
      expect(audit).toMatchObject({
        requestId: 'req-inquiry',
        metadata: expect.objectContaining({
          outcome: 'resolved',
          resultCode: 'granted',
        }) as unknown,
      });
    });

    it('defers without concluding anything when the provider fails or times out', async () => {
      const merchant = await harness.merchant(30);
      const purchase = await pending(merchant);
      jest
        .spyOn(harness.paymob, 'inquire')
        .mockRejectedValueOnce(new Error('inquiry timed out'));
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).resolves.toMatchObject({
        outcome: 'deferred',
        purchase: {
          status: 'pending',
          reconciliationRequired: true,
          reconciliationCode: 'inquiry_unresolved',
        },
      });
      await harness.balance(merchant.orgId, 30);
    });

    it('never expires a purchase whose checkout window is still open', async () => {
      const merchant = await harness.merchant(30);
      const purchase = await pending(merchant);
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).resolves.toMatchObject({
        outcome: 'deferred',
        purchase: { status: 'pending' },
      });
    });

    it('quarantines a provider answer that does not match the stored purchase', async () => {
      const merchant = await harness.merchant(30);
      const purchase = await pending(merchant);
      harness.paymob.nextInquiry(
        harness.paymob.foundInquiry(purchase.reference, {
          amountMinor: 100,
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).resolves.toMatchObject({
        ingest: { outcome: 'quarantined', errorCode: 'amount_mismatch' },
        purchase: {
          status: 'pending',
          reconciliationRequired: true,
          reconciliationCode: 'callback_mismatch',
        },
      });
      await harness.balance(merchant.orgId, 30);
    });

    it('refuses a purchase from another tenant', async () => {
      const merchant = await harness.merchant(30);
      const other = await harness.merchant(30);
      const purchase = await pending(other);
      await expect(
        inquire(merchant.orgId, purchase.reference),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_PURCHASE_NOT_FOUND' },
      });
    });
  });

  describe('refund and dispute evidence', () => {
    async function settled(quantity = 30) {
      const merchant = await harness.merchant(quantity);
      const purchase = await harness.billing.createPurchase(
        merchant.user,
        `key-${randomUUID()}`,
        100,
      );
      await settle(purchase.reference);
      return { merchant, reference: purchase.reference };
    }

    function record(
      orgId: string,
      reference: string,
      action:
        | 'refund'
        | 'chargeback_open'
        | 'chargeback_lost'
        | 'chargeback_won',
      amountMinor: number,
      overrides: { providerReference?: string; currency?: string } = {},
    ) {
      return operations.recordProviderAction({
        userId: OPERATOR,
        orgId,
        reference,
        action,
        providerReference:
          'providerReference' in overrides
            ? overrides.providerReference
            : `${action}-ref`,
        amountMinor,
        currency: overrides.currency ?? 'EGP',
        evidence: 'Paymob dashboard transaction 991 refund tab',
        reason: 'Finance confirmed with Paymob',
        requestId: 'req-evidence',
      });
    }

    it('reverses an exact full refund once and creates debt for spent credits', async () => {
      const { merchant, reference } = await settled(0);
      await staffAdjust(merchant.orgId, -60);
      await harness.balance(merchant.orgId, 40);
      await expect(
        record(merchant.orgId, reference, 'refund', 20000, {
          providerReference: 'rf-1',
        }),
      ).resolves.toMatchObject({
        outcome: 'reversed',
        reversal: { type: 'refund_reversal', quantity: -100 },
        purchase: { status: 'refunded' },
      });
      await harness.balance(merchant.orgId, -60);
      await expect(
        record(merchant.orgId, reference, 'refund', 20000, {
          providerReference: 'rf-1',
        }),
      ).resolves.toMatchObject({ outcome: 'duplicate' });
      // A real refund callback arriving later carries no new money.
      await harness.callbacks.ingest(
        harness.paymob.event(reference, {
          signal: 'refund',
          refundedMinorTotal: 20000,
          sourceReference: 'rf-1',
          payment: { providerTransactionId: `txn-${randomUUID()}` },
        }),
      );
      await harness.balance(merchant.orgId, -60);
      const [audit] = (await harness.auditRows(merchant.orgId)).filter(
        (row) => row.action === 'standalone-billing.purchase.provider-action',
      );
      expect(audit).toMatchObject({
        requestId: 'req-evidence',
        metadata: expect.objectContaining({
          providerAction: 'refund',
          outcome: 'reversed',
          reversalQuantity: -100,
        }) as unknown,
      });
    });

    it('reverses a whole-credit partial refund and quarantines a non-whole one', async () => {
      const { merchant, reference } = await settled();
      await expect(
        record(merchant.orgId, reference, 'refund', 4000, {
          providerReference: 'rf-part-1',
        }),
      ).resolves.toMatchObject({
        outcome: 'reversed',
        reversal: { quantity: -20 },
        purchase: { status: 'successful', refundedMinor: 4000 },
      });
      await harness.balance(merchant.orgId, 110);
      await expect(
        record(merchant.orgId, reference, 'refund', 4150, {
          providerReference: 'rf-part-2',
        }),
      ).resolves.toMatchObject({
        outcome: 'quarantined',
        reconciliationCode: 'partial_refund_not_whole_credit',
        reversal: null,
      });
      await harness.balance(merchant.orgId, 110);
      expect(await harness.purchaseRow(reference)).toMatchObject({
        refundedMinor: 4150,
        reconciliationRequired: true,
        reconciliationCode: 'partial_refund_not_whole_credit',
      });
    });

    it.each([
      ['currency', { currency: 'USD' }, 20000, 'currency_mismatch'],
      ['amount', {}, 20001, 'amount_mismatch'],
    ] as const)(
      'quarantines a %s mismatch without reversing anything',
      async (_label, overrides, amount, errorCode) => {
        const { merchant, reference } = await settled();
        await expect(
          record(merchant.orgId, reference, 'refund', amount, overrides),
        ).resolves.toMatchObject({ outcome: 'quarantined', errorCode });
        await harness.balance(merchant.orgId, 130);
        expect(await harness.purchaseRow(reference)).toMatchObject({
          status: 'successful',
          reconciliationCode: 'staff_evidence_mismatch',
        });
      },
    );

    it('quarantines a refund with no provider identifier', async () => {
      const { merchant, reference } = await settled();
      await expect(
        record(merchant.orgId, reference, 'refund', 20000, {
          providerReference: undefined,
        }),
      ).resolves.toMatchObject({
        outcome: 'quarantined',
        reconciliationCode: 'refund_reference_missing',
      });
      await harness.balance(merchant.orgId, 130);
    });

    it('reverses on chargeback open, not again on loss, and reinstates once when won', async () => {
      const { merchant, reference } = await settled();
      const dispute = { providerReference: 'cb-1' };
      await expect(
        record(merchant.orgId, reference, 'chargeback_open', 20000, dispute),
      ).resolves.toMatchObject({
        outcome: 'reversed',
        reversal: { type: 'chargeback_reversal', quantity: -100 },
      });
      await harness.balance(merchant.orgId, 30);
      await expect(
        record(merchant.orgId, reference, 'chargeback_lost', 20000, dispute),
      ).resolves.toMatchObject({ reversal: null });
      await harness.balance(merchant.orgId, 30);
      await expect(
        record(merchant.orgId, reference, 'chargeback_won', 20000, dispute),
      ).resolves.toMatchObject({
        outcome: 'reversed',
        reversal: { type: 'chargeback_reinstatement', quantity: 100 },
        purchase: { disputeStatus: 'won' },
      });
      await harness.balance(merchant.orgId, 130);
      await expect(
        record(merchant.orgId, reference, 'chargeback_won', 20000, dispute),
      ).resolves.toMatchObject({ outcome: 'duplicate' });
      await harness.balance(merchant.orgId, 130);
    });

    it('quarantines a partial dispute and a dispute on an unpaid purchase', async () => {
      const { merchant, reference } = await settled();
      await expect(
        record(merchant.orgId, reference, 'chargeback_open', 10000),
      ).resolves.toMatchObject({
        outcome: 'quarantined',
        errorCode: 'dispute_amount_mismatch',
      });
      const unpaid = await harness.billing.createPurchase(
        merchant.user,
        `key-${randomUUID()}`,
        100,
      );
      await expect(
        record(merchant.orgId, unpaid.reference, 'chargeback_open', 20000),
      ).resolves.toMatchObject({
        outcome: 'quarantined',
        reconciliationCode: 'dispute_without_grant',
      });
      await harness.balance(merchant.orgId, 130);
    });

    it('refuses to pair an account with another tenant purchase', async () => {
      const { merchant } = await settled();
      const other = await settled();
      await expect(
        record(merchant.orgId, other.reference, 'refund', 20000),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_PURCHASE_NOT_FOUND' },
      });
      await harness.balance(other.merchant.orgId, 130);
    });

    it('keeps the ledger immutable underneath every staff operation', async () => {
      const { merchant } = await settled();
      const [entry] = await harness.ledger(merchant.orgId);
      await expect(
        db
          .update(creditLedgerEntries)
          .set({ quantity: 1 })
          .where(eq(creditLedgerEntries.id, entry.id)),
      ).rejects.toThrow();
      await expect(
        db
          .delete(creditLedgerEntries)
          .where(eq(creditLedgerEntries.id, entry.id)),
      ).rejects.toThrow();
    });
  });
});
