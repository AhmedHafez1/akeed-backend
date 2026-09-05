import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { VerificationHubService } from './verification-hub.service';
import type { NormalizedOrder } from '../../shared/interfaces/order.interface';
import type { integrations } from '../../infrastructure/database/schema';
import { WhatsAppWebhookService } from '../../infrastructure/spokes/meta/whatsapp.webhook.service';
import { WebhookQueueProcessor } from '../webhook-queue/webhook-queue.processor';
import { ShopifyOrderNormalizer } from '../webhook-queue/normalizers/shopify-order.normalizer';
import { shopifyOrderFixture } from '../webhook-queue/normalizers/fixtures/shopify-order.fixture';
import { PhoneService } from '../../shared/services/phone.service';
import { WebhookJobType } from '../webhook-queue/webhook-queue.constants';
import type { Job } from 'bullmq';
import type { WebhookJobPayload } from '../webhook-queue/interfaces/webhook-job.interface';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAdapter,
} from '../../shared/commerce/commerce-outcome';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IntegrationRecord = typeof integrations.$inferSelect;

function buildOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: 'ext-order-1',
    orderNumber: '1042',
    customerPhone: '+966500000000',
    customerName: 'Test Customer',
    totalPrice: '129.00',
    currency: 'SAR',
    paymentMethod: 'cod',
    ...overrides,
  };
}

