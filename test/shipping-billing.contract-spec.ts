import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { ShippingNotificationsRepository } from '../src/infrastructure/database/repositories/shipping-notifications.repository';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import {
  integrationMonthlyUsage,
  integrations,
  orders,
  verificationMessageDispatches,
  verificationShippingNotifications,
  verifications,
  whatsappConnections,
} from '../src/infrastructure/database/schema';
import type { BillingPlanId } from '../src/shared/billing/billing-plan';
import type { RegistryTemplate } from '../src/shared/messaging/template-registry.types';
import { seededTemplateRegistry } from '../src/shared/messaging/testing/seeded-template-registry';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { MerchantMessageFailure } from '../src/shared/ports/sender-recovery.port';
import type { ResolvedSender } from '../src/shared/ports/sender-resolver.port';
import { classifyOwnNumberFailure } from '../src/infrastructure/spokes/meta/own-number/own-number-send-failure.policy';

/**
 * The Shipped message's charge over PostgreSQL: the confirmation reserve is
 * decided under the same usage-row lock as the charge, a refused send takes
 * nothing and sends nothing, and an own-number failure that falls back to the
 * Akeed number is charged once.
 */

const harness = creditUsageHarness();
const { db, merchant } = harness;
const dispatches = new VerificationMessageDispatchesRepository(
  db,
  harness.router,
  { get: () => 'shared-phone' } as never,
);
const shippingRepo = new ShippingNotificationsRepository(db as never);

const SHIPPED: RegistryTemplate = {
  key: 'shipping_shipped.en.default',
  purpose: 'shipping_shipped',
  language: 'en',
  style: 'default',
  templateName: 'akeed_shipping_shipped_default_v1',
  languageCode: 'en',
  parameterFormat: 'named',
  variables: [
    { key: 'customer', name: 'customer' },
    { key: 'order', name: 'order' },
    { key: 'store', name: 'store' },
    { key: 'tracking', name: 'tracking' },
  ],
  preview: {
    greeting: '',
    body: '',
    totalLabel: '',
    ending: '',
    confirmButton: "I'll be home",
    cancelButton: 'Reschedule',
    changeButton: 'Change address',
  },
  isActive: true,
  isDefault: true,
  reviewStatus: 'approved',
  category: 'utility',
  lastSyncedAt: '2026-11-24T00:00:00.000Z',
};

async function shopifyStore(planId: BillingPlanId = 'starter') {
  const source = await merchant(0, 'shopify');
  if (planId !== 'starter')
    await db
      .update(integrations)
      .set({ billingPlanId: planId })
      .where(eq(integrations.id, source.integrationId));
  return source;
}

/** A confirmed order with a pending Shipped record. */
async function shippedOrder(source: { orgId: string; integrationId: string }) {
  const input = await harness.verification(source);
  await db
    .update(verifications)
    .set({ status: 'confirmed' })
    .where(eq(verifications.id, input.verificationId));
  const [record] = await db
    .insert(verificationShippingNotifications)
    .values({
      orgId: source.orgId,
      verificationId: input.verificationId,
      stage: 'shipped',
      trigger: 'fulfillment',
      trackingNumber: '1Z999',
    })
    .returning();
  return {
    record,
    input: {
      ...input,
      kind: 'shipping_shipped' as const,
      templateName: SHIPPED.templateName,
      identity: {
        variantKey: 'en.default',
        purpose: 'shipping' as const,
        language: 'en' as const,
      },
    },
  };
}

async function usage(integrationId: string) {
  const [row] = await db
    .select()
    .from(integrationMonthlyUsage)
    .where(eq(integrationMonthlyUsage.integrationId, integrationId));
  return row
    ? {
        akeed: row.consumedCount,
        own: row.ownNumberConsumed,
        blocked: row.blockedCount,
      }
    : { akeed: 0, own: 0, blocked: 0 };
}

