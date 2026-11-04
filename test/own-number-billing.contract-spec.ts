import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { StandaloneBillingOperationsRepository } from '../src/modules/admin/standalone-billing-operations.repository';
import {
  creditAccounts,
  creditLedgerEntries,
  integrationMonthlyUsage,
  verificationMessageDispatches,
  whatsappConnections,
} from '../src/infrastructure/database/schema';
import type { ResolvedSender } from '../src/shared/ports/sender-resolver.port';

const harness = creditUsageHarness();
const { db, merchant, verification, credits } = harness;
const config = { get: () => 'shared-phone' };
const dispatches = new VerificationMessageDispatchesRepository(
  db,
  harness.router,
  config as never,
);
const usage = new IntegrationMonthlyUsageRepository(db as never);
const operations = new StandaloneBillingOperationsRepository(db, credits);

async function ownSender(orgId: string): Promise<ResolvedSender> {
  const [connection] = await db
    .insert(whatsappConnections)
    .values({
      orgId,
      wabaId: randomUUID(),
      phoneNumberId: randomUUID(),
      signupPath: 'coexistence',
      state: 'active',
      businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
    })
    .returning();
  return {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
}

type ClaimInput = Parameters<typeof dispatches.claim>[0];

async function claim(input: ClaimInput) {
  const result = await dispatches.claim(input);
  if (result.outcome !== 'claimed')
    throw new Error(`Expected claim: ${result.outcome}`);
  return result.dispatch;
}

async function account(orgId: string) {
  const [row] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.orgId, orgId));
  return {
    posted: row.postedBalance,
    held: row.heldCredits,
    spare: row.spareCredit,
  };
}

async function ownLedger(orgId: string) {
  const rows = await db
    .select({
      type: creditLedgerEntries.type,
      quantity: creditLedgerEntries.quantity,
    })
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.orgId, orgId));
  return rows.filter((row) => row.type.startsWith('own_number'));
}

async function reconciled(orgId: string) {
  const report = await operations.readReconciliation(orgId);
  expect(report).toMatchObject({ consistent: true, contradictions: [] });
}

async function failReceipt(dispatch: { id: string }) {
  return dispatches.recordProviderStatus(
    dispatch.id,
    'failed',
    new Date(Date.now() + 1000).toISOString(),
    { code: 131000 },
  );
}

async function pools(integrationId: string) {
  const [row] = await db
    .select()
    .from(integrationMonthlyUsage)
    .where(eq(integrationMonthlyUsage.integrationId, integrationId));
  return row
    ? { akeed: row.consumedCount, own: row.ownNumberConsumed, row }
    : undefined;
}

async function setPools(
  integrationId: string,
  akeed: number,
  own: number,
): Promise<void> {
  await db
    .update(integrationMonthlyUsage)
    .set({ consumedCount: akeed, ownNumberConsumed: own })
    .where(eq(integrationMonthlyUsage.integrationId, integrationId));
}

