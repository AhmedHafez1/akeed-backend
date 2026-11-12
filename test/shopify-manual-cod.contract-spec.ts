import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import * as tables from '../src/infrastructure/database/schema';
import { ShopifyOrderEligibilityStrategy } from '../src/infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { ShopifyOrderNormalizer } from '../src/infrastructure/spokes/shopify/services/shopify-order.normalizer';
import { shopifyOrderFixture } from '../src/infrastructure/spokes/shopify/services/fixtures/shopify-order.fixture';
import { PeriodicPlanAccounting } from '../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../src/infrastructure/database/repositories/usage-accounting.router';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookQueueProducer } from '../src/modules/webhook-queue/webhook-queue.producer';
import { seededTemplateRegistry } from '../src/shared/messaging/testing/seeded-template-registry';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { PhoneService } from '../src/shared/services/phone.service';
import { releaseGateHarness } from './contracts/release-gate-harness';

/**
 * A Shopify COD order form reports the generic `manual` gateway, and Shopify
 * delivers each such order twice under different webhook ids, less than a
 * second apart. Over real PostgreSQL, through the real producer, queue
 * processor, hub, send service and dispatch ledger, both deliveries processed
 * at the same time make one order, one verification and one message.
 */
const gate = releaseGateHarness();
const { db } = gate;
const { orders, verifications, events, dispatches, credits, integrations } =
  gate.repositories;

const sends: string[] = [];
const messaging: MessagingPort = {
  sendVerificationTemplate(params) {
    sends.push(params.verificationId);
    return Promise.resolve({ messages: [{ id: `wamid-${sends.length}` }] });
  },
};

const router = new UsageAccountingRouter(
  new PrepaidCreditAccounting(credits),
  new PeriodicPlanAccounting(),
  gate.config,
);
const billing = new BillingEntitlementService(
  new IntegrationMonthlyUsageRepository(db),
  router,
);
const creditEligibility = new CreditEligibilityService(credits, gate.config);
const send = new VerificationSendService(
  verifications,
  orders,
  billing,
  creditEligibility,
  dispatches,
  messaging,
  seededTemplateRegistry(),
);
const hub = new VerificationHubService(
  orders,
  verifications,
  new CommerceOutcomeRegistryService(orders, []),
  new OrderEligibilityService([new ShopifyOrderEligibilityStrategy()]),
  send,
  billing,
  creditEligibility,
  {
    enqueueInitialSend: () => Promise.resolve(),
    enqueueFollowUp: () => Promise.resolve(),
    enqueueNoReplyEscalation: () => Promise.resolve(),
  } as never,
);
const processor = new WebhookQueueProcessor(
  [new ShopifyOrderNormalizer(new PhoneService())],
  events,
  integrations,
  hub,
);
const queued: WebhookJobPayload[] = [];
const producer = new WebhookQueueProducer(
  events,
  integrations,
  new WebhookDispatchService(
    {
      add: (_name: string, payload: WebhookJobPayload) => {
        queued.push(payload);
        return Promise.resolve();
      },
    } as never,
    events,
    { get: () => undefined } as never,
  ),
);

async function shopifyStore() {
  const orgId = randomUUID();
  const storeDomain = `manual-cod-${orgId.slice(0, 8)}.myshopify.com`;
  await db
    .insert(tables.organizations)
    .values({ id: orgId, name: 'Manual COD store', slug: orgId });
  const [integration] = await db
    .insert(tables.integrations)
    .values({
      orgId,
      platformType: 'shopify',
      platformStoreUrl: storeDomain,
      storeName: 'Manual COD store',
      isActive: true,
      onboardingStatus: 'completed',
      isAutoVerifyEnabled: true,
      followUpEnabled: false,
      escalationEnabled: false,
      quietHoursEnabled: false,
      sendDelayMinutes: 0,
      timezone: 'Africa/Cairo',
      countryCode: 'EG',
      billingStatus: 'active',
      billingActivatedAt: new Date().toISOString(),
    })
    .returning();
  return { orgId, integrationId: integration.id, storeDomain };
}

function deliver(storeDomain: string, webhookId: string) {
  return producer.ingest({
    platform: 'shopify',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: webhookId,
    storeDomain,
    rawPayload: shopifyOrderFixture({
      id: 1358,
      order_number: 1358,
      payment_gateway_names: ['manual'],
      financial_status: 'pending',
    }),
  });
}

describe('Shopify manual unpaid orders over PostgreSQL', () => {
  beforeAll(() => gate.setup(), 60_000);
  afterAll(() => gate.teardown());
  beforeEach(() => {
    sends.length = 0;
    queued.length = 0;
  });

  it('two deliveries of one manual order, processed together, make one order, one verification and one message', async () => {
    const store = await shopifyStore();
    await Promise.all([
      deliver(store.storeDomain, `webhook-${randomUUID()}`),
      deliver(store.storeDomain, `webhook-${randomUUID()}`),
    ]);
    expect(queued).toHaveLength(2);

    const results = await Promise.allSettled(
      queued.map((payload) =>
        processor.process({
          id: `job-${payload.webhookEventId}`,
          data: payload,
          attemptsMade: 0,
          opts: { attempts: 5 },
        } as unknown as Job<WebhookJobPayload>),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);

    const storedOrders = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.integrationId, store.integrationId));
    expect(storedOrders).toHaveLength(1);
    expect(storedOrders[0]).toMatchObject({
      externalOrderId: '1358',
      paymentMethod: 'manual',
    });
    const storedVerifications = await db
      .select()
      .from(tables.verifications)
      .where(eq(tables.verifications.orderId, storedOrders[0].id));
    expect(storedVerifications).toHaveLength(1);
    const ledger = await db
      .select()
      .from(tables.verificationMessageDispatches)
      .where(
        eq(
          tables.verificationMessageDispatches.verificationId,
          storedVerifications[0].id,
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(sends).toEqual([storedVerifications[0].id]);

    const storedEvents = await db
      .select({ status: tables.webhookEvents.status })
      .from(tables.webhookEvents)
      .where(eq(tables.webhookEvents.integrationId, store.integrationId));
    expect(storedEvents.map((event) => event.status).sort()).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('a paid manual order is skipped and nothing is sent', async () => {
    const store = await shopifyStore();
    await producer.ingest({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: `webhook-${randomUUID()}`,
      storeDomain: store.storeDomain,
      rawPayload: shopifyOrderFixture({
        payment_gateway_names: ['manual'],
        financial_status: 'paid',
      }),
    });
    for (const payload of queued.splice(0)) {
      await processor.process({
        id: `job-${payload.webhookEventId}`,
        data: payload,
      } as Job<WebhookJobPayload>);
    }

    expect(
      await db
        .select()
        .from(tables.orders)
        .where(eq(tables.orders.integrationId, store.integrationId)),
    ).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
