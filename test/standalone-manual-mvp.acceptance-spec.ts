import { usageAccountingFixture } from 'contracts/usage-accounting-fixture';
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import {
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import type { Job } from 'bullmq';
import { CommerceOutcomeRegistryService } from '../src/modules/commerce-outcomes/commerce-outcome-registry.service';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { StandaloneOrderEligibilityStrategy } from '../src/infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { StandaloneManualOrderNormalizer } from '../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookQueueProcessor } from '../src/modules/webhook-queue/webhook-queue.processor';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import type { WebhookJobPayload } from '../src/modules/webhook-queue/interfaces/webhook-job.interface';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { TestVerificationService } from '../src/modules/verifications/test-verification.service';
import { VerificationHubService } from '../src/modules/verification-core/verification-hub.service';
import { OrderEligibilityService } from '../src/modules/verification-core/order-eligibility.service';
import { CreditApprovalService } from '../src/modules/verification-core/credit-approval.service';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { PhoneService } from '../src/shared/services/phone.service';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { DualAuthGuard } from '../src/modules/auth/guards/dual-auth.guard';
import { integrations, orders } from '../src/infrastructure/database/schema';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import {
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceInput,
  type ManualOrderAcceptanceResult,
} from '../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import type {
  DispatchAcceptanceResult,
  DispatchClaimResult,
  DispatchRecord,
} from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import type { VerificationStatus } from '../src/shared/interfaces/verification.interface';

type IntegrationRecord = typeof integrations.$inferSelect;
type OrderInsert = Parameters<OrdersRepository['create']>[0];
type VerificationInsert = Parameters<
  VerificationsRepository['createForOrderIfAbsent']
>[0];
type VerificationUpdate = Parameters<
  VerificationsRepository['updateByIdForOrg']
>[2];

interface StoredEvent {
  id: string;
  platform: 'standalone';
  jobType: WebhookJobType;
  idempotencyKey: string;
  storeDomain: string;
  orgId: string;
  integrationId: string;
  orderId: string;
  rawPayload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'skipped';
  lastError: string | null;
}

interface StoredVerification {
  id: string;
  orgId: string;
  orderId: string;
  status: VerificationStatus;
  waMessageId: string | null;
  templateName: string;
  languageCode: string;
  attempts: number;
  lastSentAt: string | null;
  confirmedAt: string | null;
  canceledAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  noReplyAt: string | null;
  merchantCanceledAt: string | null;
  cancellationSource: string | null;
  followUpAttempts: number;
  followUpSentAt: string | null;
  metadata: Record<string, unknown>;
}

type StoredOrder = typeof orders.$inferSelect & {
  integration: IntegrationRecord;
  verifications: StoredVerification[];
  webhookEvents: StoredEvent[];
};

interface AcceptanceStore {
  integration: IntegrationRecord;
  orders: Map<string, StoredOrder>;
  verifications: Map<string, StoredVerification>;
  events: Map<string, StoredEvent>;
  dispatches: Map<string, DispatchRecord>;
  usageCount: number;
  providerMessageCount: number;
  providerMode: 'success' | 'timeout';
  queueFailure: boolean;
  dispatchCalls: number;
  shopifyCalls: number;
  addOrder(data: OrderInsert): StoredOrder;
}

interface AcceptanceHarness {
  app: INestApplication<Server>;
  store: AcceptanceStore;
  user: AuthenticatedUser;
  sessionRevoked: boolean;
  testVerification: TestVerificationService;
  ordersService: OrdersService;
  verificationSend: VerificationSendService;
  processor: WebhookQueueProcessor;
  webhook: WhatsAppWebhookService;
  provider: MessagingPort & {
    calls: Parameters<MessagingPort['sendVerificationTemplate']>[0][];
  };
  standaloneAdapter: { execute: jest.Mock };
  shopifyAdapter: { execute: jest.Mock };
}