/** Creates the usage row at the given counts. */
async function setUsage(
  source: { orgId: string; integrationId: string },
  akeed: number,
  own: number,
) {
  // A charged claim creates the period's row; it is then rewritten.
  const order = await shippedOrder(source);
  await dispatches.claim({ ...order.input, kind: 'initial' });
  await db
    .update(integrationMonthlyUsage)
    .set({ consumedCount: akeed, ownNumberConsumed: own, blockedCount: 0 })
    .where(eq(integrationMonthlyUsage.integrationId, source.integrationId));
}

async function recordOf(id: string) {
  const [row] = await db
    .select()
    .from(verificationShippingNotifications)
    .where(eq(verificationShippingNotifications.id, id));
  return row;
}

async function dispatchesOf(verificationId: string) {
  return db
    .select()
    .from(verificationMessageDispatches)
    .where(eq(verificationMessageDispatches.verificationId, verificationId));
}

async function ownSender(orgId: string) {
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
  const sender: ResolvedSender = {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
  return { connection, sender };
}

function sendService(
  source: { integrationId: string },
  send: MessagingPort['sendVerificationTemplate'],
  sender: ResolvedSender | null,
) {
  return new VerificationSendService(
    {
      findById: async (id: string) =>
        (
          await db.select().from(verifications).where(eq(verifications.id, id))
        )[0],
    } as never,
    {
      findById: async (id: string) => {
        const [order] = await db.select().from(orders).where(eq(orders.id, id));
        const [integration] = await db
          .select()
          .from(integrations)
          .where(eq(integrations.id, source.integrationId));
        return { ...order, integration };
      },
    } as never,
    { evaluateAccess: () => ({ allowed: true }) } as never,
    { resolveDenial: () => Promise.resolve(null) } as never,
    dispatches,
    { sendVerificationTemplate: send } as never,
    seededTemplateRegistry([SHIPPED]),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      resolve: () =>
        Promise.resolve(
          sender ?? {
            kind: 'akeed_system',
            connectionId: null,
            reason: 'feature_off',
            units: 1,
          },
        ),
    } as never,
    undefined,
    undefined,
    undefined,
    shippingRepo,
  );
}

beforeAll(async () => {
  await harness.setup();
  // The harness base predates the language migrations (0064, 0068); widen the
  // one language check 0107's seed touches as they do.
  await harness.client.unsafe(`
    ALTER TABLE whatsapp_message_texts DROP CONSTRAINT IF EXISTS whatsapp_message_texts_language_check;
    ALTER TABLE whatsapp_message_texts ADD CONSTRAINT whatsapp_message_texts_language_check CHECK (language IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));
  `);
  // The shipping record and its sending columns, run twice to prove reruns.
  for (const name of [
    '0106_shipping_notifications.sql',
    '0107_shipping_sending.sql',
    '0107_shipping_sending.sql',
  ])
    await harness.client.begin(async (tx) => {
      const statements = readFileSync(
        resolve(__dirname, '../drizzle', name),
        'utf8',
      )
        .split('--> statement-breakpoint')
        .filter((part) => part.trim());
      for (const statement of statements) await tx.unsafe(statement);
    });
});
afterAll(harness.teardown);

