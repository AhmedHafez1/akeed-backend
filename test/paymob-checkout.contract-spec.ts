import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { paymobBillingHarness } from './contracts/paymob-billing-harness';
import { paymentPurchases } from '../src/infrastructure/database/schema';

/**
 * US-04.5-04 against real PostgreSQL.
 *
 * Most of the exactly-once and fail-closed behaviour in this story is enforced
 * by unique indexes, CHECK constraints and triggers rather than by application
 * code, so these assertions are only meaningful against the real schema with
 * the real migrations applied.
 */
const harness = paymobBillingHarness();
const { billing, callbacks, reconciliation, paymob, credits, db } = harness;

async function buyer(quantity = 30) {
  return harness.merchant(quantity);
}

async function pendingPurchase(user: Awaited<ReturnType<typeof buyer>>) {
  const created = await billing.createPurchase(
    user.user,
    `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    100,
  );
  return created;
}

describe('US-04.5-04 PostgreSQL Paymob checkout and callbacks', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);
  afterEach(() => jest.restoreAllMocks());

  it('grants purchased credits exactly once on a verified success', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    await expect(
      callbacks.ingest(paymob.event(purchase.reference)),
    ).resolves.toMatchObject({ outcome: 'granted' });
    await harness.balance(merchant.orgId, 130);
    const entries = await harness.ledger(merchant.orgId);
    expect(entries.filter((entry) => entry.type === 'purchase')).toHaveLength(
      1,
    );
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'successful',
    });
  });

  it('absorbs a redelivered callback without a second grant', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    const event = paymob.event(purchase.reference);
    await callbacks.ingest(event);
    await expect(callbacks.ingest(event)).resolves.toMatchObject({
      outcome: 'duplicate',
    });
    await harness.balance(merchant.orgId, 130);
  });

  it('serializes two concurrent deliveries into one grant', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    const event = paymob.event(purchase.reference);
    const results = await Promise.all([
      callbacks.ingest(event),
      callbacks.ingest(event),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'duplicate',
      'granted',
    ]);
    await harness.balance(merchant.orgId, 130);
  });

  it('rolls the whole grant back on failure, then grants once on retry', async () => {
    // The event row rolls back with everything else, so the retry is a first
    // attempt rather than a replay that skips the grant.
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    const event = paymob.event(purchase.reference);
    const failing = jest
      .spyOn(credits, 'updateProjection')
      .mockRejectedValueOnce(new Error('injected failure'));
    await expect(callbacks.ingest(event)).rejects.toThrow('injected failure');
    failing.mockRestore();

    await harness.balance(merchant.orgId, 30);
    expect(await harness.events(purchase.reference)).toHaveLength(0);
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'pending',
    });

    await expect(callbacks.ingest(event)).resolves.toMatchObject({
      outcome: 'granted',
    });
    await harness.balance(merchant.orgId, 130);
    expect(
      (await harness.ledger(merchant.orgId)).filter(
        (entry) => entry.type === 'purchase',
      ),
    ).toHaveLength(1);
  });

  it('fails a declined purchase without touching the ledger', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(
      paymob.event(purchase.reference, { signal: 'decline' }),
    );
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'failed',
    });
    await harness.balance(merchant.orgId, 30);
  });

  it('promotes a delayed success over an earlier failure and refuses the reverse', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(
      paymob.event(purchase.reference, { signal: 'decline' }),
    );
    await expect(
      callbacks.ingest(
        paymob.event(purchase.reference, {
          payment: { providerTransactionId: 'txn-late' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'granted' });
    await harness.balance(merchant.orgId, 130);

    // An out-of-order decline arriving after the success must not undo it.
    await expect(
      callbacks.ingest(
        paymob.event(purchase.reference, {
          signal: 'decline',
          payment: { providerTransactionId: 'txn-stale' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'no_change' });
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'successful',
    });
    await harness.balance(merchant.orgId, 130);
  });

  it('quarantines an unmatched reference against no tenant at all', async () => {
    const before = await db.select().from(paymentPurchases);
    await expect(
      callbacks.ingest(paymob.event('akd_00000000000000000000000000000000')),
    ).resolves.toMatchObject({
      outcome: 'quarantined',
      resultCode: 'unmatched_reference',
    });
    expect(await db.select().from(paymentPurchases)).toHaveLength(
      before.length,
    );
  });

  it.each([
    ['amount', { amountMinor: 19999 }, 'amount_mismatch'],
    ['currency', { currency: 'USD' }, 'currency_mismatch'],
    ['integration', { integrationId: 'unknown' }, 'integration_mismatch'],
    ['mode', { mode: 'live' as const }, 'mode_mismatch'],
  ])(
    'quarantines a %s mismatch and grants nothing',
    async (_l, patch, code) => {
      const merchant = await buyer();
      const purchase = await pendingPurchase(merchant);
      await expect(
        callbacks.ingest(paymob.event(purchase.reference, patch)),
      ).resolves.toMatchObject({
        outcome: 'quarantined',
        resultCode: 'trusted_data_mismatch',
        errorCode: code,
      });
      await harness.balance(merchant.orgId, 30);
      expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
        status: 'pending',
        reconciliationRequired: true,
      });
    },
  );

  it('reverses a full refund, creating debt that blocks new holds but not top-ups', async () => {
    const merchant = await buyer(0);
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(paymob.event(purchase.reference));
    await harness.balance(merchant.orgId, 100);

    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'refund',
        refundedMinorTotal: 20000,
        sourceReference: 'refund-1',
        payment: { providerTransactionId: 'txn-refund' },
      }),
    );
    await harness.balance(merchant.orgId, 0);
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'refunded',
      refundedMinor: 20000,
    });

    // Debt blocks sends through the existing credit-denial path, and buying
    // more credits is still allowed -- that is how a merchant leaves debt.
    await expect(billing.readCredits(merchant.user)).resolves.toMatchObject({
      canPurchase: true,
    });
  });

  it('reverses an exact whole-credit partial refund and keeps the purchase successful', async () => {
    const merchant = await buyer(0);
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(paymob.event(purchase.reference));
    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'refund',
        refundedMinorTotal: 3000,
        sourceReference: 'refund-partial',
        payment: { providerTransactionId: 'txn-partial' },
      }),
    );
    await harness.balance(merchant.orgId, 85);
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'successful',
      refundedMinor: 3000,
      reconciliationRequired: false,
    });
  });

  it('records an odd partial refund for staff without reversing credits', async () => {
    const merchant = await buyer(0);
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(paymob.event(purchase.reference));
    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'refund',
        refundedMinorTotal: 3050,
        sourceReference: 'refund-odd',
        payment: { providerTransactionId: 'txn-odd' },
      }),
    );
    await harness.balance(merchant.orgId, 100);
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      refundedMinor: 3050,
      reconciliationRequired: true,
      reconciliationCode: 'partial_refund_not_whole_credit',
    });
  });

  it('reverses a chargeback once and reinstates it once', async () => {
    const merchant = await buyer(0);
    const purchase = await pendingPurchase(merchant);
    await callbacks.ingest(paymob.event(purchase.reference));

    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'chargeback_open',
        sourceReference: 'dispute-1',
        payment: { providerTransactionId: 'txn-cb-open' },
      }),
    );
    await harness.balance(merchant.orgId, 0);

    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'chargeback_lost',
        sourceReference: 'dispute-1',
        payment: { providerTransactionId: 'txn-cb-lost' },
      }),
    );
    await harness.balance(merchant.orgId, 0);

    await callbacks.ingest(
      paymob.event(purchase.reference, {
        signal: 'chargeback_won',
        sourceReference: 'dispute-1',
        payment: { providerTransactionId: 'txn-cb-won' },
      }),
    );
    await harness.balance(merchant.orgId, 100);
    const entries = await harness.ledger(merchant.orgId);
    expect(
      entries.filter((entry) => entry.type === 'chargeback_reversal'),
    ).toHaveLength(1);
    expect(
      entries.filter((entry) => entry.type === 'chargeback_reinstatement'),
    ).toHaveLength(1);
  });

  it('reuses a purchase for the same idempotency key and refuses a changed quantity', async () => {
    const merchant = await buyer();
    const first = await billing.createPurchase(
      merchant.user,
      'stable-key',
      100,
    );
    const replay = await billing.createPurchase(
      merchant.user,
      'stable-key',
      100,
    );
    expect(replay).toMatchObject({
      reference: first.reference,
      duplicate: true,
      checkoutUrl: null,
    });
    expect(
      paymob.checkouts.filter((c) => c.reference === first.reference),
    ).toHaveLength(1);
    await expect(
      billing.createPurchase(merchant.user, 'stable-key', 150),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_IDEMPOTENCY_CONFLICT' },
    });
  });

  it('recovers a lost checkout response through inquiry, and the real callback grants nothing more', async () => {
    const merchant = await buyer(0);
    paymob.nextCheckout('unknown');
    let reference = '';
    await expect(
      billing.createPurchase(merchant.user, 'lost-response-key', 100),
    ).rejects.toMatchObject({
      response: {
        code: 'BILLING_PROVIDER_UNAVAILABLE',
        reference: expect.stringMatching(/^akd_/) as string,
      },
    });
    const [pending] = await db.select().from(paymentPurchases);
    reference = (
      await db
        .select({ reference: paymentPurchases.reference })
        .from(paymentPurchases)
        .where(eq(paymentPurchases.orgId, merchant.orgId))
    )[0].reference;
    expect(pending).toBeDefined();

    // The purchase is pending and due, so an inquiry is allowed to run.
    await db
      .update(paymentPurchases)
      .set({ nextReconciliationAt: null })
      .where(eq(paymentPurchases.reference, reference));
    paymob.nextInquiry(paymob.foundInquiry(reference));
    await expect(
      reconciliation.reconcile(merchant.orgId, reference),
    ).resolves.toMatchObject({ outcome: 'resolved' });
    await harness.balance(merchant.orgId, 100);

    // The callback finally arrives. Same transaction, same fingerprint.
    await expect(
      callbacks.ingest(paymob.event(reference)),
    ).resolves.toMatchObject({ outcome: 'duplicate' });
    await harness.balance(merchant.orgId, 100);
  });

  it('expires a stale purchase only when the provider confirms no record', async () => {
    const merchant = await buyer();
    const purchase = await pendingPurchase(merchant);
    await db
      .update(paymentPurchases)
      .set({
        checkoutExpiresAt: '2000-01-01T00:00:00.000Z',
        nextReconciliationAt: null,
      })
      .where(eq(paymentPurchases.reference, purchase.reference));

    paymob.nextInquiry({ outcome: 'unknown', code: 'provider_unavailable' });
    await expect(
      reconciliation.reconcile(merchant.orgId, purchase.reference),
    ).resolves.toMatchObject({ outcome: 'deferred' });
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'pending',
    });

    await db
      .update(paymentPurchases)
      .set({ nextReconciliationAt: null })
      .where(eq(paymentPurchases.reference, purchase.reference));
    paymob.nextInquiry({ outcome: 'not_found', code: 'not_found' });
    await expect(
      reconciliation.reconcile(merchant.orgId, purchase.reference),
    ).resolves.toMatchObject({ outcome: 'expired' });
    expect(await harness.purchaseRow(purchase.reference)).toMatchObject({
      status: 'expired',
    });
    await harness.balance(merchant.orgId, 30);
  });

  it('keeps every read organization-scoped', async () => {
    const mine = await buyer();
    const theirs = await buyer();
    const purchase = await pendingPurchase(theirs);
    await expect(
      billing.readPurchase(mine.user, purchase.reference),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_PURCHASE_NOT_FOUND' },
    });
    const page = await billing.listPurchases(mine.user, {});
    expect(
      page.items.some((item) => item.reference === purchase.reference),
    ).toBe(false);
  });

  it('pages the ledger without repeating or dropping an entry', async () => {
    const merchant = await buyer();
    for (let index = 0; index < 3; index += 1) {
      const purchase = await pendingPurchase(merchant);
      await callbacks.ingest(paymob.event(purchase.reference));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await billing.listLedger(merchant.user, {
        limit: 2,
        cursor,
      });
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength((await harness.ledger(merchant.orgId)).length);
  });

  it('refuses a Shopify organization and leaves its usage untouched', async () => {
    const shopify = await harness.merchant(0, 'shopify');
    await expect(
      billing.createPurchase(shopify.user, 'shopify-key', 100),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_SOURCE_UNSUPPORTED' },
    });
    expect(
      await db
        .select()
        .from(paymentPurchases)
        .where(eq(paymentPurchases.orgId, shopify.orgId)),
    ).toHaveLength(0);
  });
});

/**
 * The payment spoke and the billing module are one-way dependencies. Verification,
 * orders and messaging must never learn that a payment provider exists.
 */
describe('payment boundary', () => {
  const ROOT = resolve(__dirname, '../src');
  const FORBIDDEN = ['spokes/paymob', 'modules/billing'];
  const ISOLATED = [
    'modules/verification-core',
    'modules/verifications',
    'modules/verification-automation',
    'modules/orders',
    'modules/webhook-queue',
    'infrastructure/spokes/meta',
    'infrastructure/spokes/shopify',
  ];

  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
  }

  /**
   * Import specifiers only. Matching raw text would flag the very comments that
   * explain the boundary, which is exactly backwards.
   */
  function imports(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)].map(
      (match) => match[1] ?? match[2],
    );
  }

  function offendersIn(area: string, forbidden: string[]): string[] {
    return walk(join(ROOT, area)).filter((file) =>
      imports(file).some((specifier) =>
        forbidden.some((needle) => specifier.includes(needle)),
      ),
    );
  }

  it.each(ISOLATED)('%s imports no payment module', (area) => {
    expect(offendersIn(area, FORBIDDEN)).toEqual([]);
  });

  it('the Paymob spoke reaches for no database and no billing module', () => {
    expect(
      offendersIn('infrastructure/spokes/paymob', [
        'modules/billing',
        'database/repositories',
        'database/schema',
      ]),
    ).toEqual([]);
  });
});