function createIntegration(): IntegrationRecord {
  return {
    id: 'integration-standalone-1',
    orgId: 'org-standalone-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-standalone-1',
    accessToken: null,
    webhookSecret: null,
    isActive: true,
    storeName: 'Synthetic merchant',
    defaultLanguage: 'en',
    shippingCurrency: 'USD',
    averageShippingCost: '3.00',
    isAutoVerifyEnabled: true,
    assumeCodWhenPaymentMissing: false,
    onboardingStatus: 'completed',
    billingPlanId: 'starter',
    billingStatus: 'not_required',
    billingActivatedAt: '2026-09-01T00:00:00.000Z',
    shopifySubscriptionId: null,
    followUpEnabled: false,
    followUpDelayMinutes: 0,
    escalationEnabled: false,
    escalationDelayMinutes: 0,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Africa/Cairo',
    sendDelayMinutes: 0,
    codTemplateArVariant: null,
    codTemplateEnVariant: null,
    metadata: {},
  } as unknown as IntegrationRecord;
}

function createStore(): AcceptanceStore {
  const integration = createIntegration();
  const store: AcceptanceStore = {
    integration,
    orders: new Map(),
    verifications: new Map(),
    events: new Map(),
    dispatches: new Map(),
    usageCount: 0,
    providerMessageCount: 0,
    providerMode: 'success',
    queueFailure: false,
    dispatchCalls: 0,
    shopifyCalls: 0,
    addOrder(data) {
      const id = `order-${this.orders.size + 1}`;
      const createdAt = new Date(
        Date.UTC(2026, 8, 5, 10, this.orders.size, 0),
      ).toISOString();
      const order = {
        ...data,
        id,
        createdAt,
        updatedAt: createdAt,
        integration: this.integration,
        verifications: [],
        webhookEvents: [],
      } as unknown as StoredOrder;
      this.orders.set(id, order);
      return order;
    },
  };
  return store;
}

function createDispatch(params: {
  id: string;
  orgId: string;
  integrationId: string;
  verificationId: string;
  dispatchKey: string;
  kind: 'initial' | 'follow_up';
  templateName: string;
  languageCode: string;
  state: 'sending' | 'accepted' | 'outcome_unknown';
  providerMessageId?: string | null;
}): DispatchRecord {
  return {
    ...params,
    senderKind: 'akeed_system',
    providerMessageId: params.providerMessageId ?? null,
    usagePeriodStart: '2026-09-01',
    usageReserved: true,
    attemptCount: 1,
    lastErrorCode: null,
    leaseUntil: null,
    acceptedAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    resolvedAt: null,
    metadata: {},
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  } as unknown as DispatchRecord;
}

function createVerification(
  store: AcceptanceStore,
  input: VerificationInsert,
): StoredVerification {
  const verification: StoredVerification = {
    id: `verification-${store.verifications.size + 1}`,
    orgId: input.orgId,
    orderId: input.orderId,
    status: (input.status ?? 'pending') as VerificationStatus,
    waMessageId: null,
    templateName: 'cod_verification',
    languageCode: 'en',
    attempts: 0,
    lastSentAt: null,
    confirmedAt: null,
    canceledAt: null,
    deliveredAt: null,
    readAt: null,
    noReplyAt: null,
    merchantCanceledAt: null,
    cancellationSource: null,
    followUpAttempts: 0,
    followUpSentAt: null,
    metadata: {},
  };
  store.verifications.set(verification.id, verification);
  store.orders.get(input.orderId)?.verifications.push(verification);
  return verification;
}

function createJob(event: StoredEvent): Job<WebhookJobPayload> {
  return {
    id: `job-${event.id}`,
    data: {
      webhookEventId: event.id,
      platform: 'standalone',
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: event.idempotencyKey,
      storeDomain: event.storeDomain,
      orgId: event.orgId,
      integrationId: event.integrationId,
      rawPayload: event.rawPayload,
      receivedAt: '2026-09-05T10:00:00.000Z',
    },
  } as unknown as Job<WebhookJobPayload>;
}

function requireEvent(
  store: AcceptanceStore,
  predicate?: (event: StoredEvent) => boolean,
): StoredEvent {
  const event = [...store.events.values()].find(predicate ?? (() => true));
  if (!event) throw new Error('Synthetic webhook event missing');
  return event;
}

