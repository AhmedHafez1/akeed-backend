/* eslint-disable @typescript-eslint/require-await -- Synthetic provider transports deliberately return promises without network I/O. */
import type { Server } from 'node:http';
import type { ChangeRequestView } from '../src/modules/verifications/change-request-merchant.service';
import type { VerificationListItemDto } from '../src/modules/orders/dto/dashboard.dto';
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { VerificationChangeRequestsRepository } from '../src/infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationAutoCancellationsRepository } from '../src/infrastructure/database/repositories/verification-auto-cancellations.repository';
import { CommerceOutcomeSyncsRepository } from '../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { WhatsappConnectionsRepository } from '../src/infrastructure/database/repositories/whatsapp-connections.repository';
import { CustomerMessagesRepository } from '../src/infrastructure/database/repositories/customer-messages.repository';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { CommerceOutcomeSyncTracker } from '../src/modules/commerce-outcomes/commerce-outcome-sync-tracker.service';
import {
  ShopifyOutcomeAdapter,
  CHANGE_REQUEST_TAG,
} from '../src/infrastructure/spokes/shopify/services/shopify-outcome.adapter';
import { StandaloneOutcomeAdapter } from '../src/infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import { WooCommerceOutcomeAdapter } from '../src/infrastructure/spokes/woocommerce/woocommerce-outcome.adapter';
import { EasyOrdersOutcomeAdapter } from '../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { EasyOrdersRateLimiter } from '../src/infrastructure/spokes/easyorders/easyorders-rate-limiter';
import { ChangeRequestLifecycleService } from '../src/modules/change-requests/change-request-lifecycle.service';
import { ChangeRequestAcknowledgmentService } from '../src/modules/change-requests/change-request-acknowledgment.service';
import { ChangeRequestEffectsService } from '../src/modules/change-requests/change-request-effects.service';
import { ChangeRequestReconfirmationService } from '../src/modules/verification-core/change-request-reconfirmation.service';
import { ChangeRequestMerchantService } from '../src/modules/verifications/change-request-merchant.service';
import { ChangeRequestsController } from '../src/modules/verifications/change-requests.controller';
import { VerificationsController } from '../src/modules/verifications/verifications.controller';
import { VerificationsService } from '../src/modules/verifications/verifications.service';
import { TestVerificationService } from '../src/modules/verifications/test-verification.service';
import { AutoCancellationService } from '../src/modules/auto-cancellation/auto-cancellation.service';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { WhatsAppWebhookController } from '../src/infrastructure/spokes/meta/whatsapp.webhook.controller';
import { MetaWebhookRoutingService } from '../src/infrastructure/spokes/meta/meta-webhook-routing.service';
import { MetaTemplateWebhookHandler } from '../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { TokenValidatorService } from '../src/modules/auth/services/token-validator.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import {
  customerButtonPayload,
  customerRecipientHash,
} from '../src/shared/messaging/change-request-messaging';
import { encryptToken } from '../src/shared/utils/token-encryption.util';
import {
  USAGE_ALERTS_CONFIG,
  parseUsageAlertsConfig,
} from '../src/shared/config/usage-alerts.config';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../src/shared/config/whatsapp-template.config';
import { WOOCOMMERCE_CONFIG } from '../src/shared/config/woocommerce.config';
import { EASYORDERS_CONFIG } from '../src/shared/config/easyorders.config';

