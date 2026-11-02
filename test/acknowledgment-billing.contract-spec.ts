import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import {
  integrations,
  integrationMonthlyUsage,
  verifications,
  verificationMessageDispatches,
  verificationServiceMessages,
} from '../src/infrastructure/database/schema';
import { VerificationServiceMessagesRepository } from '../src/infrastructure/database/repositories/verification-service-messages.repository';

const harness = creditUsageHarness();
const { db, client, dispatches, merchant, verification, acceptance, balance } =
  harness;
const serviceMessages = new VerificationServiceMessagesRepository(db);

async function input(platform = 'standalone', quantity = 3) {
  const source = await merchant(quantity, platform);
  await db
    .update(integrations)
    .set({ acknowledgmentEnabled: true })
    .where(eq(integrations.id, source.integrationId));
  const original = await verification(source);
  await db
    .update(verifications)
    .set({
      status: 'confirmed',
      confirmationSource: 'customer',
      waMessageId: 'original-message',
    })
    .where(eq(verifications.id, original.verificationId));
  return {
    ...original,
    kind: 'acknowledgment' as const,
    repliedAt: new Date().toISOString(),
    templateName: null,
  };
}

async function claim(params: Awaited<ReturnType<typeof input>>) {
  const result = await dispatches.claim(params);
  if (result.outcome !== 'claimed')
    throw new Error(`Expected claim, received ${result.outcome}`);
  return result.dispatch;
}

async function snapshot(id: string) {
  return (
    await db.select().from(verifications).where(eq(verifications.id, id))
  )[0] as typeof verifications.$inferSelect;
}