async function createHarness(): Promise<AcceptanceHarness> {
  const store = createStore();
  let sessionRevoked = false;
  const user: AuthenticatedUser = {
    userId: 'user-standalone-1',
    orgId: store.integration.orgId,
    role: 'owner',
    source: 'supabase',
  };

  const providerCalls: Parameters<
    MessagingPort['sendVerificationTemplate']
  >[0][] = [];
  const provider: AcceptanceHarness['provider'] = {
    calls: providerCalls,
    async sendVerificationTemplate(params) {
      providerCalls.push(params);
      if (store.providerMode === 'timeout') {
        throw new Error('Synthetic provider timeout');
      }
      store.providerMessageCount += 1;
      return {
        messages: [{ id: `wamid-synthetic-${store.providerMessageCount}` }],
      };
    },
  };

  const ordersRepo = {
    findBySourceExternalId: async (source: {
      orgId: string;
      integrationId: string;
      externalOrderId: string;
    }) =>
      [...store.orders.values()].find(
        (order) =>
          order.orgId === source.orgId &&
          order.integrationId === source.integrationId &&
          order.externalOrderId === source.externalOrderId,
      ),
    create: async (data: OrderInsert) => store.addOrder(data),
    findById: async (id: string) => store.orders.get(id),
    findForOutcomeDispatch: async (source: {
      orgId: string;
      integrationId: string;
      externalOrderId: string;
    }) =>
      [...store.orders.values()].find(
        (order) =>
          order.orgId === source.orgId &&
          order.integrationId === source.integrationId &&
          order.externalOrderId === source.externalOrderId,
      ),
  };

  const integrationsRepo = {
    findActiveByOrg: async (orgId: string) =>
      orgId === store.integration.orgId && store.integration.isActive
        ? [store.integration]
        : [],
    findByOrg: async (orgId: string) =>
      orgId === store.integration.orgId ? [store.integration] : [],
    findBySourceIdentity: async (source: {
      id: string;
      orgId: string;
      platformType: string;
      platformStoreUrl: string;
    }) =>
      source.id === store.integration.id &&
      source.orgId === store.integration.orgId &&
      source.platformType === store.integration.platformType &&
      source.platformStoreUrl === store.integration.platformStoreUrl
        ? store.integration
        : undefined,
  };

  const verificationRepo = {
    findByOrderId: async (orderId: string) =>
      [...store.verifications.values()].find(
        (verification) => verification.orderId === orderId,
      ),
    findById: async (verificationId: string) =>
      store.verifications.get(verificationId),
    createForOrderIfAbsent: async (input: VerificationInsert) => {
      const existing = [...store.verifications.values()].find(
        (verification) => verification.orderId === input.orderId,
      );
      if (existing) return { verification: existing, created: false };
      return { verification: createVerification(store, input), created: true };
    },
    reopenRetryableInitialFailure: async () => false,
    updateByIdForOrg: async (
      verificationId: string,
      orgId: string,
      updates: VerificationUpdate,
    ) => {
      const verification = store.verifications.get(verificationId);
      if (!verification || verification.orgId !== orgId) return undefined;
      Object.assign(verification, updates);
      return verification;
    },
    updateStatus: async (
      verificationId: string,
      status: VerificationStatus,
      _waMessageId?: string,
      _eventTimestamp?: string,
      extraUpdates?: Record<string, unknown>,
    ) => {
      const verification = store.verifications.get(verificationId);
      if (
        !verification ||
        verification.status === 'confirmed' ||
        verification.status === 'canceled'
      ) {
        return [];
      }
      verification.status = status;
      if (status === 'confirmed') {
        verification.confirmedAt = '2026-09-05T10:05:00.000Z';
      }
      if (status === 'canceled') {
        verification.canceledAt = '2026-09-05T10:05:00.000Z';
      }
      Object.assign(verification, extraUpdates);
      return [verification];
    },
  };

  const usageRepo = {
    getEntitlementSource: async () => store.integration,
    getIntegrationUsageForPeriod: async () => ({
      consumedCount: store.usageCount,
      includedLimit: 30,
    }),
  };
  const billing = new BillingEntitlementService(
    usageRepo as never,
    usageAccountingFixture(),
  );

  const dispatchRepo = {
    claim: async (params: {
      orgId: string;
      integrationId: string;
      verificationId: string;
      kind: 'initial' | 'follow_up';
      templateName: string;
      languageCode: string;
    }): Promise<DispatchClaimResult> => {
      const dispatchKey = `${params.verificationId}:${params.kind}:1`;
      const existing = store.dispatches.get(dispatchKey);
      if (existing?.state === 'accepted') {
        return { outcome: 'accepted', dispatch: existing };
      }
      if (existing?.state === 'outcome_unknown') {
        return { outcome: 'outcome_unknown', dispatch: existing };
      }
      if (store.usageCount >= 30) {
        return { outcome: 'blocked', reason: 'plan_limit_reached' };
      }
      store.usageCount += 1;
      const dispatch = createDispatch({
        id: `dispatch-${store.dispatches.size + 1}`,
        orgId: params.orgId,
        integrationId: params.integrationId,
        verificationId: params.verificationId,
        dispatchKey,
        kind: params.kind,
        templateName: params.templateName,
        languageCode: params.languageCode,
        state: 'sending',
      });
      store.dispatches.set(dispatchKey, dispatch);
      return { outcome: 'claimed', dispatch };
    },
    // Mirrors DispatchAcceptanceResult. Returning the bare row here -- which
    // this double did until the repository grew a discriminated result -- makes
    // `accepted.outcome !== 'accepted'` true for every send, so the whole
    // acceptance path silently took its salvage branch.
    markAccepted: async (params: {
      dispatchId: string;
      providerMessageId: string;
      sentAt: string;
      verificationId?: string;
      kind?: 'initial' | 'follow_up';
    }): Promise<DispatchAcceptanceResult> => {
      const dispatch = [...store.dispatches.values()].find(
        (candidate) => candidate.id === params.dispatchId,
      );
      if (!dispatch) {
        if (
          params.verificationId &&
          !store.verifications.get(params.verificationId)
        ) {
          return { outcome: 'verification_missing' };
        }
        return { outcome: 'not_found' };
      }
      (dispatch as unknown as { state: string }).state = 'accepted';
      (dispatch as unknown as { providerMessageId: string }).providerMessageId =
        params.providerMessageId;
      const verification = store.verifications.get(dispatch.verificationId);
      if (verification) {
        verification.status = 'sent';
        verification.waMessageId = params.providerMessageId;
        verification.lastSentAt = params.sentAt;
        verification.attempts += 1;
      }
      return { outcome: 'accepted', dispatch };
    },
    markOutcomeUnknown: async (dispatchId: string, errorCode: string) => {
      const dispatch = [...store.dispatches.values()].find(
        (candidate) => candidate.id === dispatchId,
      );
      if (!dispatch) return 0;
      (dispatch as unknown as { state: string }).state = 'outcome_unknown';
      (dispatch as unknown as { lastErrorCode: string }).lastErrorCode =
        errorCode;
      const verification = store.verifications.get(dispatch.verificationId);
      if (verification) {
        verification.status = 'failed';
        verification.metadata = {
          ...verification.metadata,
          reason: 'provider_outcome_unknown',
          kind: dispatch.kind,
        };
      }
      return 1;
    },
    findByProviderMessageId: async (providerMessageId: string) =>
      [...store.dispatches.values()].find(
        (dispatch) => dispatch.providerMessageId === providerMessageId,
      ),
    recordProviderStatus: async () => undefined,
  };

  const standaloneAdapter = {
    platformType: 'standalone' as const,
    requiresActiveConnection: false,
    capabilities: new Set([
      'customer_confirmation',
      'customer_cancellation',
      'merchant_no_reply_cancellation',
    ] as const),
    execute: jest.fn().mockResolvedValue({ status: 'applied' as const }),
  };
  const shopifyAdapter = {
    platformType: 'shopify' as const,
    requiresActiveConnection: true,
    capabilities: new Set(['customer_confirmation'] as const),
    execute: jest.fn(async () => {
      store.shopifyCalls += 1;
      return { status: 'applied' as const };
    }),
  };
  const commerceOutcomes = new CommerceOutcomeRegistryService(
    ordersRepo as never,
    [standaloneAdapter, shopifyAdapter],
  );
  const eligibility = new OrderEligibilityService([
    new StandaloneOrderEligibilityStrategy(),
  ]);
  // E04.5 approval is not part of the E04 acceptance contract; the harness
  // runs with credit billing disabled, which always approves.
  const creditApproval = {
    isEnforced: () => false,
    isApproved: async () => true,
    resolveDenial: async () => null,
  } as unknown as CreditApprovalService;
  const send = new VerificationSendService(
    verificationRepo as never,
    ordersRepo as never,
    billing,
    creditApproval,
    dispatchRepo as never,
    provider,
  );
  const automation = {
    enqueueInitialSend: jest.fn(),
    enqueueFollowUp: jest.fn(),
    enqueueNoReplyEscalation: jest.fn(),
  };
  const hub = new VerificationHubService(
    ordersRepo as never,
    verificationRepo as never,
    commerceOutcomes,
    eligibility,
    send,
    billing,
    creditApproval,
    automation as never,
  );
  const testVerification = new TestVerificationService(
    integrationsRepo as never,
    hub,
    new PhoneService(),
  );

  const manualOrders = {
    accept: async (
      input: ManualOrderAcceptanceInput,
    ): Promise<ManualOrderAcceptanceResult> => {
      const existingEvent = [...store.events.values()].find(
        (event) =>
          event.idempotencyKey === input.event.idempotencyKey &&
          event.storeDomain === input.event.storeDomain,
      );
      if (existingEvent) {
        const existingFingerprint = existingEvent.rawPayload
          .submissionFingerprint as string | undefined;
        if (existingFingerprint !== input.event.submissionFingerprint) {
          throw new ManualOrderPayloadConflictError();
        }
        const existingOrder = store.orders.get(existingEvent.orderId);
        if (!existingOrder) throw new Error('Synthetic accepted order missing');
        return {
          eventId: existingEvent.id,
          order: existingOrder as unknown as typeof orders.$inferSelect,
          duplicate: true,
        };
      }
      const order = store.addOrder(input.order);
      const event: StoredEvent = {
        id: `event-${store.events.size + 1}`,
        platform: 'standalone',
        jobType: WebhookJobType.ORDER_CREATE,
        idempotencyKey: input.event.idempotencyKey,
        storeDomain: input.event.storeDomain,
        orgId: input.event.orgId,
        integrationId: input.event.integrationId,
        orderId: order.id,
        rawPayload: input.event.rawPayload,
        status: 'pending',
        lastError: null,
      };
      store.events.set(event.id, event);
      order.webhookEvents.push(event);
      return {
        eventId: event.id,
        order: order as unknown as typeof orders.$inferSelect,
        duplicate: false,
      };
    },
  };
  const dispatcher = {
    dispatchById: async () => {
      store.dispatchCalls += 1;
      if (store.queueFailure) {
        store.queueFailure = false;
        throw new Error('Synthetic Redis unavailable');
      }
    },
  };
  const eventRepo = {
    claimForProcessing: async (eventId: string) => {
      const event = store.events.get(eventId);
      if (!event || event.status !== 'pending')
        return 'already_claimed' as const;
      event.status = 'processing';
      return 'claimed' as const;
    },
    markCompleted: async (eventId: string) => {
      const event = store.events.get(eventId);
      if (event) event.status = 'completed';
    },
    markSkipped: async (eventId: string, reason: string) => {
      const event = store.events.get(eventId);
      if (event) {
        event.status = 'skipped';
        event.lastError = reason;
      }
    },
    resetForRedispatch: async () => false,
  };
  const ordersService = new OrdersService(
    ordersRepo as never,
    integrationsRepo as never,
    verificationRepo as never,
    manualOrders as never,
    new PhoneService(),
    billing,
    creditApproval,
    dispatcher as never,
    eventRepo as never,
    eligibility,
  );
  const processor = new WebhookQueueProcessor(
    [new StandaloneManualOrderNormalizer()],
    eventRepo as never,
    integrationsRepo as never,
    hub,
  );
  const webhook = new WhatsAppWebhookService(
    verificationRepo as never,
    hub,
    dispatchRepo as never,
  );
  const module = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [{ provide: OrdersService, useValue: ordersService }],
  })
    .overrideGuard(DualAuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        if (sessionRevoked) throw new UnauthorizedException('Session revoked');
        context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user =
          user;
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication<Server>();
  await app.init();

  return {
    app,
    store,
    user,
    get sessionRevoked() {
      return sessionRevoked;
    },
    set sessionRevoked(value: boolean) {
      sessionRevoked = value;
    },
    testVerification,
    ordersService,
    verificationSend: send,
    processor,
    webhook,
    provider,
    standaloneAdapter,
    shopifyAdapter,
  } as AcceptanceHarness;
}