describe('shipping billing against PostgreSQL', () => {
  it('seeds the six Shipped registry rows as pending', async () => {
    const rows = await harness.client<
      { key: string; review_status: string; is_default: boolean }[]
    >`SELECT key, review_status, is_default FROM whatsapp_templates WHERE purpose = 'shipping_shipped' ORDER BY key`;
    expect(rows).toEqual(
      ['ar', 'en', 'es', 'fr', 'tr', 'ur'].map((language) => ({
        key: `shipping_shipped.${language}.default`,
        review_status: 'pending',
        is_default: true,
      })),
    );
    const drafts = await harness.client<{ key: string; state: string }[]>`
      SELECT key, state FROM whatsapp_template_drafts WHERE purpose = 'shipping_shipped'`;
    expect(drafts).toEqual([]);
  });

  it('concurrent sends at the end of the pool never overdraw it', async () => {
    const source = await shopifyStore();
    // Starter: 60 Akeed messages, nothing held back. At 54 used, six may go.
    await setUsage(source, 54, 0);
    const orders = await Promise.all(
      Array.from({ length: 10 }, () => shippedOrder(source)),
    );
    const results = await Promise.all(
      orders.map((order) => dispatches.claim(order.input)),
    );
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(6);
    expect(
      results
        .filter((r) => r.outcome === 'blocked')
        .map((r) => 'reason' in r && r.reason),
    ).toEqual(Array(4).fill('no_allowance'));
    expect(await usage(source.integrationId)).toEqual({
      akeed: 60,
      own: 0,
      blocked: 0,
    });
  });

  it('a refused send takes nothing, holds nothing and links nothing', async () => {
    const source = await shopifyStore();
    await setUsage(source, 60, 0);
    const order = await shippedOrder(source);
    expect(await dispatches.claim(order.input)).toMatchObject({
      outcome: 'blocked',
      reason: 'no_allowance',
    });
    expect(await usage(source.integrationId)).toEqual({
      akeed: 60,
      own: 0,
      blocked: 0,
    });
    const [row] = await dispatchesOf(order.input.verificationId);
    expect(row).toMatchObject({
      state: 'ready',
      usageReserved: false,
      billingPool: null,
      billingCost: null,
    });
    expect(await recordOf(order.record.id)).toMatchObject({
      status: 'pending',
      dispatchId: null,
    });
  });

  it('the last message of the pool is still sent (no reserve)', async () => {
    const source = await shopifyStore();
    await setUsage(source, 59, 0);
    const order = await shippedOrder(source);
    expect(await dispatches.claim(order.input)).toMatchObject({
      outcome: 'claimed',
      dispatch: { billingPool: 'akeed' },
    });
    expect((await usage(source.integrationId)).akeed).toBe(60);
  });

  it('a refused send through the send service never calls the provider', async () => {
    const source = await shopifyStore();
    await setUsage(source, 60, 0);
    const order = await shippedOrder(source);
    const send = jest.fn();
    const service = sendService(source, send, null);
    expect(await service.sendShipped(order.input.verificationId)).toEqual({
      status: 'skipped',
      reason: 'no_allowance',
    });
    expect(send).not.toHaveBeenCalled();
    expect((await usage(source.integrationId)).akeed).toBe(60);
  });

  it('own number spills over to the Akeed pool once its own pool is empty', async () => {
    const source = await shopifyStore();
    const { sender } = await ownSender(source.orgId);
    // Own pool 200: the 200th message is its own; after it, the Akeed pool pays.
    await setUsage(source, 0, 199);
    const last = await shippedOrder(source);
    expect(await dispatches.claim({ ...last.input, sender })).toMatchObject({
      outcome: 'claimed',
      dispatch: { billingPool: 'own_number', senderKind: 'merchant_own' },
    });
    await setUsage(source, 0, 200);
    const spilled = await shippedOrder(source);
    expect(await dispatches.claim({ ...spilled.input, sender })).toMatchObject({
      outcome: 'claimed',
      dispatch: { billingPool: 'akeed', senderKind: 'merchant_own' },
    });
    await setUsage(source, 60, 200);
    const refused = await shippedOrder(source);
    expect(await dispatches.claim({ ...refused.input, sender })).toMatchObject({
      outcome: 'blocked',
      reason: 'no_allowance',
    });
    expect(await usage(source.integrationId)).toMatchObject({
      akeed: 60,
      own: 200,
    });
  });

  it('a failed own-number send falls back to the Akeed number and is charged once', async () => {
    const source = await shopifyStore();
    const { sender } = await ownSender(source.orgId);
    const order = await shippedOrder(source);
    const before = await usage(source.integrationId);
    const send = jest.fn(
      async (
        params: Parameters<MessagingPort['sendVerificationTemplate']>[0],
      ) => {
        if (params.sender?.kind === 'merchant_own') {
          expect(
            await dispatches.authorizeMerchantAttempt(
              source.orgId,
              params.dispatchContext!.dispatchId,
              params.dispatchContext!.merchantAttempt!,
            ),
          ).toBe(true);
          throw new MerchantMessageFailure(
            classifyOwnNumberFailure({ code: 190 }),
          );
        }
        expect(params.buttonPayloads).toEqual([
          `sh1|home|${order.input.verificationId}`,
          `sh1|reschedule|${order.input.verificationId}`,
          `sh1|address|${order.input.verificationId}`,
        ]);
        expect(params.tracking).toBe('Tracking: 1Z999');
        return { messages: [{ id: 'wamid-fallback-' + randomUUID() }] };
      },
    );
    const service = sendService(source, send, sender);
    expect(await service.sendShipped(order.input.verificationId)).toMatchObject(
      { status: 'sent' },
    );
    expect(send).toHaveBeenCalledTimes(2);
    const rows = await dispatchesOf(order.input.verificationId);
    expect(rows).toHaveLength(2);
    const successor = rows.find((row) => row.fallbackForDispatchId);
    expect(successor).toMatchObject({
      kind: 'shipping_shipped',
      senderKind: 'akeed_system',
      state: 'accepted',
      billingPool: 'akeed',
    });
    const after = await usage(source.integrationId);
    expect(after.akeed + after.own - (before.akeed + before.own)).toBe(1);
    expect(after.own).toBe(before.own);
    expect(await recordOf(order.record.id)).toMatchObject({
      status: 'sent',
      dispatchId: successor!.id,
    });
    // The order's own status is the confirmation's, never the shipping message's.
    const [verification] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, order.input.verificationId));
    expect(verification).toMatchObject({ status: 'confirmed', attempts: 0 });
  });

  it('concurrent sends for one order make one dispatch, one provider call and one charge', async () => {
    const source = await shopifyStore();
    const order = await shippedOrder(source);
    const before = await usage(source.integrationId);
    const send = jest.fn(async () => {
      // Hold the first attempt open so the duplicates meet it in flight.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { messages: [{ id: 'wamid-' + randomUUID() }] };
    });
    const service = sendService(source, send, null);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        service.sendShipped(order.input.verificationId),
      ),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await dispatchesOf(order.input.verificationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'shipping_shipped',
      state: 'accepted',
      billingPool: 'akeed',
    });
    const after = await usage(source.integrationId);
    expect(after.akeed - before.akeed).toBe(1);
    expect(after.own).toBe(before.own);
    expect(await recordOf(order.record.id)).toMatchObject({
      status: 'sent',
      dispatchId: rows[0].id,
    });
  });

  it('a failed receipt refunds the charge once and fails the record', async () => {
    const source = await shopifyStore();
    const order = await shippedOrder(source);
    const service = sendService(
      source,
      () => Promise.resolve({ messages: [{ id: 'wamid-' + randomUUID() }] }),
      null,
    );
    await service.sendShipped(order.input.verificationId);
    const charged = await usage(source.integrationId);
    const [dispatch] = await dispatchesOf(order.input.verificationId);
    for (let i = 0; i < 2; i++)
      await dispatches.recordProviderStatus(
        dispatch.id,
        'failed',
        new Date(Date.now() + 1000).toISOString(),
        { code: 131026 },
      );
    expect((await usage(source.integrationId)).akeed).toBe(charged.akeed - 1);
    expect(await recordOf(order.record.id)).toMatchObject({
      status: 'failed',
      reasonCode: 'not_on_whatsapp',
    });
  });

  it('refuses a shipping message for a prepaid store before anything is held', async () => {
    const source = await merchant(5, 'standalone');
    const order = await shippedOrder(source);
    expect(await dispatches.claim(order.input)).toMatchObject({
      outcome: 'blocked',
      reason: 'shipping_prepaid_unsupported',
    });
    await harness.balance(source.orgId, 5, 0);
  });
});
