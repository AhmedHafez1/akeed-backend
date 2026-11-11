import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { VerificationChangeRequestsRepository } from '../src/infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { CommerceOutcomeSyncsRepository } from '../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import {
  ShopifyOutcomeAdapter,
  CHANGE_REQUEST_TAG,
} from '../src/infrastructure/spokes/shopify/services/shopify-outcome.adapter';
import { StandaloneOutcomeAdapter } from '../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import { ChangeRequestEffectsService } from '../src/modules/change-requests/change-request-effects.service';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../src/shared/config/usage-alerts.config';
import { customerRecipientHash } from '../src/shared/messaging/change-request-messaging';
import type { EmailMessage } from '../src/shared/ports/email.port';
import { WooCommerceOutcomeAdapter } from '../src/infrastructure/spokes/woocommerce/woocommerce-outcome.adapter';
import { EasyOrdersOutcomeAdapter } from '../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { WOOCOMMERCE_CONFIG } from '../src/shared/config/woocommerce.config';
import { EASYORDERS_CONFIG } from '../src/shared/config/easyorders.config';
import { WooCommerceOrderUpdateHandler } from '../src/infrastructure/spokes/woocommerce/woocommerce-order-update.handler';
import { EasyOrdersStatusUpdateHandler } from '../src/infrastructure/spokes/easyorders/easyorders-status-update.handler';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';