function submitManualOrder(
  app: INestApplication<Server>,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
) {
  return request(app.getHttpServer())
    .post('/api/orders')
    .set('Idempotency-Key', idempotencyKey)
    .send({
      customerPhone: '+201001234567',
      customerName: 'Synthetic customer',
      orderNumber: 'MVP-1',
      totalPrice: '125.50',
      currency: 'USD',
      paymentMethod: 'cash_on_delivery',
      orgId: 'forged-org',
      integrationId: 'forged-integration',
      ...overrides,
    });
}

describe('US-04-05 Standalone manual MVP acceptance composition', () => {
  let harness: AcceptanceHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('completes test send, manual order processing, and one customer outcome without Shopify', async () => {
    const testResult = await harness.testVerification.sendTestVerification(
      harness.user,
      '+201001234567',
    );
    expect(testResult).toMatchObject({
      orderId: expect.any(String),
      verificationId: expect.any(String),
    });

    const response = await submitManualOrder(
      harness.app,
      'manual-acceptance-1',
    ).expect(202);
    expect(response.body).toMatchObject({
      status: 'accepted',
      duplicate: false,
    });
    const event = requireEvent(harness.store);

    await harness.processor.process(createJob(event));
    const manualOrder = harness.store.orders.get(response.body.orderId);
    const verification = manualOrder?.verifications[0];
    expect(verification).toMatchObject({ status: 'sent' });
    expect(harness.store.events.get(event.id)?.status).toBe('completed');
    expect(harness.store.usageCount).toBe(2);

    await harness.webhook.processIncoming({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '201001234567',
                    id: 'wamid-customer-reply-1',
                    timestamp: '1788602700',
                    type: 'button',
                    button: {
                      text: 'Confirm',
                      payload: `confirm_${verification?.id}`,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never);
    await harness.webhook.processIncoming({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '201001234567',
                    id: 'wamid-customer-reply-1-duplicate',
                    timestamp: '1788602701',
                    type: 'button',
                    button: {
                      text: 'Confirm',
                      payload: `confirm_${verification?.id}`,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never);

    expect(verification?.status).toBe('confirmed');
    expect(harness.standaloneAdapter.execute).toHaveBeenCalledTimes(1);
    expect(harness.standaloneAdapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer_confirmation',
        orgId: harness.user.orgId,
      }),
    );
    expect(harness.shopifyAdapter.execute).not.toHaveBeenCalled();
    expect(harness.store.shopifyCalls).toBe(0);
  });

  it('keeps durable acceptance recoverable after Redis failure and ignores repeated worker delivery', async () => {
    harness.store.queueFailure = true;
    const response = await submitManualOrder(
      harness.app,
      'manual-redis-recovery',
    ).expect(202);
    const event = requireEvent(harness.store);
    expect(response.body.status).toBe('accepted');
    expect(harness.store.dispatchCalls).toBe(1);
    expect(harness.store.events.get(event.id)?.status).toBe('pending');

    await harness.processor.process(createJob(event));
    await harness.processor.process(createJob(event));

    const order = harness.store.orders.get(response.body.orderId);
    expect(order?.verifications).toHaveLength(1);
    expect(harness.provider.calls).toHaveLength(1);
    expect(harness.store.usageCount).toBe(1);
    expect(harness.store.events.get(event.id)?.status).toBe('completed');
  });

  it('makes concurrent matching submissions one order, rejects changed replay data, and strips forged source IDs', async () => {
    const responses = await Promise.all([
      submitManualOrder(harness.app, 'manual-concurrent-1'),
      submitManualOrder(harness.app, 'manual-concurrent-1'),
    ]);
    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.orderId)).size,
    ).toBe(1);
    expect(responses.map((response) => response.body.duplicate).sort()).toEqual(
      [false, true],
    );
    expect(harness.store.orders.size).toBe(1);
    expect([...harness.store.orders.values()][0].orgId).toBe(
      harness.user.orgId,
    );
    expect([...harness.store.orders.values()][0].integrationId).toBe(
      harness.store.integration.id,
    );

    await submitManualOrder(harness.app, 'manual-concurrent-1', {
      totalPrice: '126.00',
    }).expect(409);
    expect(harness.store.orders.size).toBe(1);
  });

  it('covers invalid input, revoked sessions, viewers, and inactive sources before provider activity', async () => {
    const invalid = await submitManualOrder(harness.app, 'manual-invalid', {
      customerPhone: 'not-a-phone',
    }).expect(400);
    expect(invalid.body).toMatchObject({
      code: 'MANUAL_ORDER_VALIDATION_FAILED',
      fieldErrors: { customerPhone: expect.any(String) },
    });

    harness.user.role = 'viewer';
    await submitManualOrder(harness.app, 'manual-viewer').expect(403);
    harness.user.role = 'owner';

    harness.store.integration.isActive = false;
    const inactive = await submitManualOrder(
      harness.app,
      'manual-inactive',
    ).expect(409);
    expect(inactive.body.code).toBe('MANUAL_ORDER_SOURCE_UNAVAILABLE');
    harness.store.integration.isActive = true;

    harness.sessionRevoked = true;
    await submitManualOrder(harness.app, 'manual-revoked').expect(401);

    expect(harness.provider.calls).toHaveLength(0);
    expect(harness.store.orders.size).toBe(0);
  });

  it('keeps non-COD orders visible without creating a verification and records provider uncertainty as failed/reviewable', async () => {
    const ineligibleResponse = await submitManualOrder(
      harness.app,
      'manual-ineligible',
      { paymentMethod: 'prepaid' },
    ).expect(202);
    const ineligibleEvent = requireEvent(harness.store);
    await harness.processor.process(createJob(ineligibleEvent));
    expect(
      harness.store.orders.get(ineligibleResponse.body.orderId)?.verifications,
    ).toHaveLength(0);
    expect(harness.store.events.get(ineligibleEvent.id)).toMatchObject({
      status: 'skipped',
      lastError: 'non_cod_payment_method',
    });
    expect(harness.store.usageCount).toBe(0);

    harness.store.providerMode = 'timeout';
    const uncertainResponse = await submitManualOrder(
      harness.app,
      'manual-provider-uncertain',
    ).expect(202);
    const uncertainEvent = [...harness.store.events.values()].find(
      (event) => event.id !== ineligibleEvent.id,
    );
    if (!uncertainEvent) throw new Error('Synthetic uncertain event missing');
    await harness.processor.process(createJob(uncertainEvent));
    const uncertainOrder = harness.store.orders.get(
      uncertainResponse.body.orderId,
    );
    const uncertainVerification = uncertainOrder?.verifications[0];
    expect(uncertainVerification).toMatchObject({
      status: 'failed',
      metadata: { reason: 'provider_outcome_unknown' },
    });
    expect(
      [...harness.store.dispatches.values()].some(
        (dispatch) => dispatch.state === 'outcome_unknown',
      ),
    ).toBe(true);
    const sendCount = harness.provider.calls.length;
    const retry = await harness.verificationSend.sendInitial(
      uncertainVerification?.id ?? '',
    );
    expect(retry).toMatchObject({
      status: 'outcome_unknown',
      reason: 'provider_outcome_unknown',
    });
    expect(harness.provider.calls).toHaveLength(sendCount);
  });

  it('rejects cross-tenant access to an accepted order', async () => {
    const response = await submitManualOrder(
      harness.app,
      'manual-tenant-boundary',
    ).expect(202);
    harness.user.orgId = 'other-org';
    await expect(
      harness.ordersService.retryOrderVerification(
        harness.user,
        response.body.orderId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
