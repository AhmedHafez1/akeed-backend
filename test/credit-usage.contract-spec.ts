import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import {
  creditAccounts,
  creditLedgerEntries,
  verificationMessageDispatches,
  verifications,
  adminAccessAudit,
  integrationMonthlyUsage,
} from '../src/infrastructure/database/schema';

const harness = creditUsageHarness();
const { db, dispatches, merchant, verification, acceptance, balance } = harness;

async function claim(input: Awaited<ReturnType<typeof verification>>) {
  const result = await dispatches.claim(input);
  if (result.outcome !== 'claimed')
    throw new Error(`Expected claim, received ${result.outcome}`);
  return result.dispatch;
}

describe('US-04.5-03 PostgreSQL usage accounting', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);
  afterEach(() => jest.restoreAllMocks());

  it('serializes the last credit across distinct sends and isolates organizations', async () => {
    const source = await merchant(1);
    const inputs = await Promise.all([
      verification(source),
      verification(source),
    ]);
    const results = await Promise.all(
      inputs.map((input) => dispatches.claim(input)),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'blocked',
      'claimed',
    ]);
    expect(
      results.find((result) => result.outcome === 'blocked'),
    ).toMatchObject({ reason: 'INSUFFICIENT_CREDITS' });
    await balance(source.orgId, 1, 1);
    const other = await merchant(1);
    await claim(await verification(other));
    await balance(other.orgId, 1, 1);
  });

  it('reuses a duplicate dispatch and consumes initial/follow-up separately exactly once', async () => {
    const source = await merchant(3);
    const input = await verification(source);
    const results = await Promise.all([
      dispatches.claim(input),
      dispatches.claim(input),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'busy',
      'claimed',
    ]);
    const claimed = results.find((result) => result.outcome === 'claimed')!;
    if (claimed.outcome !== 'claimed') throw new Error('Missing claim');
    const messageId = randomUUID();
    await Promise.all([
      acceptance(claimed.dispatch, messageId),
      acceptance(claimed.dispatch, messageId),
    ]);
    await balance(source.orgId, 2, 0);
    const follow = await dispatches.claim({ ...input, kind: 'follow_up' });
    if (follow.outcome !== 'claimed') throw new Error('Missing follow-up');
    const followMessageId = randomUUID();
    await acceptance(follow.dispatch, followMessageId);
    await acceptance(follow.dispatch, followMessageId);
    await balance(source.orgId, 1, 0);
    const [result] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, input.verificationId));
    expect(result.followUpAttempts).toBe(1);
    await db
      .update(verifications)
      .set({ status: 'no_reply' })
      .where(eq(verifications.id, input.verificationId));
    await balance(source.orgId, 1, 0);
  });

  it('keeps exception/missing-id ambiguity held and never resends an expired lease', async () => {
    const source = await merchant(2);
    const input = await verification(source);
    const first = await claim({ ...input, leaseUntil: '2000-01-01T00:00:00Z' });
    expect(await dispatches.claim(input)).toMatchObject({
      outcome: 'outcome_unknown',
    });
    expect(await dispatches.claim(input)).toMatchObject({
      outcome: 'outcome_unknown',
    });
    await balance(source.orgId, 2, 1);
    const second = await claim(await verification(source));
    await dispatches.markFailedProviderOutcome(
      second.id,
      'missing_provider_message_id',
    );
    await balance(source.orgId, 2, 2);
    await acceptance(first);
    await balance(source.orgId, 1, 1);
  });

  it('records receipts for a salvaged ambiguous send without moving credits', async () => {
    const source = await merchant(2);
    const input = await verification(source);
    const dispatch = await claim(input);
    const providerMessageId = randomUUID();
    // Reproduce `VerificationSendService.salvageAcceptance`: the provider
    // returned a message id, persisting the acceptance failed, so the dispatch
    // parks at `outcome_unknown` while the credit stays held. Meta still
    // reports delivery on that message id, and refusing those receipts threw
    // out of the status handler and stalled the whole webhook batch.
    expect(
      await dispatches.markOutcomeUnknown(
        dispatch.id,
        'acceptance_persistence_failed',
        providerMessageId,
      ),
    ).toBe(1);
    await dispatches.projectAcceptanceWithoutLedger({
      verificationId: input.verificationId,
      kind: input.kind,
      providerMessageId,
      sentAt: new Date().toISOString(),
    });

    const delivered = await dispatches.recordProviderStatus(
      dispatch.id,
      'delivered',
      new Date().toISOString(),
    );
    expect(delivered?.verificationRows).toHaveLength(1);
    const failed = await dispatches.recordProviderStatus(
      dispatch.id,
      'failed',
      new Date().toISOString(),
    );
    expect(failed?.verificationRows).toHaveLength(1);
    // Nothing was ever posted, so there is nothing to reverse: the hold stands
    // and the ledger carries only the opening grant.
    await balance(source.orgId, 2, 1);
    expect(
      await db
        .select()
        .from(creditLedgerEntries)
        .where(eq(creditLedgerEntries.orgId, source.orgId)),
    ).toMatchObject([{ type: 'free_grant' }]);

    // Staff resolution is still the only thing that settles the hold.
    await acceptance(dispatch, providerMessageId);
    await balance(source.orgId, 1, 0);
  });

  it('releases confirmed rejection without posting and advances the immutable generation', async () => {
    const source = await merchant(1);
    const input = await verification(source);
    const first = await claim(input);
    await dispatches.resolveNotAccepted(first.id, undefined, true);
    await dispatches.resolveNotAccepted(first.id, undefined, true);
    await balance(source.orgId, 1, 0);
    const next = await claim(input);
    expect(next).toMatchObject({
      generation: 2,
      dispatchKey: `${input.verificationId}:initial:2`,
    });
    expect(next.id).not.toBe(first.id);
    await balance(source.orgId, 1, 1);
    expect(
      await dispatches.markAccepted({
        dispatchId: first.id,
        providerMessageId: randomUUID(),
        sentAt: new Date().toISOString(),
      }),
    ).toMatchObject({ outcome: 'unacceptable_state' });
  });

  it('reverses delivery failure once, rejects stale receipts, and keeps prior acceptance facts', async () => {
    const source = await merchant(1);
    const input = await verification(source);
    const first = await claim(input);
    await acceptance(first);
    const failedAt = new Date(Date.now() + 1000).toISOString();
    await Promise.all([
      dispatches.recordProviderStatus(first.id, 'failed', failedAt),
      dispatches.recordProviderStatus(first.id, 'failed', failedAt),
    ]);
    await balance(source.orgId, 1, 0);
    const next = await claim(input);
    expect(next.generation).toBe(2);
    await acceptance(next);
    await dispatches.recordProviderStatus(first.id, 'failed', failedAt);
    await acceptance(first);
    await balance(source.orgId, 0, 0);
    const [old] = await db
      .select()
      .from(verificationMessageDispatches)
      .where(eq(verificationMessageDispatches.id, first.id));
    expect(old.acceptedAt).not.toBeNull();
    expect(old.state).toBe('accepted');
    const entries = await db
      .select()
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.orgId, source.orgId));
    expect(
      entries.filter((entry) => entry.type === 'failure_reversal'),
    ).toHaveLength(1);
  });

  it('does not reverse a stale failure predating acceptance or a delivered/read message', async () => {
    const source = await merchant(1);
    const first = await claim(await verification(source));
    await acceptance(first);
    await dispatches.recordProviderStatus(
      first.id,
      'failed',
      '2000-01-01T00:00:00Z',
    );
    await dispatches.recordProviderStatus(
      first.id,
      'read',
      new Date().toISOString(),
    );
    await dispatches.recordProviderStatus(
      first.id,
      'failed',
      new Date(Date.now() + 1000).toISOString(),
    );
    await balance(source.orgId, 0, 0);
  });

  it.each(['accepted', 'not_accepted'] as const)(
    'commits %s staff resolution and audit exactly once',
    async (resolution) => {
      const source = await merchant(1);
      const first = await claim(await verification(source));
      await dispatches.markFailedProviderOutcome(
        first.id,
        'provider_exception',
      );
      const staffAudit = {
        userId: randomUUID(),
        reason: 'Synthetic reviewed provider evidence',
      };
      const apply = () =>
        resolution === 'accepted'
          ? dispatches.markAccepted({
              dispatchId: first.id,
              providerMessageId: `wamid-${first.id}`,
              sentAt: new Date().toISOString(),
              staffAudit,
            })
          : dispatches.resolveNotAccepted(first.id, staffAudit);
      await Promise.all([apply(), apply()]);
      await balance(source.orgId, resolution === 'accepted' ? 0 : 1, 0);
      const audit = await db
        .select()
        .from(adminAccessAudit)
        .where(eq(adminAccessAudit.userId, staffAudit.userId));
      expect(audit).toHaveLength(1);
    },
  );

  it('finishes holds despite later debt, suspension and feature disablement', async () => {
    const source = await merchant(2);
    const first = await claim(await verification(source));
    const secondInput = await verification(source);
    const second = await claim(secondInput);
    await harness.adjust(source.orgId, -3);
    const input = await verification(source);
    expect(await dispatches.claim(input)).toMatchObject({
      outcome: 'blocked',
      reason: 'CREDIT_DEBT_OUTSTANDING',
    });
    await db
      .update(creditAccounts)
      .set({ status: 'suspended', version: sql`${creditAccounts.version} + 1` })
      .where(eq(creditAccounts.orgId, source.orgId));
    await harness.disabled.markAccepted({
      dispatchId: first.id,
      providerMessageId: randomUUID(),
      sentAt: new Date().toISOString(),
    });
    await harness.disabled.resolveNotAccepted(second.id, undefined, true);
    await balance(source.orgId, -2, 0);
    // Rolling the feature back returns a Standalone source to the periodic plan
    // it shipped with rather than blocking it behind a reconciliation code, so
    // a fresh send is refused by that plan's own limit and takes no hold.
    expect(await harness.disabled.claim(input)).toMatchObject({
      outcome: 'blocked',
      reason: 'plan_limit_reached',
    });
    // A dispatch already bound to credits is never re-billed on the monthly
    // plan; it stays parked for reconciliation instead.
    expect(await harness.disabled.claim(secondInput)).toMatchObject({
      outcome: 'blocked',
      reason: 'PAYMENT_PENDING_RECONCILIATION',
    });
    await balance(source.orgId, -2, 0);
  });

  it('blocks cutover until legacy ambiguity is reviewed without retroactive charging', async () => {
    const source = await merchant(2);
    const legacyInput = await verification(source);
    const [legacy] = await db
      .insert(verificationMessageDispatches)
      .values({
        ...source,
        verificationId: legacyInput.verificationId,
        dispatchKey: `${legacyInput.verificationId}:initial:1`,
        kind: 'initial',
        state: 'outcome_unknown',
        accountingMode: 'periodic_plan',
      })
      .returning();
    const input = await verification(source);
    expect(await dispatches.claim(input)).toMatchObject({
      outcome: 'blocked',
      reason: 'PAYMENT_PENDING_RECONCILIATION',
    });
    await dispatches.resolveNotAccepted(legacy.id, {
      userId: randomUUID(),
      reason: 'Reviewed historical rejection',
    });
    await claim(input);
    await balance(source.orgId, 2, 1);
  });

  it('fails closed on a projection mismatch', async () => {
    const source = await merchant(2);
    await db
      .update(creditAccounts)
      .set({ postedBalance: 3, version: 2 })
      .where(eq(creditAccounts.orgId, source.orgId));
    await expect(
      dispatches.claim(await verification(source)),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_PENDING_RECONCILIATION' },
    });
  });

  it.each(['ledger', 'reservation', 'projection'] as const)(
    'rolls back acceptance after an injected %s failure',
    async (boundary) => {
      const source = await merchant(1);
      const first = await claim(await verification(source));
      const method =
        boundary === 'ledger'
          ? 'insertLedgerEntry'
          : boundary === 'reservation'
            ? 'resolveReservation'
            : 'updateProjection';
      jest
        .spyOn(harness.credits, method)
        .mockRejectedValueOnce(new Error('Injected database write failure'));
      await expect(acceptance(first)).rejects.toThrow(
        'Injected database write failure',
      );
      await balance(source.orgId, 1, 1);
      const [row] = await db
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, first.id));
      expect(row.state).toBe('sending');
      await acceptance(first);
      await balance(source.orgId, 0, 0);
    },
  );

  it('rolls back accounting and verification when the audit insert fails', async () => {
    const source = await merchant(1);
    const first = await claim(await verification(source));
    await dispatches.markFailedProviderOutcome(first.id, 'provider_exception');
    await harness.client.unsafe(
      "ALTER TABLE admin_access_audit ADD CONSTRAINT injected_audit_failure CHECK (action <> 'message-dispatch.resolve') NOT VALID",
    );
    try {
      await expect(
        dispatches.markAccepted({
          dispatchId: first.id,
          providerMessageId: randomUUID(),
          sentAt: new Date().toISOString(),
          staffAudit: { userId: randomUUID(), reason: 'Fault injection' },
        }),
      ).rejects.toBeDefined();
      await balance(source.orgId, 1, 1);
    } finally {
      await harness.client.unsafe(
        'ALTER TABLE admin_access_audit DROP CONSTRAINT injected_audit_failure',
      );
    }
  });

  it('keeps Shopify periodic accounting independent of credit tables and flags', async () => {
    const source = await merchant(1, 'shopify');
    const input = await verification(source);
    jest
      .spyOn(harness.credits, 'lockAccount')
      .mockRejectedValue(new Error('Shopify must never access credits'));
    const first = await harness.disabled.claim(input);
    if (first.outcome !== 'claimed') throw new Error('Expected periodic claim');
    expect(first.dispatch.accountingMode).toBe('periodic_plan');
    await harness.disabled.markFailedProviderOutcome(
      first.dispatch.id,
      'provider_exception',
    );
    const [usage] = await db
      .select()
      .from(integrationMonthlyUsage)
      .where(eq(integrationMonthlyUsage.orgId, source.orgId));
    expect(usage.consumedCount).toBe(0);
    await harness.disabled.markAccepted({
      dispatchId: first.dispatch.id,
      providerMessageId: randomUUID(),
      sentAt: new Date().toISOString(),
    });
    const [restored] = await db
      .select()
      .from(integrationMonthlyUsage)
      .where(eq(integrationMonthlyUsage.orgId, source.orgId));
    expect(restored.consumedCount).toBe(1);
  });
});
