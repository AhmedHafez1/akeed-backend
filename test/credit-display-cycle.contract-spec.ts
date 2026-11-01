import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { paymobBillingHarness } from './contracts/paymob-billing-harness';
import { CreditModelNoticesRepository } from '../src/infrastructure/database/repositories/credit-model-notices.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  orders,
  paymentPurchases,
  verifications,
} from '../src/infrastructure/database/schema';
import { displayedUsage } from '../src/shared/billing/merchant-credits';

/**
 * One merchant through a whole cycle against real PostgreSQL. EGP, stored and
 * displayed values must agree at every step, because the merchant sees one set
 * and the database and Paymob hold the other.
 */
const harness = paymobBillingHarness();
const { billing, callbacks, paymob, credits, db, router } = harness;
const dispatches = new VerificationMessageDispatchesRepository(
  db as never,
  router,
);

async function send(source: { orgId: string; integrationId: string }) {
  const [order] = await db
    .insert(orders)
    .values({
      ...source,
      externalOrderId: randomUUID(),
      customerPhone: '+201000000000',
      totalPrice: '100.00',
    })
    .returning();
  const [verification] = await db
    .insert(verifications)
    .values({ orgId: source.orgId, orderId: order.id, status: 'pending' })
    .returning();
  return dispatches.claim({
    ...source,
    verificationId: verification.id,
    kind: 'initial' as const,
    templateName: 'cod_verification',
    languageCode: 'en',
    leaseUntil: new Date(Date.now() + 600000).toISOString(),
  });
}

async function accepted(source: { orgId: string; integrationId: string }) {
  const result = await send(source);
  if (result.outcome !== 'claimed') throw new Error(result.outcome);
  await dispatches.markAccepted({
    dispatchId: result.dispatch.id,
    providerMessageId: randomUUID(),
    sentAt: new Date().toISOString(),
  });
  return result.dispatch;
}

describe('PostgreSQL displayed credits cycle', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);

  it('keeps EGP, stored and displayed values consistent from purchase to refund', async () => {
    const merchant = await harness.merchant(0);
    const checkout = jest.spyOn(paymob, 'createCheckout');

    // Purchase: 200 displayed credits, EGP 200, 100 stored.
    const purchase = await billing.createMerchantPurchase(
      merchant.user,
      `key-${randomUUID()}`,
      { displayQuantity: 200 },
    );
    expect(purchase).toMatchObject({
      quantity: 200,
      unitPriceMinor: 100,
      totalMinor: 20000,
    });
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 100,
        unitPriceMinor: 200,
        totalMinor: 20000,
      }),
    );
    const [row] = await db
      .select()
      .from(paymentPurchases)
      .where(eq(paymentPurchases.reference, purchase.reference));
    expect(row).toMatchObject({
      quantity: 100,
      unitPriceMinor: 200,
      totalMinor: 20000,
    });

    await callbacks.ingest(paymob.event(purchase.reference));
    await harness.balance(merchant.orgId, 100);
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      postedBalance: 200,
      availableCredits: 200,
    });

    // Send: one message uses 2 displayed credits, 1 stored.
    const dispatch = await accepted(merchant);
    await harness.balance(merchant.orgId, 99);
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      availableCredits: 198,
    });
    const usage = await billing.listLedger(merchant.user, { limit: 10 });
    expect(usage.items[0]).toMatchObject({
      type: 'consumption',
      quantity: -2,
      postedBalanceAfter: 198,
    });

    // Failed receipt: the credit comes back.
    await dispatches.recordProviderStatus(
      dispatch.id,
      'failed',
      new Date(Date.now() + 1000).toISOString(),
    );
    await harness.balance(merchant.orgId, 100);
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      availableCredits: 200,
    });

    // Refund: the whole EGP total, and the balance returns to nothing.
    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'refund',
        refundedMinorTotal: 20000,
        sourceReference: 'refund-cycle',
        payment: { providerTransactionId: 'txn-refund-cycle' },
      }),
    );
    await harness.balance(merchant.orgId, 0);
    await expect(
      billing.readPurchase(merchant.user, purchase.reference),
    ).resolves.toMatchObject({
      status: 'refunded',
      quantity: 200,
      totalMinor: 20000,
      refundedMinor: 20000,
    });
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      availableCredits: 0,
    });
  });

  it('sends exactly as many messages as before: 200 displayed is 100 sends', async () => {
    const merchant = await harness.merchant(100);
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      availableCredits: 200,
    });
    for (let index = 0; index < 100; index += 1) {
      await accepted(merchant);
    }
    await expect(send(merchant)).resolves.toMatchObject({
      outcome: 'blocked',
      reason: 'INSUFFICIENT_CREDITS',
    });
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      availableCredits: 0,
    });
    await expect(credits.getSummary(merchant.orgId)).resolves.toMatchObject({
      postedBalance: 0,
    });
  });

  it('shows prepaid usage in displayed credits', async () => {
    const merchant = await harness.merchant(50);
    const held = await send(merchant);
    expect(held.outcome).toBe('claimed');
    const availability = await router.readAvailability(merchant.orgId);
    expect(displayedUsage(availability)).toEqual({
      used: 2,
      limit: 100,
      remaining: 98,
    });
  });

  it('backfills the notice for existing accounts only, and claims each email once', async () => {
    const existing = await harness.merchant(10);
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0081_credit_model_notices.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await harness.client.unsafe(statement);
    }
    const later = await harness.merchant(10);
    const notices = new CreditModelNoticesRepository(db as never);

    await expect(notices.isVisible(existing.orgId)).resolves.toBe(true);
    await expect(notices.isVisible(later.orgId)).resolves.toBe(false);

    await notices.dismiss(existing.orgId);
    await expect(notices.isVisible(existing.orgId)).resolves.toBe(false);

    const [first, second] = await Promise.all([
      notices.claimEmailBatch(1000),
      notices.claimEmailBatch(1000),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toContain(existing.orgId);
    expect(claimed).not.toContain(later.orgId);
    expect(new Set(claimed).size).toBe(claimed.length);
    await expect(notices.claimEmailBatch(1000)).resolves.toEqual([]);

    await notices.markEmail(existing.orgId, 'sent');
    await expect(
      notices.markEmail(existing.orgId, 'nonsense' as never),
    ).rejects.toThrow();
  });
});