// Only external identity validation and provider I/O are substituted. Guards,
// webhook routing, services, adapters, SQL and accounting remain executable.
const h = creditUsageHarness();
const config = new ConfigService({
  META_APP_SECRET: 'cr05-synthetic-signature-key',
  WA_PHONE_NUMBER_ID: 'shared-phone',
  SHOPIFY_API_KEY: 'synthetic-app',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
  [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({
    WA_BUSINESS_ACCOUNT_ID: '1000001',
  }),
  [WOOCOMMERCE_CONFIG]: { outcomeSyncEnabled: true },
  [EASYORDERS_CONFIG]: { outcomeSyncEnabled: true },
  [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig({
    EMAIL_ALERTS_ENABLED: 'true',
    RESEND_API_KEY: 'synthetic',
    EMAIL_FROM: 'alerts@example.test',
    FRONTEND_DASHBOARD_URL: 'https://app.example.test',
  }),
});
const requests = new VerificationChangeRequestsRepository(h.db as never);
const orders = new OrdersRepository(h.db as never);
const verifications = new VerificationsRepository(h.db as never);
const dispatches = new VerificationMessageDispatchesRepository(
  h.db,
  h.router,
  config,
);
const syncs = new CommerceOutcomeSyncsRepository(h.db as never);
const cancellations = new VerificationAutoCancellationsRepository(
  h.db as never,
);
const identities = new Map<string, AuthenticatedUser>();
const remote = new Map<
  string,
  { tags: Set<string>; status: string; markers: string[]; shipped: boolean }
>();
const connections = new Map<
  string,
  {
    orgId: string;
    integrationId: string;
    storeId: string;
    storeUrl: string;
    health: string;
    apiKeyEncrypted: string;
    consumerKeyEncrypted: string;
    consumerSecretEncrypted: string;
  }
>();
const shopify = {
  addOrderTag: jest.fn(async (_: unknown, id: string, tag: string) => {
    remote.get(id)!.tags.add(tag);
  }),
  removeOrderTags: jest.fn(async (_: unknown, id: string, tags: string[]) => {
    tags.forEach((tag) => remote.get(id)!.tags.delete(tag));
  }),
  getOrderCancellationState: jest.fn(async (_: unknown, id: string) => ({
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: remote.get(id)!.shipped
      ? 'FULFILLED'
      : 'UNFULFILLED',
    closed: false,
    cancelledAt: null,
  })),
  cancelOrder: jest.fn(async (_: unknown, id: string) => {
    remote.get(id)!.status = 'canceled';
    return { jobId: 'synthetic-job' };
  }),
};
const woo = {
  getOrder: jest.fn(async (_: unknown, _credentials: unknown, id: string) => ({
    kind: 'found',
    order: {
      id,
      status: remote.get(id)!.status,
      markers: remote.get(id)!.markers,
    },
  })),
  updateOrder: jest.fn(
    async (
      _: unknown,
      _credentials: unknown,
      id: string,
      update: { status?: string; marker: string },
    ) => {
      const state = remote.get(id)!;
      state.status = update.status ?? state.status;
      state.markers.push(update.marker);
      return {
        kind: 'updated',
        order: { id, status: state.status, markers: state.markers },
      };
    },
  ),
  addOrderNote: jest.fn(async () => ({ kind: 'created' })),
};
const easy = {
  getOrder: jest.fn(async (_: unknown, id: string) => ({
    kind: 'found',
    order: { id, store_id: id, status: remote.get(id)!.status },
  })),
  updateOrderStatus: jest.fn(async (_: unknown, id: string, status: string) => {
    remote.get(id)!.status = status;
    return { kind: 'updated' };
  }),
};
const sourceConnections = {
  findByIntegration: async (id: string) => connections.get(id),
  setHealth: async () => undefined,
};
const automation = {
  enqueueChangeRequestEffects: jest.fn(async () => undefined),
  cancelPendingReminders: jest.fn(async () => undefined),
};
const tracker = new CommerceOutcomeSyncTracker(syncs, {
  scheduleRetry: jest.fn(async () => undefined),
} as never);
const commerce = new CommerceOutcomeRegistryService(
  orders,
  [
    new ShopifyOutcomeAdapter(shopify as never),
    new StandaloneOutcomeAdapter(),
    new WooCommerceOutcomeAdapter(
      sourceConnections as never,
      woo as never,
      config,
    ),
    new EasyOrdersOutcomeAdapter(
      sourceConnections as never,
      easy as never,
      new EasyOrdersRateLimiter(),
      config,
    ),
  ],
  tracker,
  requests,
);
const lifecycle = new ChangeRequestLifecycleService(
  requests,
  verifications,
  commerce,
  automation as never,
);
const messaging = {
  sendFreeFormText: jest.fn(async () => ({
    outcome: 'accepted' as const,
    providerMessageId: `ack-${randomUUID()}`,
  })),
};
const acknowledgments = new ChangeRequestAcknowledgmentService(
  requests,
  dispatches,
  orders,
  messaging as never,
);
const email = { send: jest.fn(async () => ({ status: 'sent' as const })) };
const effects = new ChangeRequestEffectsService(
  requests,
  { findOwnerEmail: async () => 'owner@example.test' } as never,
  email,
  config,
  commerce,
  automation as never,
);
const hub = new VerificationHubService(
  orders,
  verifications,
  commerce,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  automation as never,
);
const reconfirmations = new ChangeRequestReconfirmationService(
  requests,
  verifications,
  orders,
  undefined as never,
  hub,
  commerce,
  automation as never,
);
const merchant = new ChangeRequestMerchantService(
  requests,
  lifecycle,
  reconfirmations,
  hub,
  commerce,
  verifications,
  orders,
  cancellations,
);
const billing = new BillingEntitlementService(
  new IntegrationMonthlyUsageRepository(h.db as never),
  h.router,
);
const listings = new VerificationsService(
  verifications,
  billing,
  new IntegrationsRepository(h.db as never, config),
  orders,
  commerce,
  hub,
  syncs,
  cancellations,
  requests,
);
const customers = new CustomerMessagesRepository(h.db as never);
const webhook = new WhatsAppWebhookService(
  verifications,
  hub,
  dispatches,
  undefined,
  undefined,
  undefined,
  automation as never,
  cancellations,
  undefined,
  customers,
  requests,
  lifecycle,
  acknowledgments,
);
const templates = { handle: async () => undefined };
const routing = new MetaWebhookRoutingService(
  config,
  new WhatsappConnectionsRepository(h.db as never),
  customers,
  webhook,
  templates as never,
  {} as never,
);
let app: INestApplication;
function server(): Server {
  return app.getHttpServer() as Server;
}
function bodyOf(response: { body: unknown }): {
  change_request: ChangeRequestView;
  data: VerificationListItemDto[];
  status: string;
} {
  return response.body as {
    change_request: ChangeRequestView;
    data: VerificationListItemDto[];
    status: string;
  };
}

beforeAll(async () => {
  await h.setup();
  const module = await Test.createTestingModule({
    controllers: [
      WhatsAppWebhookController,
      ChangeRequestsController,
      VerificationsController,
    ],
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: WhatsAppWebhookService, useValue: webhook },
      { provide: MetaWebhookRoutingService, useValue: routing },
      { provide: MetaTemplateWebhookHandler, useValue: templates },
      { provide: ChangeRequestMerchantService, useValue: merchant },
      { provide: VerificationsService, useValue: listings },
      { provide: TestVerificationService, useValue: {} },
      { provide: AutoCancellationService, useValue: {} },
      {
        provide: TokenValidatorService,
        useValue: {
          validateToken: async (token: string) => {
            const identity = identities.get(token);
            if (!identity) throw new UnauthorizedException();
            return identity;
          },
        },
      },
    ],
  }).compile();
  app = module.createNestApplication({ rawBody: true });
  app.useLogger(false);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await h.teardown();
});