const h = creditUsageHarness();
const requests = new VerificationChangeRequestsRepository(h.db as never);
const syncs = new CommerceOutcomeSyncsRepository(h.db as never);
const orders = new OrdersRepository(h.db as never);
const dispatches = new VerificationMessageDispatchesRepository(
  h.db,
  h.router,
  new ConfigService({ WA_PHONE_NUMBER_ID: 'shared-phone' }),
);
const retries = { scheduleRetry: jest.fn().mockResolvedValue(undefined) };
const tracker = new CommerceOutcomeSyncTracker(syncs, retries as never);
const tags = new Map<string, Set<string>>();
const api = {
  addOrderTag: jest.fn((_source: unknown, orderId: string, tag: string) => {
    tags.get(orderId)!.add(tag);
    return Promise.resolve();
  }),
  removeOrderTags: jest.fn(
    (_source: unknown, orderId: string, remove: string[]) => {
      for (const tag of remove) tags.get(orderId)!.delete(tag);
      return Promise.resolve();
    },
  ),
};
const sourceConfig = new ConfigService({
  [WOOCOMMERCE_CONFIG]: { outcomeSyncEnabled: true },
  [EASYORDERS_CONFIG]: { outcomeSyncEnabled: true },
});
const registry = new CommerceOutcomeRegistryService(
  orders,
  [
    new ShopifyOutcomeAdapter(api as never),
    new StandaloneOutcomeAdapter(),
    new WooCommerceOutcomeAdapter({} as never, {} as never, sourceConfig),
    new EasyOrdersOutcomeAdapter(
      {} as never,
      {} as never,
      {} as never,
      sourceConfig,
    ),
  ],
  tracker,
  requests,
);
const accepted = new Map<string, EmailMessage>();
const email = {
  send: jest.fn((message: EmailMessage) => {
    accepted.set(message.idempotencyKey!, message);
    return Promise.resolve({ status: 'sent' as const });
  }),
};
const automation = {
  enqueueChangeRequestEffects: jest.fn().mockResolvedValue(undefined),
};
const settings = new ConfigService({
  [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig({
    EMAIL_ALERTS_ENABLED: 'true',
    RESEND_API_KEY: 'synthetic',
    EMAIL_FROM: 'alerts@example.test',
    FRONTEND_DASHBOARD_URL: 'https://app.example.test',
  }),
  SHOPIFY_API_KEY: 'synthetic-app',
});
const effects = new ChangeRequestEffectsService(
  requests,
  {
    findOwnerEmail: jest.fn().mockResolvedValue('owner@example.test'),
  } as never,
  email,
  settings,
  registry,
  automation as never,
);
beforeAll(h.setup);
afterAll(h.teardown);
beforeEach(() => {
  jest.clearAllMocks();
});

async function fixture(platform = 'shopify', zero = false) {
  const source = await h.merchant(1, platform);
  if (zero) await h.adjust(source.orgId, -1);
  await h.db
    .update(tables.integrations)
    .set({
      notificationEmail: 'notification@example.test',
      platformStoreUrl:
        platform === 'shopify'
          ? `synthetic-${source.integrationId}.myshopify.com`
          : `standalone:${source.orgId}`,
      accessToken: platform === 'shopify' ? 'synthetic-token' : null,
      defaultLanguage: 'en',
    })
    .where(eq(tables.integrations.id, source.integrationId));
  const verification = await h.verification(source);
  const first = await dispatches.claim({
    ...verification,
    billingExempt: true,
    recipientHash: customerRecipientHash('+201000000000'),
    changeRequestButtons: true,
    identity: { variantKey: 'en.default', purpose: 'initial', language: 'en' },
  });
  if (first.outcome !== 'claimed') throw new Error(first.outcome);
  const wamid = `wamid.${randomUUID()}`;
  await h.acceptance(first.dispatch, wamid);
  const tap = {
    verificationId: verification.verificationId,
    expectedOrgId: source.orgId,
    sourceProviderMessageId: wamid,
    cycle: 1,
    sender: { kind: 'akeed_system' as const, phoneNumberId: 'shared-phone' },
    recipientHash: customerRecipientHash('+201000000000'),
    requireChangeButton: true,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    shipping: 'unknown' as const,
  };
  const opened = await requests.open(tap);
  if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
  tags.set(opened.request.orderId, new Set());
  const order = await orders.findById(opened.request.orderId);
  tags.set(
    order!.externalOrderId,
    new Set(['Merchant: VIP', 'Akeed: No Reply']),
  );
  const command = {
    orgId: source.orgId,
    integrationId: source.integrationId,
    externalOrderId: order!.externalOrderId,
    correlationId: verification.verificationId,
    action: 'change_request_reconciliation' as const,
    retryInBackground: true,
  };
  return {
    source,
    verification,
    tap,
    request: opened.request,
    command,
    remote: tags.get(order!.externalOrderId)!,
  };
}

describe('merchant notifications and current-state platform effects over PostgreSQL', () => {
  it.each(['woocommerce', 'easyorders', 'standalone'])(
    'emails %s requests without inventing external request markers',
    async (source) => {
      const f = await fixture(source);
      await effects.drain(f.request.id);
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(api.addOrderTag).not.toHaveBeenCalled();
      expect(api.removeOrderTags).not.toHaveBeenCalled();
      expect(
        (await requests.findById(f.request.id, f.source.orgId))?.status,
      ).toBe('open');
      const marker = (
        await requests.listEffects(f.request.id, f.source.orgId)
      ).find((row) => row.kind === 'platform_marker_set');
      expect(marker?.status).toBe(source === 'standalone' ? 'done' : 'skipped');
    },
  );
  it('captures and emails at zero allowance without charging or sending a WhatsApp acknowledgement', async () => {
    const f = await fixture('standalone', true);
    const ledgerBefore = await h.db
      .select()
      .from(tables.creditLedgerEntries)
      .where(eq(tables.creditLedgerEntries.orgId, f.source.orgId));
    await Promise.all([
      effects.drain(f.request.id),
      effects.drain(f.request.id),
    ]);
    await requests.open({ ...f.tap, eventId: randomUUID() });
    await effects.drain(f.request.id);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].to).toBe('notification@example.test');
    await h.balance(f.source.orgId, 0, 0);
    const ledgerAfter = await h.db
      .select()
      .from(tables.creditLedgerEntries)
      .where(eq(tables.creditLedgerEntries.orgId, f.source.orgId));
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(
      (await requests.findById(f.request.id, f.source.orgId))?.status,
    ).toBe('open');
    expect(await requests.listEffects(f.request.id, f.source.orgId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'merchant_email', status: 'done' }),
        expect.objectContaining({
          kind: 'customer_acknowledgment',
          status: 'pending',
          attempts: 0,
        }),
      ]),
    );
    expect(api.addOrderTag).not.toHaveBeenCalled();
    expect(api.removeOrderTags).not.toHaveBeenCalled();
  });

  it('creates the active marker and removes only explicit Akeed status tags', async () => {
    const f = await fixture();
    await effects.drain(f.request.id);
    expect([...f.remote].sort()).toEqual(
      [CHANGE_REQUEST_TAG, 'Merchant: VIP'].sort(),
    );
    expect(
      (
        await syncs.findForOrder(
          f.source.orgId,
          f.source.integrationId,
          f.request.orderId,
        )
      )[0],
    ).toMatchObject({ state: 'succeeded', revision: 1, claimToken: null });
  });

  it.each(['confirmed', 'canceled'] as const)(
    'clears the marker after customer %s and rejects delayed set jobs',
    async (intent) => {
      const f = await fixture();
      await requests.applyCustomerAnswer({
        ...f.tap,
        occurredAt: new Date(Date.parse(f.tap.occurredAt) + 1000).toISOString(),
        eventId: randomUUID(),
        intent,
      });
      await effects.drain(f.request.id);
      expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(false);
      expect(
        f.remote.has(
          intent === 'confirmed' ? 'Akeed: Verified' : 'Akeed: Canceled',
        ),
      ).toBe(true);
      expect(f.remote.has('Merchant: VIP')).toBe(true);
      await registry.dispatch(f.command);
      expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(false);
    },
  );

  it('reconciles customer resolution that races an in-flight marker write', async () => {
    const f = await fixture();
    api.addOrderTag.mockImplementationOnce(async (_source, orderId, tag) => {
      await requests.applyCustomerAnswer({
        ...f.tap,
        occurredAt: new Date(Date.parse(f.tap.occurredAt) + 1000).toISOString(),
        eventId: randomUUID(),
        intent: 'confirmed',
      });
      tags.get(orderId)!.add(tag);
    });
    expect(await registry.dispatch(f.command)).toMatchObject({
      status: 'retryable_failure',
      errorCode: 'sync_revision_changed',
    });
    expect(
      (
        await syncs.findForOrder(
          f.source.orgId,
          f.source.integrationId,
          f.request.orderId,
        )
      )[0].state,
    ).toBe('pending');
    await registry.dispatch(f.command);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(false);
    expect(f.remote.has('Akeed: Verified')).toBe(true);
  });

  it('does not invalidate a reconciled open marker for later delivery/read receipts', async () => {
    const f = await fixture();
    await registry.dispatch(f.command);
    const before = api.addOrderTag.mock.calls.length;
    await h.db
      .update(tables.verifications)
      .set({ status: 'read' })
      .where(eq(tables.verifications.id, f.verification.verificationId));
    expect(await registry.dispatch(f.command)).toMatchObject({
      status: 'applied',
    });
    expect(api.addOrderTag).toHaveBeenCalledTimes(before);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(true);
  });

  it('serializes concurrent marker workers', async () => {
    const f = await fixture();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.removeOrderTags.mockImplementationOnce(async () => {
      await hold;
    });
    const first = registry.dispatch(f.command);
    // Wait until the first claim reached the controlled provider.
    for (let n = 0; n < 100 && api.removeOrderTags.mock.calls.length === 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const duplicate = await registry.dispatch(f.command);
    release();
    await first;
    expect(duplicate).toMatchObject({
      status: 'retryable_failure',
      errorCode: 'sync_in_progress',
    });
    expect(api.addOrderTag).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired claim and fences its late settlement', async () => {
    const f = await fixture();
    const current = await requests.platformState(
      f.verification.verificationId,
      f.source.orgId,
      f.request.orderId,
    );
    const old = await syncs.claimReconciliation(
      { ...f.command, orderId: f.request.orderId },
      current!.revision,
    );
    if (old.kind !== 'claimed') throw new Error(old.kind);
    await h.db
      .update(tables.commerceOutcomeSyncs)
      .set({ leaseUntil: new Date(Date.now() - 1).toISOString() })
      .where(eq(tables.commerceOutcomeSyncs.id, old.row.id));
    await requests.resolveByMerchantConfirmation({
      orgId: f.source.orgId,
      verificationId: f.verification.verificationId,
      actorUserId: randomUUID(),
    });
    await registry.dispatch(f.command);
    expect(
      await syncs.settle(
        old.row.id,
        f.source.orgId,
        {
          state: 'succeeded',
          errorCode: null,
          providerStatus: null,
          requiresAssistance: false,
          nextAttemptAt: null,
          spent: 'attempt',
        },
        old.row,
      ),
    ).toBeUndefined();
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(false);
    expect(f.remote.has('Akeed: Verified')).toBe(true);
  });

  it('does not let a stale no-reply retry restore an obsolete tag', async () => {
    const f = await fixture();
    await registry.dispatch(f.command);
    expect(
      await registry.dispatch({
        ...f.command,
        action: 'automatic_no_reply_tagging',
      }),
    ).toMatchObject({
      status: 'permanent_failure',
      errorCode: 'outcome_superseded',
    });
    expect(f.remote.has('Akeed: No Reply')).toBe(false);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(true);
  });

  it('clears on merchant cancellation through the same durable effects', async () => {
    const f = await fixture();
    await effects.drain(f.request.id);
    await requests.resolveByMerchantCancellation({
      orgId: f.source.orgId,
      verificationId: f.verification.verificationId,
      actorUserId: randomUUID(),
      operation: { status: 'applied' },
    });
    await effects.drain(f.request.id);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(false);
    expect(f.remote.has('Akeed: Canceled')).toBe(true);
  });

  it('preserves the requested Confirm/Cancel action while reconciling request tags', async () => {
    const f = await fixture();
    await requests.resolveByMerchantConfirmation({
      orgId: f.source.orgId,
      verificationId: f.verification.verificationId,
      actorUserId: randomUUID(),
    });
    expect(
      await registry.dispatch({
        ...f.command,
        action: 'customer_confirmation',
      }),
    ).toMatchObject({ status: 'applied', action: 'customer_confirmation' });
  });

  it('clears after successful reconfirmation and gives a genuine next-cycle request its own email', async () => {
    const f = await fixture();
    await effects.drain(f.request.id);
    const completed = await requests.completeReconfirmation({
      orgId: f.source.orgId,
      verificationId: f.verification.verificationId,
      changeRequestId: f.request.id,
      expectedCycle: 1,
      providerMessageId: `wamid.${randomUUID()}`,
      sentAt: new Date().toISOString(),
    });
    expect(completed.outcome).toBe('completed');
    await effects.drain(f.request.id);
    expect([...f.remote]).toEqual(['Merchant: VIP']);
    const next = await dispatches.claim({
      ...f.verification,
      confirmationCycle: 2,
      billingExempt: true,
      recipientHash: customerRecipientHash('+201000000000'),
      changeRequestButtons: true,
      identity: {
        variantKey: 'en.default',
        purpose: 'initial',
        language: 'en',
      },
    });
    if (next.outcome !== 'claimed') throw new Error(next.outcome);
    const wamid = `wamid.${randomUUID()}`;
    await h.acceptance(next.dispatch, wamid);
    const opened = await requests.open({
      ...f.tap,
      sourceProviderMessageId: wamid,
      cycle: 2,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
    if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
    await effects.drain(opened.request.id);
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(
      new Set(email.send.mock.calls.map(([message]) => message.idempotencyKey))
        .size,
    ).toBe(2);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(true);
  });

  it('replays a crashed email attempt with its frozen recipient and key', async () => {
    const f = await fixture('standalone');
    const claimed = await requests.claimEffect(
      'merchant_email',
      120_000,
      new Date(),
      f.request.id,
    );
    const payload: EmailMessage = {
      to: 'frozen@example.test',
      from: 'alerts@example.test',
      idempotencyKey: `change-request-${f.request.id}-initial`,
      subject: 'Synthetic',
      text: 'Synthetic request',
      html: '<p>Synthetic request</p>',
    };
    await requests.prepareEmail(claimed!, payload);
    accepted.set(payload.idempotencyKey!, payload); // Provider accepted just before the old worker stopped.
    await h.db
      .update(tables.verificationChangeRequestEffects)
      .set({ leaseUntil: new Date(Date.now() - 1).toISOString() })
      .where(eq(tables.verificationChangeRequestEffects.id, claimed!.id));
    const before = accepted.size;
    await effects.drain(f.request.id);
    expect(email.send).toHaveBeenCalledWith(payload);
    expect(accepted.size).toBe(before);
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).find(
        (row) => row.kind === 'merchant_email',
      )?.status,
    ).toBe('done');
  });

  it('keeps a failed platform update recoverable without losing the request', async () => {
    const f = await fixture();
    api.removeOrderTags.mockRejectedValueOnce(
      new Error('synthetic unavailable'),
    );
    await effects.drain(f.request.id);
    expect(
      (await requests.findById(f.request.id, f.source.orgId))?.status,
    ).toBe('open');
    expect(
      (
        await syncs.findForOrder(
          f.source.orgId,
          f.source.integrationId,
          f.request.orderId,
        )
      )[0],
    ).toMatchObject({ state: 'pending', errorCode: 'source_unavailable' });
    await registry.dispatch(f.command);
    expect(f.remote.has(CHANGE_REQUEST_TAG)).toBe(true);
  });

  it('preserves a request and its effects on ordinary order/tag updates', async () => {
    const f = await fixture();
    await effects.drain(f.request.id);
    await h.db
      .update(tables.orders)
      .set({
        rawPayload: {
          tags: [...f.remote],
          address: 'synthetic updated address',
        },
      })
      .where(eq(tables.orders.id, f.request.orderId));
    await effects.drain(f.request.id);
    expect(
      (await requests.findById(f.request.id, f.source.orgId))?.status,
    ).toBe('open');
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).find(
        (row) => row.kind === 'customer_acknowledgment',
      )?.attempts,
    ).toBe(0);
  });

  it.each(['woocommerce', 'easyorders'])(
    'ignores %s outcome webhook echoes while a request is open',
    async (platform) => {
      const f = await fixture(platform);
      await effects.drain(f.request.id);
      if (platform === 'woocommerce') {
        f.command.externalOrderId = '7001';
        await h.db
          .update(tables.orders)
          .set({ externalOrderId: '7001' })
          .where(eq(tables.orders.id, f.request.orderId));
      }
      const command = {
        ...f.command,
        action: 'customer_confirmation' as const,
      };
      const prior = await syncs.begin(
        { ...command, orderId: f.request.orderId },
        true,
      );
      await tracker.settle(prior, command, { status: 'applied' });
      const handler =
        platform === 'woocommerce'
          ? new WooCommerceOrderUpdateHandler(orders, syncs)
          : new EasyOrdersStatusUpdateHandler(orders, syncs);
      const payload =
        platform === 'woocommerce'
          ? {
              order: {
                id: 7001,
                status: 'processing',
                meta_data: [
                  {
                    key: 'akeed_outcome',
                    value: `customer_confirmation:${command.correlationId}`,
                  },
                ],
              },
            }
          : { order_id: command.externalOrderId, new_status: 'confirmed' };
      for (let replay = 0; replay < 2; replay++) {
        expect(
          await handler.handleOrderUpdate(
            payload,
            f.source.integrationId,
            f.source.orgId,
          ),
        ).toEqual({ skipped: true, reason: 'reflected_outcome' });
      }
      await effects.drain(f.request.id);
      expect(
        (await requests.findById(f.request.id, f.source.orgId))?.status,
      ).toBe('open');
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(
        (await requests.listEffects(f.request.id, f.source.orgId)).find(
          (row) => row.kind === 'customer_acknowledgment',
        )?.attempts,
      ).toBe(0);
    },
  );

  it('leaves Shopify tag-update echoes unhandled through the existing webhook worker', async () => {
    const f = await fixture();
    await effects.drain(f.request.id);
    const webhookEvents = {
      claimForProcessing: jest.fn().mockResolvedValue('claimed'),
      markSkipped: jest.fn().mockResolvedValue(undefined),
    };
    const hub = { handleNewOrder: jest.fn(), finalizeVerification: jest.fn() };
    const processor = new WebhookQueueProcessor(
      [],
      webhookEvents as never,
      {} as never,
      hub as never,
      [],
    );
    await processor.process({
      id: 'synthetic-tag-echo',
      data: {
        webhookEventId: randomUUID(),
        platform: 'shopify',
        jobType: WebhookJobType.ORDER_UPDATE,
        rawPayload: { id: f.command.externalOrderId, tags: [...f.remote] },
        orgId: f.source.orgId,
        integrationId: f.source.integrationId,
      },
    } as never);
    expect(webhookEvents.markSkipped).toHaveBeenCalledTimes(1);
    expect(hub.handleNewOrder).not.toHaveBeenCalled();
    expect(hub.finalizeVerification).not.toHaveBeenCalled();
    await effects.drain(f.request.id);
    expect(
      (await requests.findById(f.request.id, f.source.orgId))?.status,
    ).toBe('open');
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('scopes reads, summaries, claims and dispatches to the durable tenant', async () => {
    const f = await fixture();
    const other = randomUUID();
    expect(
      await requests.claimEffect(
        'merchant_email',
        120_000,
        new Date(),
        f.request.id,
        other,
      ),
    ).toBeNull();
    expect(await requests.findById(f.request.id, other)).toBeUndefined();
    expect(
      await requests.findOpenSummaries(other, [f.verification.verificationId]),
    ).toEqual([]);
    expect(
      await requests.platformState(
        f.verification.verificationId,
        other,
        f.request.orderId,
      ),
    ).toBeNull();
    expect(
      await registry.dispatch({ ...f.command, orgId: other }),
    ).toMatchObject({
      status: 'permanent_failure',
      errorCode: 'source_identity_mismatch',
    });
    expect(api.addOrderTag).not.toHaveBeenCalled();
    const [emailEffect] = await h.db
      .select()
      .from(tables.verificationChangeRequestEffects)
      .where(
        and(
          eq(
            tables.verificationChangeRequestEffects.changeRequestId,
            f.request.id,
          ),
          eq(tables.verificationChangeRequestEffects.kind, 'merchant_email'),
        ),
      );
    expect(emailEffect.emailPayload).toBeNull();
  });
});
