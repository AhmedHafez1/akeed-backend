/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { WhatsappConnectionsRepository } from '../src/infrastructure/database/repositories/whatsapp-connections.repository';
import { WhatsappConnectionTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import {
  verificationMessageDispatches,
  verificationSenderAttempts,
  whatsappConnections,
  whatsappTemplates,
  verifications,
  orders,
  integrations,
  integrationMonthlyUsage,
  creditAccounts,
} from '../src/infrastructure/database/schema';
import { classifyOwnNumberFailure } from '../src/infrastructure/spokes/meta/own-number/own-number-send-failure.policy';
import {
  FEATURE_OFF_SENDER,
  type ResolvedSender,
} from '../src/shared/ports/sender-resolver.port';
import type { SelectedCodTemplate } from '../src/shared/messaging/cod-template-selector';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { seededTemplateRegistry } from '../src/shared/messaging/testing/seeded-template-registry';
import { MerchantMessageFailure } from '../src/shared/ports/sender-recovery.port';
import type { MessagingPort } from '../src/shared/ports/messaging.port';

const h = creditUsageHarness();
const { db } = h;
const repo = new VerificationMessageDispatchesRepository(db, h.router, {
  get: () => 'shared-phone',
} as never);
const connections = new WhatsappConnectionsRepository(db as never);
const templates = new WhatsappConnectionTemplatesRepository(db as never);
const selected: SelectedCodTemplate = {
  registryKey: 'recovery.en.direct',
  variantKey: 'en.direct',
  language: 'en',
  templateName: 'recovery_template',
  languageCode: 'en',
  parameterFormat: 'named',
  variables: [],
};
const future = () => new Date(Date.now() + 600_000).toISOString();
const now = () => new Date().toISOString();

async function fixture(platform: string, balance = 3) {
  const source = await h.merchant(balance, platform);
  const [connection] = await db
    .insert(whatsappConnections)
    .values({
      orgId: source.orgId,
      wabaId: '1000',
      phoneNumberId: randomUUID(),
      signupPath: 'coexistence',
      state: 'active',
      businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
    })
    .returning();
  const sender: ResolvedSender = {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
  const input = await h.verification(source);
  const claim = await repo.claim({
    ...input,
    templateName: selected.templateName,
    sender,
  });
  if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
  const attempt = await repo.beginMerchantAttempt(
    source.orgId,
    claim.dispatch.id,
    selected,
  );
  if (!attempt) throw new Error('Expected initial attempt');
  expect(
    await repo.authorizeMerchantAttempt(
      source.orgId,
      claim.dispatch.id,
      attempt,
    ),
  ).toBe(true);
  return {
    source,
    connection,
    sender,
    input,
    dispatch: claim.dispatch,
    attempt,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function root(f: Fixture) {
  return await repo.findSenderRecovery(f.source.orgId, f.dispatch.id);
}
async function charged(f: Fixture) {
  if (f.dispatch.accountingMode === 'prepaid_credit') {
    const [row] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, f.source.orgId));
    return {
      posted: row.postedBalance,
      held: row.heldCredits,
      spare: row.spareCredit,
    };
  }
  const [row] = await db
    .select()
    .from(integrationMonthlyUsage)
    .where(eq(integrationMonthlyUsage.integrationId, f.source.integrationId));
  return { akeed: row.consumedCount, own: row.ownNumberConsumed };
}
async function fail(f: Fixture, code: number, attempt = f.attempt) {
  await repo.failMerchantAttempt(
    f.source.orgId,
    f.dispatch.id,
    attempt,
    classifyOwnNumberFailure({ code }),
  );
}
async function due(f: Fixture) {
  await db
    .update(verificationMessageDispatches)
    .set({ senderRecoveryDueAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(verificationMessageDispatches.id, f.dispatch.id));
}
async function fallback(f: Fixture) {
  return repo.claim({
    ...f.input,
    sender: {
      ...FEATURE_OFF_SENDER,
      reason: `send_failed:${(await root(f)).lastErrorCode}`,
    },
    chargeRule: 'fallback',
    fallbackForDispatchId: f.dispatch.id,
    leaseUntil: future(),
  });
}
async function receipt(
  f: Fixture,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  code?: number,
  attempt = f.attempt,
  messageId = 'wamid-' + randomUUID(),
) {
  return repo.recordMerchantReceipt({
    providerMessageId: messageId,
    attemptId: attempt.attemptId,
    phoneNumberId: f.connection.phoneNumberId,
    wabaId: f.connection.wabaId,
    status,
    occurredAt: now(),
    ...(code === undefined
      ? {}
      : { failure: classifyOwnNumberFailure({ code }) }),
  });
}

describe('merchant sender recovery on disposable PostgreSQL', () => {
  beforeAll(h.setup);
  afterAll(h.teardown);
  describe.each(['standalone', 'shopify'])('%s', (platform) => {
    it('retains one charge through two durable retries and accepts once', async () => {
      const f = await fixture(platform);
      const before = await charged(f);
      await fail(f, 131000);
      expect(await charged(f)).toEqual(before);
      for (let number = 1; number <= 2; number++) {
        await due(f);
        const attempts = await Promise.all([
          repo.beginMerchantAttempt(
            f.source.orgId,
            f.dispatch.id,
            selected,
            true,
          ),
          repo.beginMerchantAttempt(
            f.source.orgId,
            f.dispatch.id,
            selected,
            true,
          ),
        ]);
        const attempt = attempts.find(Boolean)!;
        expect(attempts.filter(Boolean)).toHaveLength(1);
        expect(
          await Promise.all([
            repo.authorizeMerchantAttempt(
              f.source.orgId,
              f.dispatch.id,
              attempt,
            ),
            repo.authorizeMerchantAttempt(
              f.source.orgId,
              f.dispatch.id,
              attempt,
            ),
          ]),
        ).toContain(true);
        if (number === 1) await fail(f, 130429, attempt);
        else
          expect(
            await repo.acceptMerchantAttempt(
              f.source.orgId,
              f.dispatch.id,
              attempt,
              'accepted-' + randomUUID(),
              now(),
            ),
          ).toBe(true);
        expect(await charged(f)).toEqual(before);
      }
      expect(await root(f)).toMatchObject({
        state: 'accepted',
        senderRetryCount: 2,
        senderRecoveryState: 'complete',
      });
      expect(
        await repo.beginMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          selected,
          true,
        ),
      ).toBeNull();
    });
    it('exhaustion cannot reset its budget or degrade a healthy connection', async () => {
      const f = await fixture(platform);
      await fail(f, 1);
      for (let n = 0; n < 2; n++) {
        await due(f);
        const a = (await repo.beginMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          selected,
          true,
        ))!;
        await fail(f, 1, a);
      }
      expect(await root(f)).toMatchObject({
        senderRetryCount: 2,
        senderRecoveryState: 'fallback',
      });
      expect(
        (await connections.findByOrg(f.source.orgId))?.degradedClass,
      ).toBeNull();
      expect(
        await repo.beginMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          selected,
          true,
        ),
      ).toBeNull();
      const results = await Promise.all([
        fallback(f),
        fallback(f),
        fallback(f),
      ]);
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    });
    it('duplicate sender failures refund once and claim exactly one fallback generation', async () => {
      const f = await fixture(platform);
      await Promise.all([fail(f, 190), fail(f, 190)]);
      const refunded = await charged(f);
      await fail(f, 190);
      expect(await charged(f)).toEqual(refunded);
      const results = await Promise.all([
        fallback(f),
        fallback(f),
        fallback(f),
      ]);
      const claimed = results.find((r) => r.outcome === 'claimed')!;
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
      expect(claimed).toMatchObject({
        dispatch: {
          generation: 2,
          senderKind: 'akeed_system',
          fallbackForDispatchId: f.dispatch.id,
        },
      });
      expect((await connections.findByOrg(f.source.orgId))?.degradedClass).toBe(
        'credentials',
      );
      const after = await charged(f);
      await receipt(f, 'sent');
      await fail(f, 190);
      expect(await charged(f)).toEqual(after);
      expect(
        await db
          .select()
          .from(verificationMessageDispatches)
          .where(
            eq(
              verificationMessageDispatches.verificationId,
              f.input.verificationId,
            ),
          ),
      ).toHaveLength(2);
    });
    it('unknown outcome returns the original charge and keeps late acceptance audit-only', async () => {
      const f = await fixture(platform);
      await repo.failMerchantAttempt(
        f.source.orgId,
        f.dispatch.id,
        f.attempt,
        classifyOwnNumberFailure({ transport: true }),
      );
      expect(await root(f)).toMatchObject({
        state: 'rejected',
        lastErrorCode: 'outcome_unknown',
        billingRefundedAt: expect.any(String),
      });
      const next = await fallback(f);
      if (next.outcome !== 'claimed') throw new Error(next.outcome);
      await repo.markAccepted({
        dispatchId: next.dispatch.id,
        providerMessageId: 'fallback-' + randomUUID(),
        sentAt: now(),
      });
      const balance = await charged(f);
      const late = 'late-' + randomUUID();
      await receipt(f, 'sent', undefined, f.attempt, late);
      await receipt(f, 'failed', 131042, f.attempt, late);
      expect(await charged(f)).toEqual(balance);
      const [verification] = await db
        .select()
        .from(verifications)
        .where(eq(verifications.id, f.input.verificationId));
      expect(verification.waMessageId).toBe(
        next.dispatch.providerMessageId ??
          (await repo.findSenderRecovery(f.source.orgId, next.dispatch.id))
            .providerMessageId,
      );
      const [audit] = await db
        .select()
        .from(verificationSenderAttempts)
        .where(eq(verificationSenderAttempts.id, f.attempt.attemptId));
      expect(audit.acceptedAt).not.toBeNull();
      expect(audit.failure).toMatchObject({ class: 'payment', code: '131042' });
    });
    it('confirmation during a retry window prevents retry and fallback and returns the charge', async () => {
      const f = await fixture(platform);
      await fail(f, 131000);
      await due(f);
      await db
        .update(verifications)
        .set({ status: 'confirmed' })
        .where(eq(verifications.id, f.input.verificationId));
      expect(
        await repo.beginMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          selected,
          true,
        ),
      ).toBeNull();
      expect(await root(f)).toMatchObject({
        senderRecoveryState: 'canceled',
        billingRefundedAt: expect.any(String),
      });
      expect(await fallback(f)).toMatchObject({
        outcome: 'blocked',
        reason: 'verification_closed',
      });
    });
    it.each([131026, 131021, 131050, 131049])(
      'recipient fault %s never authorizes fallback',
      async (code) => {
        const f = await fixture(platform);
        await fail(f, code);
        expect(await root(f)).toMatchObject({
          senderRecoveryState: 'complete',
        });
        expect(await fallback(f)).toMatchObject({ outcome: 'blocked' });
      },
    );
    it('receipt-before-response and duplicate failed receipts spend one retry budget', async () => {
      const f = await fixture(platform);
      const id = 'early-' + randomUUID();
      await receipt(f, 'failed', 131000, f.attempt, id);
      const first = await root(f);
      await receipt(f, 'failed', 131000, f.attempt, id);
      expect((await root(f)).senderRecoveryVersion).toBe(
        first.senderRecoveryVersion,
      );
      expect(
        await repo.acceptMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          f.attempt,
          id,
          now(),
        ),
      ).toBe(false);
      expect(await root(f)).toMatchObject({
        senderRecoveryState: 'retry',
        senderRetryCount: 0,
      });
    });
    it('drains a parked failed receipt without a callback before deciding acceptance', async () => {
      const f = await fixture(platform);
      const id = `parked-${randomUUID()}`;
      expect(
        await repo.resolveOrParkReceipt({
          providerMessageId: id,
          status: 'failed',
          occurredAt: now(),
          failureInfo: { code: 131000 },
          senderReceiptContext: {
            phoneNumberId: f.connection.phoneNumberId,
            wabaId: f.connection.wabaId,
            failure: classifyOwnNumberFailure({ code: 131000 }),
          },
        }),
      ).toMatchObject({ outcome: 'parked' });
      expect(
        await repo.acceptMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          f.attempt,
          id,
          now(),
        ),
      ).toBe(false);
      expect(await root(f)).toMatchObject({
        senderRecoveryState: 'retry',
        senderRetryCount: 0,
        billingRefundedAt: null,
      });
    });
    it('retains a durable automation handoff after retry acceptance', async () => {
      const f = await fixture(platform);
      await fail(f, 131000);
      await due(f);
      const attempt = (await repo.beginMerchantAttempt(
        f.source.orgId,
        f.dispatch.id,
        selected,
        true,
      ))!;
      const id = `recovered-${randomUUID()}`;
      expect(
        await repo.acceptMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          attempt,
          id,
          now(),
        ),
      ).toBe(true);
      expect(await repo.dueSenderRecovery()).toContainEqual(
        expect.objectContaining({ dispatchId: f.dispatch.id }),
      );
      expect(
        await repo.recoveryAcceptance(f.source.orgId, f.dispatch.id),
      ).toMatchObject({ providerMessageId: id });
      await repo.acknowledgeRecoveryAutomation(f.source.orgId, f.dispatch.id);
      expect(
        await repo.hasSenderRecovery(f.input.verificationId, f.source.orgId),
      ).toBe(false);
    });
    it('a delivered receipt cancels an unclaimed retry; a stale failure cannot undo delivery', async () => {
      const f = await fixture(platform);
      const id = 'delivered-' + randomUUID();
      await receipt(f, 'failed', 131000, f.attempt, id);
      await receipt(f, 'delivered', undefined, f.attempt, id);
      await receipt(f, 'failed', 190, f.attempt, id);
      expect(await root(f)).toMatchObject({
        state: 'accepted',
        senderRecoveryState: 'complete',
      });
      expect(
        (await connections.findByOrg(f.source.orgId))?.degradedClass,
      ).toBeNull();
    });
    it('expired in-flight attempts recover through D3 without another merchant HTTP authorization', async () => {
      const f = await fixture(platform);
      await db
        .update(verificationMessageDispatches)
        .set({ leaseUntil: new Date(Date.now() - 1000).toISOString() })
        .where(eq(verificationMessageDispatches.id, f.dispatch.id));
      expect(await repo.dueSenderRecovery()).toContainEqual(
        expect.objectContaining({
          dispatchId: f.dispatch.id,
          action: 'fallback',
        }),
      );
      expect(
        await repo.authorizeMerchantAttempt(
          f.source.orgId,
          f.dispatch.id,
          f.attempt,
        ),
      ).toBe(false);
    });
    it('a merchant outcome_unknown without a message ID moves to fallback, while known acceptance stays repairable', async () => {
      const f = await fixture(platform);
      await repo.markOutcomeUnknown(f.dispatch.id, 'provider_exception');
      await repo.dueSenderRecovery();
      expect(await root(f)).toMatchObject({
        state: 'rejected',
        senderRecoveryState: 'fallback',
        billingRefundedAt: expect.any(String),
      });
      const known = await fixture(platform);
      const id = `known-${randomUUID()}`;
      await repo.markOutcomeUnknown(
        known.dispatch.id,
        'acceptance_persistence_failed',
        id,
      );
      await repo.dueSenderRecovery();
      expect(await root(known)).toMatchObject({
        state: 'outcome_unknown',
        providerMessageId: id,
        billingRefundedAt: null,
        senderRecoveryState: null,
      });
    });
    it('fallback failure follows shared settlement and cannot create a third generation', async () => {
      const f = await fixture(platform);
      await fail(f, 131042);
      const next = await fallback(f);
      if (next.outcome !== 'claimed') throw new Error(next.outcome);
      await repo.resolveNotAccepted(next.dispatch.id, undefined, true);
      await repo.finishSenderRecovery(f.source.orgId, f.dispatch.id);
      expect(await fallback(f)).toMatchObject({ outcome: 'blocked' });
      expect(
        await db
          .select()
          .from(verificationMessageDispatches)
          .where(
            eq(
              verificationMessageDispatches.verificationId,
              f.input.verificationId,
            ),
          ),
      ).toHaveLength(2);
    });
    it.each([0, 1])(
      'fallback charges only remaining capacity %s without debt',
      async (remaining) => {
        const f = await fixture(platform, 1);
        await fail(f, 100);
        if (platform === 'standalone') {
          for (let n = 0; n < (remaining === 1 ? 1 : 2); n++)
            expect(
              await repo.claim({
                ...(await h.verification(f.source)),
                sender: f.sender,
              }),
            ).toMatchObject({ outcome: 'claimed' });
        } else
          await db
            .update(integrationMonthlyUsage)
            .set({ consumedCount: 30, ownNumberConsumed: 90 - remaining })
            .where(
              eq(integrationMonthlyUsage.integrationId, f.source.integrationId),
            );
        const next = await fallback(f);
        expect(next).toMatchObject({
          outcome: 'claimed',
          dispatch: { billingCost: remaining },
        });
        if (platform === 'standalone') {
          expect(await h.credits.getSummary(f.source.orgId)).toMatchObject({
            postedBalance: 0,
            heldCredits: 0,
          });
          expect(await h.credits.checkInvariant(f.source.orgId)).toMatchObject({
            consistent: true,
          });
        }
      },
    );
  });

  it('rejects cross-tenant attempt authorization and receipt routing', async () => {
    const f = await fixture('standalone');
    expect(
      await repo.authorizeMerchantAttempt(
        randomUUID(),
        f.dispatch.id,
        f.attempt,
      ),
    ).toBe(false);
    await repo.recordMerchantReceipt({
      providerMessageId: randomUUID(),
      attemptId: f.attempt.attemptId,
      phoneNumberId: 'other-phone',
      wabaId: f.connection.wabaId,
      status: 'failed',
      occurredAt: now(),
      failure: classifyOwnNumberFailure({ code: 190 }),
    });
    expect(await root(f)).toMatchObject({ senderRecoveryState: null });
  });
  it.each(['AVAILABLE', 'LIMITED', 'BLOCKED', 'unknown'] as const)(
    'health activation requires AVAILABLE (%s)',
    async (status) => {
      const f = await fixture('standalone');
      await db
        .update(whatsappConnections)
        .set({ state: 'verifying' })
        .where(eq(whatsappConnections.id, f.connection.id));
      const claim = await connections.claimHealth(
        f.source.orgId,
        f.connection.id,
        1,
      );
      expect(claim).not.toBeNull();
      const row = await connections.completeHealth(claim, { status });
      expect(row.state).toBe(status === 'AVAILABLE' ? 'active' : 'verifying');
      expect(row.degradedClass).toBe(
        status === 'BLOCKED' ? 'restricted' : null,
      );
    },
  );
  it.each(['credentials', 'payment', 'restricted'] as const)(
    'health recovery preserves credentials and clears %s only on AVAILABLE',
    async (degraded) => {
      const f = await fixture('standalone');
      await db
        .update(whatsappConnections)
        .set({ degradedClass: degraded, degradedSince: now() })
        .where(eq(whatsappConnections.id, f.connection.id));
      let claim = await connections.claimHealth(
        f.source.orgId,
        f.connection.id,
        1,
      );
      expect(
        (await connections.completeHealth(claim, { status: 'LIMITED' }))
          .degradedClass,
      ).toBe(degraded);
      await db
        .update(whatsappConnections)
        .set({ nextHealthAt: now() })
        .where(eq(whatsappConnections.id, f.connection.id));
      claim = (await connections.claimHealth(
        f.source.orgId,
        f.connection.id,
        1,
      ))!;
      expect(
        (await connections.completeHealth(claim, { status: 'AVAILABLE' }))
          .degradedClass,
      ).toBe(degraded === 'credentials' ? 'credentials' : null);
    },
  );
  it.each(['disconnect', 'replacement', 'new_degradation'] as const)(
    'rejects stale health after %s',
    async (event) => {
      const f = await fixture('standalone');
      const claim = await connections.claimHealth(
        f.source.orgId,
        f.connection.id,
        1,
      );
      if (event === 'disconnect')
        await connections.markDisconnected(f.source.orgId, 'synthetic');
      else if (event === 'replacement')
        await db
          .update(whatsappConnections)
          .set({ signupGeneration: 2 })
          .where(eq(whatsappConnections.id, f.connection.id));
      else await fail(f, 190);
      expect(
        await connections.completeHealth(claim, { status: 'AVAILABLE' }),
      ).toBeNull();
    },
  );
  it('marks only the exact template and refuses an older refresh', async () => {
    const f = await fixture('standalone');
    const [registry] = await db
      .insert(whatsappTemplates)
      .values({
        key: selected.registryKey!,
        purpose: 'cod_confirmation',
        language: 'en',
        style: 'direct',
        metaTemplateName: selected.templateName,
        metaLanguageCode: 'en',
        parameterFormat: 'named',
        variableMapping: [],
        preview: {
          greeting: '',
          body: 'Synthetic',
          totalLabel: '',
          ending: '',
          confirmButton: 'Confirm',
          cancelButton: 'Cancel',
        },
      })
      .returning();
    const row = (await templates.saveForOrg(f.source.orgId, {
      connectionId: f.connection.id,
      templateId: registry.id,
      metaLanguageCode: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
    }))!;
    await fail(f, 132015);
    expect((await templates.listForOrg(f.source.orgId))[0].status).toBe(
      'paused',
    );
    expect(
      (await connections.findByOrg(f.source.orgId))!.degradedClass,
    ).toBeNull();
    expect(
      await templates.updateForOrg(
        f.source.orgId,
        row.id,
        { status: 'APPROVED' },
        undefined,
        '2000-01-01T00:00:00Z',
      ),
    ).toBeNull();
    expect(
      await templates.updateForOrg(
        f.source.orgId,
        row.id,
        { status: 'APPROVED', lastErrorCode: null },
        undefined,
        now(),
      ),
    ).not.toBeNull();
  });
  it.each([
    ['standalone', 'coded'],
    ['shopify', 'coded'],
    ['standalone', 'timeout'],
    ['shopify', 'timeout'],
    ['standalone', 'missing_id'],
    ['shopify', 'missing_id'],
  ])(
    'send orchestration continues immediate fallback in the same job on %s after %s',
    async (platform, mode) => {
      const source = await h.merchant(3, platform);
      const input = await h.verification(source);
      const [connection] = await db
        .insert(whatsappConnections)
        .values({
          orgId: source.orgId,
          wabaId: '1000',
          phoneNumberId: randomUUID(),
          signupPath: 'coexistence',
          state: 'active',
          businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
        })
        .returning();
      const send = jest.fn(
        async (
          params: Parameters<MessagingPort['sendVerificationTemplate']>[0],
        ) => {
          if (params.sender?.kind === 'merchant_own') {
            expect(
              await repo.authorizeMerchantAttempt(
                source.orgId,
                params.dispatchContext!.dispatchId,
                params.dispatchContext!.merchantAttempt!,
              ),
            ).toBe(true);
            if (mode === 'missing_id') return { messages: [] };
            if (mode === 'timeout') throw new Error('Synthetic timeout');
            throw new MerchantMessageFailure(
              classifyOwnNumberFailure({ code: 190 }),
            );
          }
          return { messages: [{ id: 'fallback-service-' + randomUUID() }] };
        },
      );
      const service = new VerificationSendService(
        {
          findById: async (id: string) =>
            (
              await db
                .select()
                .from(verifications)
                .where(eq(verifications.id, id))
            )[0],
        } as never,
        {
          findById: async (id: string) => {
            const [order] = await db
              .select()
              .from(orders)
              .where(eq(orders.id, id));
            const [integration] = await db
              .select()
              .from(integrations)
              .where(eq(integrations.id, source.integrationId));
            return { ...order, integration };
          },
        } as never,
        { evaluateAccess: () => ({ allowed: true }) } as never,
        { resolveDenial: () => Promise.resolve(null) } as never,
        repo,
        { sendVerificationTemplate: send },
        seededTemplateRegistry(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          resolve: () =>
            Promise.resolve({
              kind: 'merchant_own',
              connectionId: connection.id,
              reason: 'own_number',
              units: 1,
            }),
        },
      );
      expect(await service.sendInitial(input.verificationId)).toMatchObject({
        status: 'sent',
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        await db
          .select()
          .from(verificationMessageDispatches)
          .where(
            eq(
              verificationMessageDispatches.verificationId,
              input.verificationId,
            ),
          ),
      ).toHaveLength(2);
    },
  );
});