type Source = 'standalone' | 'shopify' | 'woocommerce' | 'easyorders';
type Sender = 'akeed_system' | 'merchant_own';
const matrix = (
  ['standalone', 'shopify', 'woocommerce', 'easyorders'] as Source[]
).flatMap((source) =>
  (['akeed_system', 'merchant_own'] as Sender[]).map((sender) => ({
    source,
    sender,
  })),
);

async function fixture(
  source: Source = 'standalone',
  sender: Sender = 'akeed_system',
  zero = false,
) {
  // Start a prepaid account for non-Shopify sources, then assign its actual source.
  const tenant = await h.merchant(
    10,
    source === 'shopify' ? 'shopify' : 'standalone',
  );
  await h.db
    .update(tables.integrations)
    .set({
      platformType: source,
      notificationEmail: 'merchant@example.test',
      storeName: 'Synthetic store',
      defaultLanguage: 'en',
      timezone: 'UTC',
      platformStoreUrl:
        source === 'shopify'
          ? `synthetic-${tenant.orgId}.myshopify.com`
          : `https://${tenant.orgId}.example.test`,
      accessToken: 'synthetic',
      quietHoursEnabled: true,
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
    })
    .where(eq(tables.integrations.id, tenant.integrationId));
  if (zero) await h.adjust(tenant.orgId, -10);
  const v = await h.verification(tenant);
  const order = (await verifications.findById(v.verificationId))!;
  // WooCommerce's existing adapter requires a numeric source order identifier.
  const externalId = String(100000 + remote.size);
  await h.db
    .update(tables.orders)
    .set({
      externalOrderId: externalId,
      orderNumber: 'CR05-42',
      customerName: 'Synthetic customer',
      currency: 'EGP',
    })
    .where(eq(tables.orders.id, order.orderId));
  remote.set(externalId, {
    tags: new Set(['Merchant: VIP']),
    status: source === 'woocommerce' ? 'processing' : 'pending',
    markers: [],
    shipped: false,
  });
  connections.set(tenant.integrationId, {
    ...tenant,
    storeId: externalId,
    storeUrl: 'https://store.example.test',
    health: 'ok',
    apiKeyEncrypted: encryptToken('synthetic-api-key', 'k'.repeat(32)),
    consumerKeyEncrypted: encryptToken('ck_synthetic', 'k'.repeat(32)),
    consumerSecretEncrypted: encryptToken('cs_synthetic', 'k'.repeat(32)),
  });
  const [connection] =
    sender === 'merchant_own'
      ? await h.db
          .insert(tables.whatsappConnections)
          .values({
            orgId: tenant.orgId,
            wabaId: randomUUID(),
            phoneNumberId: randomUUID(),
            signupPath: 'coexistence',
            state: 'active',
          })
          .returning()
      : [];
  const sent = await dispatches.claim({
    ...v,
    billingExempt: true,
    recipientHash: customerRecipientHash('+201000000000'),
    changeRequestButtons: true,
    identity: { variantKey: 'en.default', purpose: 'initial', language: 'en' },
    sender: {
      kind: sender,
      connectionId: connection?.id ?? null,
      reason: 'synthetic',
      units: 1,
    },
  });
  if (sent.outcome !== 'claimed') throw new Error(sent.outcome);
  const wamid = `wamid.${randomUUID()}`;
  await h.acceptance(sent.dispatch, wamid);
  const token = randomUUID();
  identities.set(token, {
    userId: randomUUID(),
    orgId: tenant.orgId,
    role: 'owner',
    source: source === 'shopify' ? 'shopify' : 'supabase',
  });
  return {
    ...tenant,
    ...v,
    externalId,
    token,
    sender,
    phone: connection?.phoneNumberId ?? 'shared-phone',
    waba: connection?.wabaId ?? '1000001',
    wamid,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function payload(
  f: Fixture,
  action: 'change_requested' | 'confirmed' | 'canceled',
  seconds = Math.floor(Date.now() / 1000),
  eventId = randomUUID(),
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: f.waba,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: f.phone },
              messages: [
                {
                  id: eventId,
                  type: 'button',
                  from: '201000000000',
                  timestamp: String(seconds),
                  context: { id: f.wamid },
                  button: {
                    text: action,
                    payload: customerButtonPayload(action, f.verificationId, 1),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
async function tap(
  f: Fixture,
  action: 'change_requested' | 'confirmed' | 'canceled',
  seconds?: number,
) {
  const body = JSON.stringify(payload(f, action, seconds));
  return request(server())
    .post('/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set(
      'x-hub-signature-256',
      'sha256=' +
        createHmac('sha256', 'cr05-synthetic-signature-key')
          .update(body)
          .digest('hex'),
    )
    .send(body)
    .expect(200);
}
function api(f: Fixture) {
  return request(server())
    .get(`/api/verifications/${f.verificationId}/change-request`)
    .auth(f.token, { type: 'bearer' });
}
async function capture(f: Fixture) {
  await tap(f, 'change_requested');
  const opened = await requests.findOpenForVerification(
    f.verificationId,
    f.orgId,
  );
  expect(opened).toBeDefined();
  await effects.drain(opened!.id, f.orgId);
  const response = await api(f).expect(200);
  expect(bodyOf(response).change_request).toMatchObject({
    status: 'open',
    acknowledgment: { status: 'done' },
    merchant_email: { status: 'done' },
  });
  return opened!;
}

describe('complete HTTP request lifecycle across real source adapters and both senders', () => {
  it.each(matrix)(
    'captures, emails, lists and merchant-confirms $source / $sender',
    async ({ source, sender }) => {
      const f = await fixture(source, sender);
      const ackBefore = messaging.sendFreeFormText.mock.calls.length;
      const emailBefore = email.send.mock.calls.length;
      const opened = await capture(f);
      const list = await request(server())
        .get('/api/verifications?tab=change_requested')
        .auth(f.token, { type: 'bearer' })
        .expect(200);
      expect(
        bodyOf(list).data.find((row) => row.id === f.verificationId)
          ?.change_request?.id,
      ).toBe(opened.id);
      await tap(f, 'change_requested');
      await effects.drain(opened.id, f.orgId);
      expect(messaging.sendFreeFormText.mock.calls.length - ackBefore).toBe(1);
      expect(email.send.mock.calls.length - emailBefore).toBe(1);
      if (source === 'shopify')
        expect(remote.get(f.externalId)!.tags.has(CHANGE_REQUEST_TAG)).toBe(
          true,
        );
      await request(server())
        .post(`/api/verifications/${f.verificationId}/change-request/confirm`)
        .auth(f.token, { type: 'bearer' })
        .send({ changeRequestId: opened.id })
        .expect(200);
      await effects.drain(opened.id, f.orgId);
      expect(bodyOf(await api(f)).change_request).toMatchObject({
        status: 'resolved',
        resolution: 'merchant_confirmed',
      });
      if (source === 'shopify') {
        expect(remote.get(f.externalId)!.tags).toEqual(
          new Set(['Merchant: VIP', 'Akeed: Verified']),
        );
      } else if (source === 'easyorders')
        expect(remote.get(f.externalId)!.status).toBe('confirmed');
      else if (source === 'woocommerce')
        expect(remote.get(f.externalId)!.markers.length).toBe(1);
    },
  );
  it.each(matrix)(
    'merchant cancellation follows existing synchronization for $source / $sender',
    async ({ source, sender }) => {
      const f = await fixture(source, sender);
      const opened = await capture(f);
      const response = await request(server())
        .post(`/api/verifications/${f.verificationId}/change-request/cancel`)
        .auth(f.token, { type: 'bearer' })
        .send({ changeRequestId: opened.id })
        .expect(200);
      expect(bodyOf(response).status).toBe('canceled');
      await effects.drain(opened.id, f.orgId);
      expect(bodyOf(await api(f)).change_request).toMatchObject({
        status: 'resolved',
        resolution: 'merchant_canceled',
      });
      expect((await verifications.findById(f.verificationId))?.status).toBe(
        'canceled',
      );
      if (source === 'shopify') {
        expect(remote.get(f.externalId)!.tags.has(CHANGE_REQUEST_TAG)).toBe(
          false,
        );
        expect(remote.get(f.externalId)!.tags.has('Merchant: VIP')).toBe(true);
      } else if (source !== 'standalone')
        expect(remote.get(f.externalId)!.status).toBe(
          source === 'woocommerce' ? 'cancelled' : 'canceled',
        );
    },
  );
  it.each(
    matrix.flatMap((item) =>
      (['confirmed', 'canceled'] as const).map((action) => ({
        ...item,
        action,
      })),
    ),
  )(
    'customer $action closes $source / $sender without merchant contact',
    async ({ source, sender, action }) => {
      const f = await fixture(source, sender);
      const opened = await capture(f);
      await tap(f, action, Math.floor(Date.now() / 1000) + 1);
      await effects.drain(opened.id, f.orgId);
      expect(bodyOf(await api(f)).change_request).toMatchObject({
        status: 'resolved',
        resolution:
          action === 'confirmed' ? 'customer_confirmed' : 'customer_canceled',
      });
      expect((await verifications.findById(f.verificationId))?.status).toBe(
        action,
      );
      await request(server())
        .post(`/api/verifications/${f.verificationId}/change-request/confirm`)
        .auth(f.token, { type: 'bearer' })
        .send({ changeRequestId: opened.id })
        .expect(409);
    },
  );
  it('keeps guards active for unsigned, invalid-token, viewer and other-tenant requests', async () => {
    const f = await fixture();
    const other = await fixture();
    await request(server())
      .post('/webhooks/whatsapp')
      .send(payload(f, 'change_requested'))
      .expect(401);
    expect(
      await requests.findOpenForVerification(f.verificationId, f.orgId),
    ).toBeUndefined();
    const opened = await capture(f);
    await request(server())
      .get(`/api/verifications/${f.verificationId}/change-request`)
      .expect(401);
    await request(server())
      .get(`/api/verifications/${f.verificationId}/change-request`)
      .auth('invalid', { type: 'bearer' })
      .expect(401);
    await request(server())
      .get(`/api/verifications/${f.verificationId}/change-request`)
      .auth(other.token, { type: 'bearer' })
      .expect(404);
    for (const action of ['confirm', 'cancel', 'resend']) {
      await request(server())
        .post(`/api/verifications/${f.verificationId}/change-request/${action}`)
        .auth(other.token, { type: 'bearer' })
        .send({
          changeRequestId: opened.id,
          ...(action === 'resend' ? { expectedCycle: 1 } : {}),
        })
        .expect(404);
    }
    const viewerToken = randomUUID();
    identities.set(viewerToken, {
      ...identities.get(f.token)!,
      role: 'viewer',
    });
    await request(server())
      .post(`/api/verifications/${f.verificationId}/change-request/confirm`)
      .auth(viewerToken, { type: 'bearer' })
      .send({ changeRequestId: opened.id })
      .expect(403);
    expect(bodyOf(await api(f)).change_request.status).toBe('open');
  });
  it('preserves zero-allowance capture and email without sending later after top-up', async () => {
    const f = await fixture('standalone', 'akeed_system', true);
    const count = messaging.sendFreeFormText.mock.calls.length;
    await tap(f, 'change_requested');
    const opened = (await requests.findOpenForVerification(
      f.verificationId,
      f.orgId,
    ))!;
    await effects.drain(opened.id, f.orgId);
    expect(bodyOf(await api(f)).change_request).toMatchObject({
      status: 'open',
      acknowledgment: { status: 'skipped', reason: 'skipped_no_allowance' },
      merchant_email: { status: 'done' },
    });
    await h.adjust(f.orgId, 10);
    await acknowledgments.drain(opened.id);
    await tap(f, 'change_requested');
    expect(messaging.sendFreeFormText.mock.calls.length).toBe(count);
    await h.balance(f.orgId, 10, 0);
  });
  it('keeps the request actionable after messaging uncertainty and email failure', async () => {
    const f = await fixture();
    const count = messaging.sendFreeFormText.mock.calls.length;
    messaging.sendFreeFormText.mockImplementationOnce(async () => {
      throw new Error('synthetic timeout');
    });
    email.send.mockImplementationOnce(async () => {
      throw new Error('synthetic email outage');
    });
    await tap(f, 'change_requested');
    const opened = (await requests.findOpenForVerification(
      f.verificationId,
      f.orgId,
    ))!;
    await effects.drain(opened.id, f.orgId);
    expect(bodyOf(await api(f)).change_request).toMatchObject({
      status: 'open',
      acknowledgment: {
        status: 'failed',
        reason: 'provider_outcome_uncertain',
      },
      merchant_email: { status: 'pending', reason: 'provider_outcome_unknown' },
    });
    await acknowledgments.drain(opened.id);
    expect(messaging.sendFreeFormText.mock.calls.length - count).toBe(1);
  });
  it('rejects known-shipped orders through the actual source inspection', async () => {
    const f = await fixture('shopify');
    remote.get(f.externalId)!.shipped = true;
    await tap(f, 'change_requested');
    expect(
      await requests.findOpenForVerification(f.verificationId, f.orgId),
    ).toBeUndefined();
  });
});

(process.env.CR05_RUN_BROWSER === 'true' ? it : it.skip)(
  'browser resolves the real persisted request through the production panel and guarded API',
  async () => {
    const f = await fixture();
    const opened = await capture(f);
    identities.set('cr05-browser', identities.get(f.token)!);
    await app.listen(0, '127.0.0.1');
    const backendUrl = await app.getUrl();
    const frontend = resolve(__dirname, '../../akeed-frontend');
    await promisify(execFile)(
      process.execPath,
      [
        resolve(frontend, 'node_modules/@playwright/test/cli.js'),
        'test',
        'test/e2e/change-request-release.spec.ts',
        '--config',
        'playwright.change-requests.config.ts',
        '--grep',
        'integrated',
      ],
      {
        cwd: frontend,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          // Next's Windows ESM config loader treats this as an in-process
          // Jest import unless the inherited worker marker is cleared.
          JEST_WORKER_ID: '',
          CR05_BACKEND_URL: backendUrl,
          CR05_VERIFICATION_ID: f.verificationId,
        },
        timeout: 360_000,
        maxBuffer: 4_000_000,
      },
    );
    expect((await requests.findById(opened.id, f.orgId))?.resolution).toBe(
      'merchant_confirmed',
    );
  },
  420_000,
);
