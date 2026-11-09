import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { VerificationChangeRequestsRepository } from '../src/infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { customerRecipientHash } from '../src/shared/messaging/change-request-messaging';

const h = creditUsageHarness();
const { db } = h;
const requests = new VerificationChangeRequestsRepository(db as never);
const orders = new OrdersRepository(db as never);
const dispatches = new VerificationMessageDispatchesRepository(
  db,
  h.router,
  new ConfigService({ WA_PHONE_NUMBER_ID: 'shared-phone' }),
);
beforeAll(h.setup);
afterAll(h.teardown);

const PHONE = '+201000000000';

type SenderKind = 'akeed_system' | 'merchant_own';

/** A store whose customer asked for a change on the cycle-1 confirmation. */
async function fixture(senderKind: SenderKind = 'akeed_system', credits = 3) {
  const source = await h.merchant(Math.max(credits, 1));
  if (credits === 0) await h.adjust(source.orgId, -1);
  const original = await h.verification(source);
  let connection: typeof tables.whatsappConnections.$inferSelect | undefined;
  if (senderKind === 'merchant_own')
    [connection] = await db
      .insert(tables.whatsappConnections)
      .values({
        orgId: source.orgId,
        wabaId: randomUUID(),
        phoneNumberId: randomUUID(),
        signupPath: 'coexistence',
        state: 'active',
      })
      .returning();
  const sender = {
    kind: senderKind,
    connectionId: connection?.id ?? null,
    reason: 'fixture',
    units: 1 as const,
  };
  // The first confirmation is free here so every credit in the fixture is
  // the updated confirmation's to spend.
  const initial = await dispatches.claim({
    ...original,
    billingExempt: true,
    recipientHash: customerRecipientHash(PHONE),
    changeRequestButtons: true,
    identity: { variantKey: 'ar.egyptian', purpose: 'initial', language: 'ar' },
    sender,
  });
  if (initial.outcome !== 'claimed') throw new Error(initial.outcome);
  const firstWamid = `wamid.${randomUUID()}`;
  await h.acceptance(initial.dispatch, firstWamid);
  const tap = (wamid: string, cycle: number) => ({
    verificationId: original.verificationId,
    expectedOrgId: source.orgId,
    sourceProviderMessageId: wamid,
    cycle,
    sender: {
      kind: senderKind,
      phoneNumberId: connection?.phoneNumberId ?? 'shared-phone',
    },
    recipientHash: customerRecipientHash(PHONE),
    requireChangeButton: true,
    eventId: `tap-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    shipping: 'unknown' as const,
  });
  const opened = await requests.open(tap(firstWamid, 1));
  if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
  const merchantUser = randomUUID();
  const claimUpdated = () =>
    dispatches.claim({
      ...original,
      confirmationCycle: 2,
      recipientHash: customerRecipientHash(PHONE),
      changeRequestButtons: true,
      identity: {
        variantKey: 'ar.egyptian',
        purpose: 'initial',
        language: 'ar',
      },
      sender,
    });
  return {
    source,
    original,
    connection,
    sender,
    initial: initial.dispatch,
    firstWamid,
    request: opened.request,
    tap,
    merchantUser,
    claimUpdated,
  };
}

async function verificationOf(id: string) {
  const [row] = await db
    .select()
    .from(tables.verifications)
    .where(eq(tables.verifications.id, id));
  return row;
}

async function requestOf(id: string, orgId: string) {
  return requests.findById(id, orgId);
}

async function ask(f: Awaited<ReturnType<typeof fixture>>) {
  return requests.requestReconfirmation({
    orgId: f.source.orgId,
    verificationId: f.original.verificationId,
    changeRequestId: f.request.id,
    expectedCycle: 1,
    actorUserId: f.merchantUser,
  });
}

describe('updated confirmation for a change request over PostgreSQL', () => {
  it.each<SenderKind>(['akeed_system', 'merchant_own'])(
    'starts the next cycle only when the provider accepts it (%s)',
    async (senderKind) => {
      const f = await fixture(senderKind);
      const asked = await ask(f);
      expect(asked).toMatchObject({
        outcome: 'requested',
        request: { reconfirmationState: 'requested', reconfirmationAttempt: 1 },
      });

      const claim = await f.claimUpdated();
      if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
      expect(claim.dispatch.confirmationCycle).toBe(2);
      expect(claim.dispatch.id).not.toBe(f.initial.id);
      expect(claim.dispatch.generation).toBeGreaterThan(f.initial.generation);

      // Queued or with the provider: nothing about the order moved yet.
      let verification = await verificationOf(f.original.verificationId);
      expect(verification.confirmationCycle).toBe(1);
      expect(verification.waMessageId).toBe(f.firstWamid);
      expect((await requestOf(f.request.id, f.source.orgId))?.status).toBe(
        'open',
      );

      const newWamid = `wamid.${randomUUID()}`;
      await h.acceptance(claim.dispatch, newWamid);

      verification = await verificationOf(f.original.verificationId);
      expect(verification).toMatchObject({
        confirmationCycle: 2,
        status: 'sent',
        waMessageId: newWamid,
        customerActionAt: null,
        followUpAttempts: 0,
      });
      const closed = await requestOf(f.request.id, f.source.orgId);
      expect(closed).toMatchObject({
        status: 'resolved',
        resolution: 'reconfirmation_sent',
        resolvedByUserId: f.merchantUser,
        reconfirmationState: null,
        reconfirmationDispatchId: claim.dispatch.id,
      });
      const history = await requests.listHistory(f.request.id, f.source.orgId);
      expect(history.map((event) => event.event)).toEqual([
        'opened',
        'reconfirmation_requested',
        'resolved',
      ]);
      expect(history[2]).toMatchObject({
        actorKind: 'merchant',
        actorUserId: f.merchantUser,
      });

      // The old buttons are retired; the new message's buttons work.
      await expect(
        requests.open(f.tap(f.firstWamid, 1)),
      ).resolves.toMatchObject({ outcome: 'rejected', reason: 'stale_cycle' });
      await expect(requests.open(f.tap(newWamid, 2))).resolves.toMatchObject({
        outcome: 'opened',
      });
    },
  );

  it('charges the updated confirmation once, as any confirmation', async () => {
    const f = await fixture('akeed_system', 3);
    await ask(f);
    const claim = await f.claimUpdated();
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    await h.balance(f.source.orgId, 3, 1);
    await h.acceptance(claim.dispatch);
    await h.balance(f.source.orgId, 2, 0);
    // A retried claim of the same cycle reuses the accepted message.
    await expect(f.claimUpdated()).resolves.toMatchObject({
      outcome: 'accepted',
      dispatch: { id: claim.dispatch.id },
    });
    await h.balance(f.source.orgId, 2, 0);
  });

  it('joins a second click to the attempt already in flight', async () => {
    const f = await fixture();
    await ask(f);
    const again = await ask(f);
    expect(again).toMatchObject({
      outcome: 'in_flight',
      request: { reconfirmationAttempt: 1 },
    });
    const [concurrentA, concurrentB] = await Promise.all([ask(f), ask(f)]);
    expect([concurrentA.outcome, concurrentB.outcome]).toEqual([
      'in_flight',
      'in_flight',
    ]);
    const history = await requests.listHistory(f.request.id, f.source.orgId);
    expect(
      history.filter((event) => event.event === 'reconfirmation_requested'),
    ).toHaveLength(1);
  });

  it('lets only the current attempt reach the provider', async () => {
    const f = await fixture();
    await ask(f);
    const [first, second] = await Promise.all([
      requests.beginReconfirmationSend({
        orgId: f.source.orgId,
        changeRequestId: f.request.id,
        attempt: 1,
      }),
      requests.beginReconfirmationSend({
        orgId: f.source.orgId,
        changeRequestId: f.request.id,
        attempt: 1,
      }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await expect(
      requests.beginReconfirmationSend({
        orgId: f.source.orgId,
        changeRequestId: f.request.id,
        attempt: 0,
      }),
    ).resolves.toBeNull();
  });

  it('keeps the request open, and the cycle where it is, when the customer answers first', async () => {
    const f = await fixture();
    await ask(f);
    const claim = await f.claimUpdated();
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    // Another tab (or the customer's Confirm) settles it before acceptance.
    await expect(
      requests.resolveByMerchantConfirmation({
        orgId: f.source.orgId,
        verificationId: f.original.verificationId,
        changeRequestId: f.request.id,
        actorUserId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'resolved' });
    await h.acceptance(claim.dispatch, `wamid.${randomUUID()}`);
    const verification = await verificationOf(f.original.verificationId);
    expect(verification).toMatchObject({
      status: 'confirmed',
      confirmationCycle: 1,
      waMessageId: f.firstWamid,
    });
    expect(await requestOf(f.request.id, f.source.orgId)).toMatchObject({
      resolution: 'merchant_confirmed',
    });
    // A later merchant action on the stale page is told what won.
    await expect(
      requests.requestReconfirmation({
        orgId: f.source.orgId,
        verificationId: f.original.verificationId,
        changeRequestId: f.request.id,
        expectedCycle: 1,
        actorUserId: f.merchantUser,
      }),
    ).resolves.toMatchObject({
      outcome: 'already_resolved',
      verificationStatus: 'confirmed',
    });
  });

  it('leaves the order untouched and the request open when the provider refuses it', async () => {
    const f = await fixture('akeed_system', 3);
    await ask(f);
    const claim = await f.claimUpdated();
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    // A refusal that would mark a first confirmation `no_whatsapp`.
    await dispatches.resolveNotAccepted(
      claim.dispatch.id,
      undefined,
      true,
      '131026',
    );
    const verification = await verificationOf(f.original.verificationId);
    expect(verification.status).not.toBe('no_whatsapp');
    expect(verification.confirmationCycle).toBe(1);
    await h.balance(f.source.orgId, 3, 0);
    await expect(
      requests.recordReconfirmationFailure({
        orgId: f.source.orgId,
        verificationId: f.original.verificationId,
        changeRequestId: f.request.id,
        reason: 'sending_failed',
        attempt: 1,
      }),
    ).resolves.toBe('recorded');
    expect(await requestOf(f.request.id, f.source.orgId)).toMatchObject({
      status: 'open',
      reconfirmationState: 'failed',
      lastReconfirmationError: 'sending_failed',
    });

    // The merchant asks again: a new attempt and a new message.
    await expect(ask(f)).resolves.toMatchObject({
      outcome: 'requested',
      request: { reconfirmationAttempt: 2, lastReconfirmationError: null },
    });
    const retry = await f.claimUpdated();
    expect(retry.outcome).toBe('claimed');
    if (retry.outcome !== 'claimed') return;
    expect(retry.dispatch.id).not.toBe(claim.dispatch.id);
    expect(retry.dispatch.confirmationCycle).toBe(2);
  });

  it('records a late failure only against its own attempt', async () => {
    const f = await fixture();
    await ask(f);
    await requests.recordReconfirmationFailure({
      orgId: f.source.orgId,
      verificationId: f.original.verificationId,
      changeRequestId: f.request.id,
      reason: 'order_source_unavailable',
      attempt: 1,
    });
    await ask(f);
    await expect(
      requests.recordReconfirmationFailure({
        orgId: f.source.orgId,
        verificationId: f.original.verificationId,
        changeRequestId: f.request.id,
        reason: 'sending_failed',
        attempt: 1,
      }),
    ).resolves.toBe('not_open');
    expect(await requestOf(f.request.id, f.source.orgId)).toMatchObject({
      reconfirmationAttempt: 2,
      reconfirmationState: 'requested',
    });
  });

  it('blocks a send without allowance and changes nothing else', async () => {
    const f = await fixture('akeed_system', 0);
    await ask(f);
    await expect(f.claimUpdated()).resolves.toMatchObject({
      outcome: 'blocked',
      reason: 'INSUFFICIENT_CREDITS',
    });
    expect(await verificationOf(f.original.verificationId)).toMatchObject({
      confirmationCycle: 1,
      waMessageId: f.firstWamid,
    });
    expect((await requestOf(f.request.id, f.source.orgId))?.status).toBe(
      'open',
    );
  });

  it('records the quiet-hours wait for the current attempt only', async () => {
    const f = await fixture();
    await ask(f);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      requests.markReconfirmationScheduled({
        orgId: f.source.orgId,
        changeRequestId: f.request.id,
        attempt: 1,
        scheduledFor: at,
      }),
    ).resolves.toBe(true);
    expect(await requestOf(f.request.id, f.source.orgId)).toMatchObject({
      reconfirmationState: 'scheduled',
    });
    await expect(
      requests.markReconfirmationScheduled({
        orgId: f.source.orgId,
        changeRequestId: f.request.id,
        attempt: 7,
        scheduledFor: at,
      }),
    ).resolves.toBe(false);
  });

  it('never acts across tenants', async () => {
    const f = await fixture();
    const other = await h.merchant(1);
    await expect(
      requests.requestReconfirmation({
        orgId: other.orgId,
        verificationId: f.original.verificationId,
        changeRequestId: f.request.id,
        expectedCycle: 1,
        actorUserId: randomUUID(),
      }),
    ).resolves.toEqual({
      outcome: 'rejected',
      reason: 'verification_not_found',
    });
    await expect(
      requests.markReconfirmationScheduled({
        orgId: other.orgId,
        changeRequestId: f.request.id,
        attempt: 0,
        scheduledFor: new Date().toISOString(),
      }),
    ).resolves.toBe(false);
    const [order] = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.orgId, f.source.orgId));
    await expect(
      orders.refreshCurrentDetails(order.id, other.orgId, {
        customerPhone: '+201000000099',
        totalPrice: '1.00',
        currency: 'EGP',
      }),
    ).resolves.toBeNull();
    expect(
      (
        await requests.findOpenSummaries(other.orgId, [
          f.original.verificationId,
        ])
      ).length,
    ).toBe(0);
  });

  it('does not take an ordinary order update as a resolution', async () => {
    const f = await fixture();
    const [order] = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.orgId, f.source.orgId));
    await orders.refreshCurrentDetails(order.id, f.source.orgId, {
      customerPhone: PHONE,
      customerName: 'Mona',
      totalPrice: '750.00',
      currency: 'EGP',
      lineItems: [
        { name: 'Plate', quantity: 2, unitPrice: '375.00', options: [] },
      ],
      shippingRegion: 'Giza',
      shippingAddress: '9 New Street',
    });
    const [updated] = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.id, order.id));
    expect(updated).toMatchObject({
      totalPrice: '750.00',
      shippingAddress: '9 New Street',
      externalOrderId: order.externalOrderId,
    });
    expect((await requestOf(f.request.id, f.source.orgId))?.status).toBe(
      'open',
    );
    const [summary] = await requests.findOpenSummaries(f.source.orgId, [
      f.original.verificationId,
    ]);
    expect(summary.request.id).toBe(f.request.id);
  });

  it('lets a later cycle claim its own acknowledgment', async () => {
    const f = await fixture('akeed_system', 4);
    const acknowledge = async (cycle: number, changeRequestId: string) => {
      const effect = await requests.claimEffect(
        'customer_acknowledgment',
        60_000,
        new Date(),
        changeRequestId,
      );
      if (!effect) throw new Error('no effect');
      return dispatches.claim({
        ...f.original,
        kind: 'change_acknowledgment',
        confirmationCycle: cycle,
        changeRequestEffect: { id: effect.id, attempts: effect.attempts },
        templateName: null,
        languageCode: 'ar',
        sender: f.sender,
      });
    };
    const first = await acknowledge(1, f.request.id);
    if (first.outcome !== 'claimed') throw new Error(first.outcome);
    await h.acceptance(first.dispatch);

    await ask(f);
    const claim = await f.claimUpdated();
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    const newWamid = `wamid.${randomUUID()}`;
    await h.acceptance(claim.dispatch, newWamid);
    const reopened = await requests.open(f.tap(newWamid, 2));
    if (reopened.outcome !== 'opened') throw new Error(reopened.outcome);

    const second = await acknowledge(2, reopened.request.id);
    expect(second.outcome).toBe('claimed');
    const acks = await db
      .select()
      .from(tables.verificationMessageDispatches)
      .where(
        and(
          eq(
            tables.verificationMessageDispatches.verificationId,
            f.original.verificationId,
          ),
          eq(
            tables.verificationMessageDispatches.kind,
            'change_acknowledgment',
          ),
        ),
      );
    expect(acks.map((row) => row.confirmationCycle).sort()).toEqual([1, 2]);
  });
});