describe('own-number billing PostgreSQL contract', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);

  describe('prepaid credits', () => {
    it('charges two own-number sends exactly one stored credit, on the first', async () => {
      const source = await merchant(3);
      const sender = await ownSender(source.orgId);
      const first = await claim({ ...(await verification(source)), sender });
      expect(first).toMatchObject({ billingPool: 'credits', billingCost: 1 });
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 0,
        spare: 1,
      });
      const second = await claim({ ...(await verification(source)), sender });
      expect(second).toMatchObject({ billingPool: 'credits', billingCost: 1 });
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 0,
        spare: 0,
      });
      expect(await ownLedger(source.orgId)).toEqual([
        { type: 'own_number_pack', quantity: -1 },
      ]);
      // Acceptance moves nothing: the charge was taken at claim time.
      await harness.acceptance(first);
      await harness.acceptance(second);
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 0,
        spare: 0,
      });
      await reconciled(source.orgId);
    });

    it('returns each failed send once, and two returns make a stored credit again', async () => {
      const source = await merchant(3);
      const sender = await ownSender(source.orgId);
      const first = await claim({ ...(await verification(source)), sender });
      const second = await claim({ ...(await verification(source)), sender });
      await harness.acceptance(first);
      await harness.acceptance(second);
      // The second send failing returns its half: a spare.
      await failReceipt(second);
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 0,
        spare: 1,
      });
      // A duplicate receipt returns nothing more.
      await failReceipt(second);
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 0,
        spare: 1,
      });
      // The first send, which opened the pack, failing completes the pair.
      await failReceipt(first);
      await failReceipt(first);
      expect(await account(source.orgId)).toEqual({
        posted: 3,
        held: 0,
        spare: 0,
      });
      expect(await ownLedger(source.orgId)).toEqual([
        { type: 'own_number_pack', quantity: -1 },
        { type: 'own_number_pack_reversal', quantity: 1 },
      ]);
      await reconciled(source.orgId);
    });

    it('returns a send the provider refused, and allows the next attempt', async () => {
      const source = await merchant(1);
      const sender = await ownSender(source.orgId);
      const input = await verification(source);
      const attempt = await claim({ ...input, sender });
      // The attempt opened a pack and left the spare; returning it pairs the
      // two halves back into the stored credit.
      await dispatches.resolveNotAccepted(attempt.id, undefined, true);
      await dispatches.resolveNotAccepted(attempt.id, undefined, true);
      expect(await account(source.orgId)).toEqual({
        posted: 1,
        held: 0,
        spare: 0,
      });
      const retry = await claim({ ...input, sender });
      expect(retry).toMatchObject({ generation: 2, billingCost: 1 });
      expect(await account(source.orgId)).toEqual({
        posted: 0,
        held: 0,
        spare: 1,
      });
      await reconciled(source.orgId);
    });

    it('serializes concurrent own-number sends on the last stored credit', async () => {
      const source = await merchant(1);
      const sender = await ownSender(source.orgId);
      const inputs = await Promise.all(
        Array.from({ length: 4 }, () => verification(source)),
      );
      const results = await Promise.allSettled(
        inputs.map((input) => dispatches.claim({ ...input, sender })),
      );
      const outcomes = results.map((result) =>
        result.status === 'fulfilled'
          ? result.value.outcome === 'blocked'
            ? result.value.reason
            : result.value.outcome
          : 'error',
      );
      expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(
        2,
      );
      expect(
        outcomes.filter((outcome) => outcome === 'INSUFFICIENT_CREDITS'),
      ).toHaveLength(2);
      expect(await account(source.orgId)).toEqual({
        posted: 0,
        held: 0,
        spare: 0,
      });
      await reconciled(source.orgId);
    });

    it('mixes senders: a spare pays for an own-number send but not an Akeed one', async () => {
      const source = await merchant(2);
      const sender = await ownSender(source.orgId);
      await claim({ ...(await verification(source)), sender });
      const akeed = await claim(await verification(source));
      expect(akeed).toMatchObject({
        senderKind: 'akeed_system',
        billingPool: 'credits',
        billingCost: 2,
      });
      expect(await account(source.orgId)).toEqual({
        posted: 1,
        held: 1,
        spare: 1,
      });
      expect(await dispatches.claim(await verification(source))).toMatchObject({
        outcome: 'blocked',
        reason: 'INSUFFICIENT_CREDITS',
      });
      await claim({ ...(await verification(source)), sender });
      expect(await account(source.orgId)).toEqual({
        posted: 1,
        held: 1,
        spare: 0,
      });
      // The Akeed send still settles through its reservation, unchanged.
      await harness.acceptance(akeed);
      expect(await account(source.orgId)).toEqual({
        posted: 0,
        held: 0,
        spare: 0,
      });
      await reconciled(source.orgId);
    });

    it('charges a fallback what is left and never blocks it on balance (D4)', async () => {
      const source = await merchant(1);
      const sender = await ownSender(source.orgId);
      await claim({ ...(await verification(source)), sender });
      const spareFallback = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(spareFallback).toMatchObject({
        senderKind: 'akeed_system',
        billingPool: 'credits',
        billingCost: 1,
      });
      const freeFallback = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(freeFallback).toMatchObject({ billingCost: 0 });
      expect(await account(source.orgId)).toEqual({
        posted: 0,
        held: 0,
        spare: 0,
      });
      // A standard send with nothing left is still refused.
      expect(await dispatches.claim(await verification(source))).toMatchObject({
        outcome: 'blocked',
        reason: 'INSUFFICIENT_CREDITS',
      });
      // Returning a cost-0 fallback moves nothing.
      await dispatches.resolveNotAccepted(freeFallback.id, undefined, true);
      expect(await account(source.orgId)).toEqual({
        posted: 0,
        held: 0,
        spare: 0,
      });
      await reconciled(source.orgId);
    });

    it('takes a fallback through the reservation while a stored credit is left', async () => {
      const source = await merchant(2);
      const fallback = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(fallback).toMatchObject({ billingCost: 2 });
      expect(await account(source.orgId)).toEqual({
        posted: 2,
        held: 1,
        spare: 0,
      });
    });

    it('refuses a new generation over an own-number charge that was never returned', async () => {
      const source = await merchant(2);
      const sender = await ownSender(source.orgId);
      const input = await verification(source);
      const attempt = await claim({ ...input, sender });
      // Simulates a broken writer that rejected the send without refunding it.
      await harness.client.unsafe(
        `UPDATE "${harness.namespace}".verification_message_dispatches SET state = 'rejected' WHERE id = $1`,
        [attempt.id],
      );
      await expect(
        harness.client.unsafe(
          `INSERT INTO "${harness.namespace}".verification_message_dispatches (org_id, integration_id, verification_id, dispatch_key, generation, accounting_mode, kind, state) VALUES ($1, $2, $3, $4, 2, 'prepaid_credit', 'initial', 'ready')`,
          [
            source.orgId,
            source.integrationId,
            input.verificationId,
            `${input.verificationId}:initial:2`,
          ],
        ),
      ).rejects.toThrow('Preceding own-number charge must be refunded');
      await expect(
        dispatches.claim({ ...input, sender }),
      ).rejects.toMatchObject({
        response: { code: 'PAYMENT_PENDING_RECONCILIATION' },
      });
    });

    it('keeps a recorded charge immutable', async () => {
      const source = await merchant(2);
      const sender = await ownSender(source.orgId);
      const charged = await claim({ ...(await verification(source)), sender });
      await expect(
        db
          .update(verificationMessageDispatches)
          .set({ billingCost: 0 })
          .where(eq(verificationMessageDispatches.id, charged.id)),
      ).rejects.toThrow();
      await dispatches.resolveNotAccepted(charged.id, undefined, true);
      await expect(
        db
          .update(verificationMessageDispatches)
          .set({ billingRefundedAt: null })
          .where(eq(verificationMessageDispatches.id, charged.id)),
      ).rejects.toThrow();
    });

    it('reports a spare that disagrees with its charges for staff', async () => {
      const source = await merchant(2);
      const sender = await ownSender(source.orgId);
      await claim({ ...(await verification(source)), sender });
      await db.transaction(async (tx) => {
        const locked = await credits.lockAccount(tx, source.orgId);
        await credits.updateProjection(tx, {
          orgId: source.orgId,
          expectedVersion: locked.version,
          postedBalance: locked.postedBalance,
          heldCredits: locked.heldCredits,
          spareCredit: 0,
        });
      });
      const report = await operations.readReconciliation(source.orgId);
      expect(report?.contradictions).toEqual([
        { code: 'spare_credit_mismatch', expectedSpare: 1, spareCredit: 0 },
      ]);
    });
  });

  describe('Shopify pools', () => {
    it('draws the own pool first, then the Akeed pool (D11), then blocks', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      const own = await claim({ ...(await verification(source)), sender });
      expect(own).toMatchObject({
        usageReserved: true,
        billingPool: 'own_number',
        billingCost: 1,
      });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 0,
        own: 1,
      });
      // Starter is one-time: 30 Akeed and 90 own-number messages.
      await setPools(source.integrationId, 0, 90);
      const fromAkeed = await claim({
        ...(await verification(source)),
        sender,
      });
      expect(fromAkeed).toMatchObject({
        senderKind: 'merchant_own',
        billingPool: 'akeed',
        billingCost: 1,
      });
      await setPools(source.integrationId, 30, 90);
      expect(
        await dispatches.claim({ ...(await verification(source)), sender }),
      ).toMatchObject({ outcome: 'blocked', reason: 'plan_limit_reached' });
    });

    it('keeps Akeed-number sends on the Akeed pool exactly as before', async () => {
      const source = await merchant(0, 'shopify');
      const result = await dispatches.claim(await verification(source));
      expect(result).toMatchObject({
        outcome: 'claimed',
        usage: { consumedBefore: 0, consumedAfter: 1, includedLimit: 30 },
        dispatch: { billingPool: 'akeed', billingCost: 1 },
      });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 1,
        own: 0,
      });
    });

    it('charges a fallback the Akeed pool, then 3 own-number messages or what is left (D4)', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      await claim({ ...(await verification(source)), sender });
      const akeed = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(akeed).toMatchObject({ billingPool: 'akeed', billingCost: 1 });
      await setPools(source.integrationId, 30, 10);
      const three = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(three).toMatchObject({
        billingPool: 'own_number',
        billingCost: 3,
      });
      await setPools(source.integrationId, 30, 88);
      const two = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(two).toMatchObject({ billingPool: 'own_number', billingCost: 2 });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 30,
        own: 90,
      });
      const free = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(free).toMatchObject({ billingPool: 'own_number', billingCost: 0 });
    });

    it('returns and restores usage to the pool it came from, once', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      await setPools(source.integrationId, 0, 0);
      await claim({ ...(await verification(source)), sender });
      await setPools(source.integrationId, 30, 10);
      const fallback = await claim({
        ...(await verification(source)),
        chargeRule: 'fallback',
      });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 30,
        own: 13,
      });
      await dispatches.markFailedProviderOutcome(fallback.id, 'synthetic');
      await dispatches.markFailedProviderOutcome(fallback.id, 'synthetic');
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 30,
        own: 10,
      });
      // Staff confirm it was sent after all: the 3 come back, to the own pool.
      await dispatches.markAccepted({
        dispatchId: fallback.id,
        providerMessageId: randomUUID(),
        sentAt: new Date().toISOString(),
      });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 30,
        own: 13,
      });
    });

    it('returns a failed own-number receipt to the own pool, and ignores a duplicate', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      const own = await claim({ ...(await verification(source)), sender });
      await harness.acceptance(own);
      await failReceipt(own);
      await failReceipt(own);
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 0,
        own: 0,
      });
    });

    it('resets both pools together on a plan change', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      await claim({ ...(await verification(source)), sender });
      await claim(await verification(source));
      const before = await pools(source.integrationId);
      expect(before).toMatchObject({ akeed: 1, own: 1 });
      await usage.resetCountersForPeriod({
        integrationId: source.integrationId,
        periodStart: before!.row.periodStart,
        includedLimit: 300,
      });
      expect(await pools(source.integrationId)).toMatchObject({
        akeed: 0,
        own: 0,
        row: { includedLimit: 300 },
      });
    });

    it('keeps the recorded pool on a row whose usage was released', async () => {
      const source = await merchant(0, 'shopify');
      const sender = await ownSender(source.orgId);
      const input = await verification(source);
      const first = await claim({ ...input, sender });
      await dispatches.resolveNotAccepted(first.id, undefined, true);
      expect(await pools(source.integrationId)).toMatchObject({ own: 0 });
      const [row] = await db
        .select()
        .from(verificationMessageDispatches)
        .where(
          and(
            eq(verificationMessageDispatches.id, first.id),
            eq(verificationMessageDispatches.orgId, source.orgId),
          ),
        );
      expect(row).toMatchObject({
        state: 'rejected',
        billingPool: 'own_number',
        usageReserved: false,
      });
    });
  });
});