function buildIntegration(
  overrides: Partial<IntegrationRecord> = {},
): IntegrationRecord {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    isActive: true,
    isAutoVerifyEnabled: true,
    defaultLanguage: 'ar',
    billingPlanId: 'pro',
    billingStatus: 'active',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    shopifySubscriptionId: 'sub-1',
    shippingCurrency: 'SAR',
    avgShippingCost: '3.00',
    onboardingStatus: 'completed',
    accessToken: 'tok',
    expiresAt: null,
    webhookSecret: null,
    lastSyncedAt: null,
    metadata: {},
    storeName: 'Test Store',
    billingInitiatedAt: null,
    billingCanceledAt: null,
    billingStatusUpdatedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    followUpEnabled: true,
    followUpDelayMinutes: 120,
    escalationEnabled: true,
    escalationDelayMinutes: 360,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Asia/Riyadh',
    sendDelayMinutes: 0,
    ...overrides,
  } as IntegrationRecord;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMocks() {
  const ordersRepo = {
    findBySourceExternalId: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
  };

  const verificationsRepo = {
    findByOrderId: jest.fn(),
    create: jest.fn(),
    createForOrderIfAbsent: jest.fn(),
    reopenRetryableInitialFailure: jest.fn().mockResolvedValue(false),
    updateStatus: jest.fn(),
    findById: jest.fn(),
    updateByIdForOrg: jest.fn(),
  };
  verificationsRepo.createForOrderIfAbsent.mockImplementation(
    async (values: unknown) => ({
      verification: await verificationsRepo.create(values),
      created: true,
    }),
  );

  const orderTaggingPort = {
    addOrderTag: jest.fn(),
    cancelOrder: jest.fn(),
  };

  const registryTestAdapter: CommerceOutcomeAdapter = {
    platformType: 'shopify',
    requiresActiveConnection: true,
    capabilities: new Set(COMMERCE_OUTCOME_ACTIONS),
    execute: jest.fn(async ({ action, connection, externalOrderId }) => {
      if (!connection.platformStoreUrl || !connection.accessToken) {
        return {
          status: 'permanent_failure' as const,
          errorCode: 'connection_incomplete',
        };
      }
      if (action === 'merchant_no_reply_cancellation') {
        await orderTaggingPort.cancelOrder(connection, externalOrderId);
        return { status: 'accepted_without_reference' as const };
      }
      const tag = {
        customer_confirmation: 'Akeed: Verified',
        customer_cancellation: 'Akeed: Canceled',
        merchant_cancellation_tagging: 'Akeed: Canceled',
        automatic_no_reply_tagging: 'Akeed: No Reply',
      }[action];
      await orderTaggingPort.addOrderTag(connection, externalOrderId, tag);
      return { status: 'applied' as const };
    }),
  };

  const orderEligibilityService = {
    evaluateOrderForVerification: jest.fn(),
  };

  const verificationSendService = {
    sendInitial: jest.fn(),
    sendFollowUp: jest.fn(),
  };

  const billingEntitlementService = {
    evaluateAccess: (source: EntitlementSource, identity = source) =>
      resolveEntitlement(source, identity),
    hasAvailableSlot: jest.fn().mockResolvedValue({
      available: true,
      consumedCount: 0,
      includedLimit: 1000,
    }),
  };

  const automationProducer = {
    enqueueInitialSend: jest.fn(),
    enqueueFollowUp: jest.fn(),
    enqueueNoReplyEscalation: jest.fn(),
  };

  const service = new VerificationHubService(
    ordersRepo as any,
    verificationsRepo as any,
    new CommerceOutcomeRegistryService(
      {
        findForOutcomeDispatch: (...args: unknown[]) =>
          ordersRepo.findById(...args) as unknown,
      } as never,
      [registryTestAdapter],
    ),
    orderEligibilityService as any,
    verificationSendService as any,
    billingEntitlementService as any,
    automationProducer as any,
  );

  return {
    service,
    ordersRepo,
    verificationsRepo,
    orderTaggingPort,
    orderEligibilityService,
    verificationSendService,
    billingEntitlementService,
    automationProducer,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationHubService', () => {
  it.each([
    ['confirm', 'confirmed', 'Akeed: Verified'],
    ['cancel', 'canceled', 'Akeed: Canceled'],
  ])(
    'composes a Meta %s reply with the real hub without canceling the commerce order',
    async (action, status, tag) => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      const integration = buildIntegration();
      const verification = {
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
        status: 'sent',
        merchantCanceledAt: null,
      };
      verificationsRepo.findById.mockResolvedValue(verification);
      verificationsRepo.updateStatus.mockImplementation(
        (_id: string, nextStatus: string) => {
          verification.status = nextStatus;
          return Promise.resolve([verification]);
        },
      );
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: '12345',
        integration,
      });
      const callback = new WhatsAppWebhookService(
        verificationsRepo as never,
        service,
        {
          findByProviderMessageId: jest.fn().mockResolvedValue(undefined),
          recordProviderStatus: jest.fn(),
        } as never,
      );
      await expect(
        callback.processIncoming({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      {
                        type: 'button',
                        button: { payload: `${action}_ver-1` },
                        timestamp: '1778803200',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      ).resolves.toEqual({ status: 'success' });
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        status,
        undefined,
        '1778803200',
        action === 'cancel' ? { cancellationSource: 'customer' } : {},
      );
      expect(verification.status).toBe(status);
      expect(orderTaggingPort.addOrderTag).toHaveBeenCalledWith(
        integration,
        '12345',
        tag,
      );
      expect(orderTaggingPort.cancelOrder).not.toHaveBeenCalled();
    },
  );

  it.each(['unknown', 'inactive'])(
    'composes worker and real hub for %s store without sending',
    async (store) => {
      const {
        service,
        verificationSendService,
        ordersRepo,
        orderEligibilityService,
      } = createMocks();
      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
      });
      const eventRepo = {
        claimForProcessing: jest.fn().mockResolvedValue('claimed'),
        markCompleted: jest.fn(),
        markSkipped: jest.fn(),
      };
      const integrationRepo = {
        findBySourceIdentity: jest
          .fn()
          .mockResolvedValue(
            store === 'unknown' ? null : buildIntegration({ isActive: false }),
          ),
      };
      const worker = new WebhookQueueProcessor(
        [new ShopifyOrderNormalizer(new PhoneService())],
        eventRepo as never,
        integrationRepo as never,
        service,
      );
      const job = {
        id: 'job-1',
        data: {
          webhookEventId: 'event-1',
          platform: 'shopify',
          jobType: WebhookJobType.ORDER_CREATE,
          idempotencyKey: 'delivery-1',
          storeDomain: 'synthetic.myshopify.com',
          orgId: store === 'unknown' ? null : 'org-1',
          integrationId: store === 'unknown' ? null : 'int-1',
          rawPayload: shopifyOrderFixture({
            orgId: 'forged',
            integrationId: 'forged',
          }),
          receivedAt: '2026-05-15T00:00:00.000Z',
        },
      } as Job<WebhookJobPayload>;
      await worker.process(job);
      expect(ordersRepo.create).not.toHaveBeenCalled();
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      if (store === 'unknown')
        expect(eventRepo.markSkipped).toHaveBeenCalledWith(
          'event-1',
          'missing_source_identity',
        );
      else
        expect(eventRepo.markSkipped).toHaveBeenCalledWith(
          'event-1',
          'integration_inactive',
        );
    },
  );
  describe('handleNewOrder — eligibility & auto-verify guards', () => {
    it('skips before order creation when COD eligibility fails', async () => {
      const { service, ordersRepo, orderEligibilityService } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: false,
        reason: 'non_cod_payment_method',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration(),
      );

      expect(result).toEqual({
        skipped: true,
        reason: 'non_cod_payment_method',
      });
      expect(ordersRepo.findBySourceExternalId).not.toHaveBeenCalled();
    });

    it('skips before order creation when isAutoVerifyEnabled=false', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        verificationSendService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration({ isAutoVerifyEnabled: false }),
      );

      expect(result).toEqual({ skipped: true, reason: 'auto_verify_disabled' });
      expect(ordersRepo.findBySourceExternalId).not.toHaveBeenCalled();
      expect(verificationsRepo.create).not.toHaveBeenCalled();
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
    });

    it('skips when onboarding is not completed', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration({ onboardingStatus: 'pending' }),
      );

      expect(result).toEqual({
        skipped: true,
        reason: 'onboarding_incomplete',
      });
      expect(ordersRepo.findBySourceExternalId).not.toHaveBeenCalled();
      expect(verificationsRepo.create).not.toHaveBeenCalled();
    });

    it('skips when integration is not active', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration({ isActive: false }),
      );

      expect(result).toEqual({
        skipped: true,
        reason: 'integration_inactive',
      });
      expect(ordersRepo.findBySourceExternalId).not.toHaveBeenCalled();
      expect(verificationsRepo.create).not.toHaveBeenCalled();
    });

    it.each([
      ['pending', 'pending'],
      ['null', null],
      ['error', 'error'],
      ['cancelled', 'cancelled'],
      ['declined', 'declined'],
      ['frozen', 'frozen'],
      ['expired', 'expired'],
    ])('skips when billing status is %s', async (_label, billingStatus) => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration({ billingStatus } as any),
      );

      expect(result).toEqual({
        skipped: true,
        reason: 'billing_not_active',
      });
      expect(ordersRepo.findBySourceExternalId).not.toHaveBeenCalled();
      expect(verificationsRepo.create).not.toHaveBeenCalled();
    });

    it.each([
      ['active', 'active'],
      ['not_required', 'not_required'],
    ])(
      'allows verification creation when billing status is %s',
      async (_label, billingStatus) => {
        const {
          service,
          ordersRepo,
          verificationsRepo,
          orderEligibilityService,
          verificationSendService,
        } = createMocks();

        orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
          eligible: true,
          reason: 'cod_match',
        });
        ordersRepo.findBySourceExternalId.mockResolvedValue(null);
        ordersRepo.create.mockResolvedValue({
          id: 'order-db-1',
          orgId: 'org-1',
          externalOrderId: 'ext-order-1',
        });
        verificationsRepo.findByOrderId.mockResolvedValue(null);
        verificationsRepo.create.mockResolvedValue({
          id: 'ver-1',
          orgId: 'org-1',
        });
        verificationSendService.sendInitial.mockResolvedValue({
          status: 'sent',
          waMessageId: 'wamid-123',
        });

        const result = await service.handleNewOrder(
          buildOrder(),
          buildIntegration({ billingStatus } as any),
        );

        expect(result).toEqual({
          orderId: 'order-db-1',
          verificationId: 'ver-1',
        });
        expect(verificationsRepo.create).toHaveBeenCalled();
      },
    );

    it('skips verification creation when plan limit is reached', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        billingEntitlementService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });
      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      billingEntitlementService.hasAvailableSlot.mockResolvedValue({
        available: false,
        consumedCount: 1000,
        includedLimit: 1000,
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration(),
      );

      expect(result).toEqual({
        skipped: true,
        reason: 'plan_limit_reached',
      });
      expect(verificationsRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('handleNewOrder — immediate send (sendDelayMinutes=0)', () => {
    it('creates pending verification, sends, and schedules follow-up + no-reply', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'sent',
        waMessageId: 'wamid-123',
      });

      const integration = buildIntegration({
        sendDelayMinutes: 0,
        followUpEnabled: true,
        followUpDelayMinutes: 120,
        escalationDelayMinutes: 360,
      });

      const result = await service.handleNewOrder(buildOrder(), integration);

      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-1',
      });
      expect(verificationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
      );
      expect(verificationSendService.sendInitial).toHaveBeenCalledWith('ver-1');
      expect(automationProducer.enqueueInitialSend).not.toHaveBeenCalled();
      expect(automationProducer.enqueueFollowUp).toHaveBeenCalledTimes(1);
      expect(automationProducer.enqueueNoReplyEscalation).toHaveBeenCalledTimes(
        1,
      );
    });

    it('does NOT schedule follow-up/escalation when initial send fails', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'failed',
        reason: 'send_error',
      });

      await service.handleNewOrder(buildOrder(), buildIntegration());

      expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
      expect(
        automationProducer.enqueueNoReplyEscalation,
      ).not.toHaveBeenCalled();
    });

    it('queues initial send when sendDelayMinutes is 0 but quiet hours are active', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-01T03:00:00.000Z'));

      try {
        const {
          service,
          ordersRepo,
          verificationsRepo,
          orderEligibilityService,
          verificationSendService,
          automationProducer,
        } = createMocks();

        orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
          eligible: true,
          reason: 'cod_match',
        });

        ordersRepo.findBySourceExternalId.mockResolvedValue(null);
        ordersRepo.create.mockResolvedValue({
          id: 'order-db-1',
          orgId: 'org-1',
          externalOrderId: 'ext-order-1',
        });
        verificationsRepo.findByOrderId.mockResolvedValue(null);
        verificationsRepo.create.mockResolvedValue({
          id: 'ver-1',
          orgId: 'org-1',
        });

        await service.handleNewOrder(
          buildOrder(),
          buildIntegration({
            sendDelayMinutes: 0,
            quietHoursEnabled: true,
            quietHoursStart: '21:00',
            quietHoursEnd: '09:00',
            timezone: 'Asia/Riyadh',
          }),
        );

        expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
        expect(automationProducer.enqueueInitialSend).toHaveBeenCalledWith(
          expect.objectContaining({
            verificationId: 'ver-1',
            orgId: 'org-1',
            dueAt: new Date('2026-05-01T06:00:00.000Z'),
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('marks failed with plan_limit_reached metadata when send service reports plan limit', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'plan_limit_reached',
        reason: 'plan_limit:1000/1000',
      });

      await service.handleNewOrder(buildOrder(), buildIntegration());

      expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalledWith(
        'ver-1',
        'org-1',
        expect.objectContaining({
          status: 'failed',
          metadata: expect.objectContaining({
            reason: 'plan_limit_reached',
          }) as Record<string, unknown>,
        }),
      );
      expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
    });

    it.each(['integration_inactive', 'billing_not_active'])(
      'marks an immediate initial send failed when execution is skipped for %s',
      async (reason) => {
        const {
          service,
          ordersRepo,
          verificationsRepo,
          orderEligibilityService,
          verificationSendService,
          automationProducer,
        } = createMocks();

        orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
          eligible: true,
          reason: 'cod_match',
        });
        ordersRepo.findBySourceExternalId.mockResolvedValue(null);
        ordersRepo.create.mockResolvedValue({
          id: 'order-db-1',
          orgId: 'org-1',
          externalOrderId: 'ext-order-1',
        });
        verificationsRepo.findByOrderId.mockResolvedValue(null);
        verificationsRepo.create.mockResolvedValue({
          id: 'ver-1',
          orgId: 'org-1',
        });
        verificationSendService.sendInitial.mockResolvedValue({
          status: 'skipped',
          reason,
        });

        await service.handleNewOrder(buildOrder(), buildIntegration());

        expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalledWith(
          'ver-1',
          'org-1',
          expect.objectContaining({
            status: 'failed',
            metadata: expect.objectContaining({ reason }) as Record<
              string,
              unknown
            >,
          }),
        );
        expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
      },
    );
  });

  describe('handleNewOrder — delayed initial send (sendDelayMinutes>0)', () => {
    it('creates pending verification and enqueues initial-send job without sending', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });

      await service.handleNewOrder(
        buildOrder(),
        buildIntegration({ sendDelayMinutes: 30 }),
      );

      expect(verificationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
      );
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(automationProducer.enqueueInitialSend).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 'ver-1',
          orgId: 'org-1',
          dueAt: expect.any(Date) as Date,
        }),
      );
    });
  });

  describe('handleNewOrder — idempotency', () => {
    it('returns existing verification when one already exists for the order', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue({
        id: 'ver-existing',
        orgId: 'org-1',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration(),
      );

      expect(ordersRepo.findBySourceExternalId).toHaveBeenCalledWith({
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: 'ext-order-1',
      });
      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-existing',
      });
      expect(verificationsRepo.create).not.toHaveBeenCalled();
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
    });

    it('safely reschedules a pending Standalone initial send after queue recovery', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });
      ordersRepo.findBySourceExternalId.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue({
        id: 'ver-existing',
        orgId: 'org-1',
        status: 'pending',
        lastSentAt: null,
      });

      await service.handleNewOrder(
        buildOrder(),
        buildIntegration({
          platformType: 'standalone',
          platformStoreUrl: 'standalone:org-1',
          billingStatus: 'not_required',
          sendDelayMinutes: 15,
        }),
      );

      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(automationProducer.enqueueInitialSend).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 'ver-existing',
          orgId: 'org-1',
          dueAt: expect.any(Date) as Date,
        }),
      );
    });

    it('reuses existing order but creates new verification when none exists', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      ordersRepo.findBySourceExternalId.mockResolvedValue({
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-new',
        orgId: 'org-1',
      });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'sent',
        waMessageId: 'wamid-456',
      });

      const result = await service.handleNewOrder(
        buildOrder(),
        buildIntegration(),
      );

      expect(ordersRepo.create).not.toHaveBeenCalled();
      expect(verificationsRepo.create).toHaveBeenCalled();
      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-new',
      });
    });
  });

  describe('handleSyntheticTestOrder', () => {
    it('sends once immediately without eligibility, delay, quiet-hours, or follow-up automation', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        orderEligibilityService,
        verificationSendService,
        automationProducer,
      } = createMocks();
      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({ id: 'order-test', orgId: 'org-1' });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({ id: 'ver-test' });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'sent',
        sentAt: '2026-09-04T12:00:00.000Z',
      });
      const integration = buildIntegration({
        isAutoVerifyEnabled: false,
        sendDelayMinutes: 60,
        quietHoursEnabled: true,
        quietHoursStart: '00:00',
        quietHoursEnd: '23:59',
        followUpEnabled: true,
        escalationEnabled: true,
      });

      await expect(
        service.handleSyntheticTestOrder(
          buildOrder({ externalOrderId: 'akeed-test-id' }),
          integration,
        ),
      ).resolves.toEqual({
        orderId: 'order-test',
        verificationId: 'ver-test',
        deliveryStatus: 'sent',
        reason: undefined,
      });

      expect(
        orderEligibilityService.evaluateOrderForVerification,
      ).not.toHaveBeenCalled();
      expect(verificationSendService.sendInitial).toHaveBeenCalledTimes(1);
      expect(automationProducer.enqueueInitialSend).not.toHaveBeenCalled();
      expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
      expect(
        automationProducer.enqueueNoReplyEscalation,
      ).not.toHaveBeenCalled();
    });

    it('surfaces the immediate provider outcome to the caller', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        verificationSendService,
      } = createMocks();
      ordersRepo.findBySourceExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue({ id: 'order-test', orgId: 'org-1' });
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      verificationsRepo.create.mockResolvedValue({ id: 'ver-test' });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'failed',
        reason: 'send_error',
      });

      await expect(
        service.handleSyntheticTestOrder(
          buildOrder({ externalOrderId: 'akeed-test-id' }),
          buildIntegration(),
        ),
      ).resolves.toMatchObject({
        deliveryStatus: 'failed',
        reason: 'send_error',
      });
    });

    it('never dispatches a commerce outcome for a synthetic callback', async () => {
      const { service, ordersRepo, verificationsRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-test',
        orderId: 'order-test',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-test',
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: 'akeed-test-id',
        isTest: true,
        integration: buildIntegration(),
      });

      await service.finalizeVerification('ver-test', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
      expect(orderTaggingPort.cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('scheduleFollowUpAndEscalation', () => {
    it('skips follow-up when followUpEnabled is false', async () => {
      const { service, automationProducer } = createMocks();

      await service.scheduleFollowUpAndEscalation({
        verificationId: 'ver-1',
        orgId: 'org-1',
        integration: buildIntegration({
          followUpEnabled: false,
          followUpDelayMinutes: 120,
          escalationDelayMinutes: 360,
        }),
        baselineSentAt: new Date(),
      });

      expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
      expect(automationProducer.enqueueNoReplyEscalation).toHaveBeenCalledTimes(
        1,
      );
    });

    it('skips follow-up when followUpDelayMinutes is 0', async () => {
      const { service, automationProducer } = createMocks();

      await service.scheduleFollowUpAndEscalation({
        verificationId: 'ver-1',
        orgId: 'org-1',
        integration: buildIntegration({
          followUpEnabled: true,
          followUpDelayMinutes: 0,
          escalationDelayMinutes: 360,
        }),
        baselineSentAt: new Date(),
      });

      expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
      expect(automationProducer.enqueueNoReplyEscalation).toHaveBeenCalledTimes(
        1,
      );
    });

    it('skips escalation when escalationDelayMinutes is 0', async () => {
      const { service, automationProducer } = createMocks();

      await service.scheduleFollowUpAndEscalation({
        verificationId: 'ver-1',
        orgId: 'org-1',
        integration: buildIntegration({
          followUpEnabled: true,
          followUpDelayMinutes: 120,
          escalationEnabled: true,
          escalationDelayMinutes: 0,
        }),
        baselineSentAt: new Date(),
      });

      expect(automationProducer.enqueueFollowUp).toHaveBeenCalledTimes(1);
      expect(
        automationProducer.enqueueNoReplyEscalation,
      ).not.toHaveBeenCalled();
    });

    it('skips escalation when escalationEnabled is false', async () => {
      const { service, automationProducer } = createMocks();

      await service.scheduleFollowUpAndEscalation({
        verificationId: 'ver-1',
        orgId: 'org-1',
        integration: buildIntegration({
          followUpEnabled: true,
          followUpDelayMinutes: 120,
          escalationEnabled: false,
          escalationDelayMinutes: 360,
        }),
        baselineSentAt: new Date(),
      });

      expect(automationProducer.enqueueFollowUp).toHaveBeenCalledTimes(1);
      expect(
        automationProducer.enqueueNoReplyEscalation,
      ).not.toHaveBeenCalled();
    });

    it('pushes escalation after follow-up when escalation would fire first', async () => {
      const { service, automationProducer } = createMocks();

      await service.scheduleFollowUpAndEscalation({
        verificationId: 'ver-1',
        orgId: 'org-1',
        integration: buildIntegration({
          followUpEnabled: true,
          followUpDelayMinutes: 120,
          escalationDelayMinutes: 60,
          quietHoursEnabled: false,
        }),
        baselineSentAt: new Date('2026-01-15T10:00:00Z'),
      });

      const followUpCall = automationProducer.enqueueFollowUp.mock
        .calls[0][0] as { dueAt: Date };
      const escalationCall = automationProducer.enqueueNoReplyEscalation.mock
        .calls[0][0] as { dueAt: Date };

      expect(escalationCall.dueAt.getTime()).toBeGreaterThan(
        followUpCall.dueAt.getTime(),
      );
    });
  });

  describe('finalizeVerification', () => {
    it('does nothing when verification is not found', async () => {
      const { service, verificationsRepo, orderTaggingPort } = createMocks();
      verificationsRepo.findById.mockResolvedValue(null);

      await service.finalizeVerification('ver-missing', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('does nothing when order is not found', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue(null);

      await service.finalizeVerification('ver-1', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('tags confirmed orders with "Akeed: Verified"', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      const integration = buildIntegration();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration,
      });

      await service.finalizeVerification('ver-1', 'confirmed');

      expect(orderTaggingPort.addOrderTag).toHaveBeenCalledWith(
        integration,
        'ext-order-1',
        'Akeed: Verified',
      );
    });

    it('tags canceled orders with "Akeed: Canceled"', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      const integration = buildIntegration();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration,
      });

      await service.finalizeVerification('ver-1', 'canceled');

      expect(orderTaggingPort.addOrderTag).toHaveBeenCalledWith(
        integration,
        'ext-order-1',
        'Akeed: Canceled',
      );
    });

    it('skips tagging for test orders', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'akeed-test-123',
        integration: buildIntegration(),
      });

      await service.finalizeVerification('ver-1', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('does not tag for non-terminal statuses', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration: buildIntegration(),
      });

      await service.finalizeVerification('ver-1', 'pending');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('does not tag Shopify after the integration is uninstalled', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration: buildIntegration({ isActive: false }),
      });

      await service.finalizeVerification('ver-1', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('does not throw when tagging fails', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      const integration = buildIntegration();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration,
      });
      orderTaggingPort.addOrderTag.mockRejectedValue(
        new Error('Shopify API error'),
      );

      await expect(
        service.finalizeVerification('ver-1', 'confirmed'),
      ).resolves.toBeUndefined();
    });

    it('skips tagging when integration has no platformStoreUrl', async () => {
      const { service, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();
      verificationsRepo.findById.mockResolvedValue({
        orgId: 'org-1',
        id: 'ver-1',
        orderId: 'order-1',
      });
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
        integration: buildIntegration({ platformStoreUrl: null } as any),
      });

      await service.finalizeVerification('ver-1', 'confirmed');

      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });
  });
});