describe('paid thank-you messages against PostgreSQL', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);

  it('migrates the old enum and defaults merchant opt-in off', async () => {
    const source = await merchant();
    const [row] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, source.integrationId));
    expect(row.acknowledgmentEnabled).toBe(false);
    const values = await client<
      { value: string }[]
    >`SELECT unnest(enum_range(NULL::verification_dispatch_kind))::text AS value`;
    expect(values.map((row) => row.value)).toContain('acknowledgment');
  });

  it('charges exactly once under concurrent claims and duplicate acceptance without changing the verification', async () => {
    const params = await input();
    const before = await snapshot(params.verificationId);
    const results = await Promise.all([
      dispatches.claim(params),
      dispatches.claim(params),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'busy',
      'claimed',
    ]);
    const found = results.find((result) => result.outcome === 'claimed');
    if (found?.outcome !== 'claimed') throw new Error('Missing claim');
    await balance(params.orgId, 3, 1);
    const wamid = randomUUID();
    await acceptance(found.dispatch, wamid);
    await acceptance(found.dispatch, wamid);
    await balance(params.orgId, 2, 0);
    expect(await snapshot(params.verificationId)).toEqual(before);
  });

  it.each(['standalone', 'shopify'])(
    'refunds an early failure once and isolates the order (%s)',
    async (platform) => {
      const params = await input(platform);
      const before = await snapshot(params.verificationId);
      const message = await serviceMessages.claim({
        orgId: params.orgId,
        verificationId: params.verificationId,
        kind: 'acknowledgment',
        repliedAt: new Date().toISOString(),
      });
      const dispatch = await claim(params);
      await serviceMessages.linkDispatch(
        message!.id,
        params.orgId,
        dispatch.id,
      );
      const wamid = randomUUID();
      const failedAt = new Date(Date.now() + 1000).toISOString();
      expect(
        await dispatches.resolveOrParkReceipt({
          providerMessageId: wamid,
          status: 'failed',
          occurredAt: failedAt,
        }),
      ).toMatchObject({ outcome: 'parked' });
      await acceptance(dispatch, wamid);
      await serviceMessages.markSent({
        id: message!.id,
        providerMessageId: wamid,
        sentAt: new Date().toISOString(),
        text: { purpose: 'ack_confirmed', language: 'en', style: 'default' },
      });
      for (let i = 0; i < 2; i++)
        expect(
          await dispatches.recordProviderStatus(
            dispatch.id,
            'failed',
            failedAt,
          ),
        ).toEqual({ verificationRows: [] });
      if (platform === 'standalone') await balance(params.orgId, 3, 0);
      else {
        const [usage] = await db
          .select()
          .from(integrationMonthlyUsage)
          .where(
            eq(integrationMonthlyUsage.integrationId, params.integrationId),
          );
        expect(usage.consumedCount).toBe(0);
      }
      expect(await snapshot(params.verificationId)).toEqual(before);
      const [record] = await db
        .select()
        .from(verificationServiceMessages)
        .where(eq(verificationServiceMessages.id, message!.id));
      expect(record.state).toBe('failed');
      expect(record.skipReason).toBe('delivery_failed');
      expect(await serviceMessages.isServiceMessage(wamid)).toBe(false);
    },
  );

  it.each(['standalone', 'shopify'])(
    'ignores late failures after a successful delivery (%s)',
    async (platform) => {
      const params = await input(platform);
      const before = await snapshot(params.verificationId);
      const dispatch = await claim(params);
      await acceptance(dispatch);
      await dispatches.recordProviderStatus(
        dispatch.id,
        'delivered',
        new Date(Date.now() + 1000).toISOString(),
      );
      await dispatches.recordProviderStatus(
        dispatch.id,
        'failed',
        new Date(Date.now() + 2000).toISOString(),
      );
      if (platform === 'standalone') await balance(params.orgId, 2, 0);
      else {
        const [usage] = await db
          .select()
          .from(integrationMonthlyUsage)
          .where(
            eq(integrationMonthlyUsage.integrationId, params.integrationId),
          );
        expect(usage.consumedCount).toBe(1);
      }
      expect(await snapshot(params.verificationId)).toEqual(before);
    },
  );

  it.each(['standalone', 'shopify'])(
    'retains ambiguous capacity until audited resolution and never reclaims expired sends (%s)',
    async (platform) => {
      const params = await input(platform);
      const before = await snapshot(params.verificationId);
      const dispatch = await claim({
        ...params,
        leaseUntil: '2000-01-01T00:00:00Z',
      });
      expect(await dispatches.expireAcknowledgmentLeases()).toBeGreaterThan(0);
      expect(await dispatches.claim(params)).toMatchObject({
        outcome: 'outcome_unknown',
      });
      if (platform === 'standalone') await balance(params.orgId, 3, 1);
      else {
        const [usage] = await db
          .select()
          .from(integrationMonthlyUsage)
          .where(
            eq(integrationMonthlyUsage.integrationId, params.integrationId),
          );
        expect(usage.consumedCount).toBe(1);
      }
      await dispatches.resolveNotAccepted(dispatch.id, {
        userId: randomUUID(),
        reason: 'Synthetic provider evidence of non-send',
      });
      if (platform === 'standalone') await balance(params.orgId, 3, 0);
      expect((await dispatches.claim(params)).outcome).not.toBe('claimed');
      expect(await snapshot(params.verificationId)).toEqual(before);
    },
  );

  it('rechecks opt-out under the source lock and never reserves capacity when off', async () => {
    const params = await input();
    await db
      .update(integrations)
      .set({ acknowledgmentEnabled: false })
      .where(eq(integrations.id, params.integrationId));
    expect(
      await dispatches.acknowledgmentEnabledForVerification(
        params.verificationId,
        params.orgId,
        new Date().toISOString(),
      ),
    ).toBe(false);
    expect(
      await dispatches.acknowledgmentEnabledForVerification(
        params.verificationId,
        randomUUID(),
        new Date().toISOString(),
      ),
    ).toBe(false);
    expect(await dispatches.claim(params)).toMatchObject({
      outcome: 'blocked',
      reason: 'acknowledgment_disabled',
    });
    await db
      .update(integrations)
      .set({
        acknowledgmentEnabled: true,
        acknowledgmentEnabledAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(integrations.id, params.integrationId));
    expect(await dispatches.claim(params)).toMatchObject({
      outcome: 'blocked',
      reason: 'acknowledgment_disabled',
    });
    await balance(params.orgId, 3, 0);
  });

  it('skips a thank-you when the Shopify allowance is exhausted', async () => {
    const params = await input('shopify');
    await claim(params);
    const [usage] = await db
      .select()
      .from(integrationMonthlyUsage)
      .where(eq(integrationMonthlyUsage.integrationId, params.integrationId));
    await db
      .update(integrationMonthlyUsage)
      .set({ consumedCount: usage.includedLimit })
      .where(eq(integrationMonthlyUsage.id, usage.id));
    const second = await verification(params);
    await db
      .update(verifications)
      .set({ status: 'canceled', cancellationSource: 'customer' })
      .where(eq(verifications.id, second.verificationId));
    const before = await snapshot(second.verificationId);
    expect(
      await dispatches.claim({
        ...second,
        kind: 'acknowledgment',
        repliedAt: new Date().toISOString(),
        templateName: null,
      }),
    ).toMatchObject({ outcome: 'blocked', reason: 'plan_limit_reached' });
    expect(await snapshot(second.verificationId)).toEqual(before);
  });

  it('blocks when the last credit was consumed by the confirmation', async () => {
    const params = await input('standalone', 1);
    const initial = await dispatches.claim({
      ...params,
      kind: 'initial',
      templateName: 'synthetic-confirmation',
    });
    if (initial.outcome !== 'claimed') throw new Error('Missing initial send');
    await acceptance(initial.dispatch);
    expect(await dispatches.claim(params)).toMatchObject({
      outcome: 'blocked',
      reason: 'INSUFFICIENT_CREDITS',
    });
    const [state] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, params.verificationId));
    expect(state.status).toBe('confirmed');
    await balance(params.orgId, 0, 0);
  });

  it('keeps historical unlinked free messages outside paid receipt routing', async () => {
    const params = await input();
    const message = await serviceMessages.claim({
      orgId: params.orgId,
      verificationId: params.verificationId,
      kind: 'acknowledgment',
      repliedAt: new Date().toISOString(),
    });
    const wamid = randomUUID();
    await serviceMessages.markSent({
      id: message!.id,
      providerMessageId: wamid,
      sentAt: new Date().toISOString(),
      text: { purpose: 'ack_confirmed', language: 'en', style: 'default' },
    });
    expect(await serviceMessages.isServiceMessage(wamid)).toBe(true);
    expect(await serviceMessages.recordDeliveryFailure(wamid)).toBe(true);
    await balance(params.orgId, 3, 0);
  });

  it('settles salvaged acceptance after an early failure without retaining a charge', async () => {
    const params = await input();
    const before = await snapshot(params.verificationId);
    const dispatch = await claim(params);
    const wamid = randomUUID();
    await dispatches.markOutcomeUnknown(
      dispatch.id,
      'acceptance_persistence_failed',
      wamid,
    );
    await dispatches.recordProviderStatus(
      dispatch.id,
      'failed',
      new Date(Date.now() + 1000).toISOString(),
    );
    await balance(params.orgId, 3, 1);
    await acceptance(dispatch, wamid);
    await balance(params.orgId, 3, 0);
    expect(await snapshot(params.verificationId)).toEqual(before);
    const [settled] = await db
      .select()
      .from(verificationMessageDispatches)
      .where(eq(verificationMessageDispatches.id, dispatch.id));
    expect(settled.state).toBe('accepted');
  });
});
