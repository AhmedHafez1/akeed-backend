import { VerificationHubService } from './verification-hub.service';
import type { NormalizedOrder } from '../../shared/interfaces/order.interface';
import type { integrations } from '../../infrastructure/database/schema';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

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
    findByExternalId: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
  };

  const verificationsRepo = {
    findByOrderId: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    findById: jest.fn(),
    updateByIdForOrg: jest.fn(),
  };

  const orderTaggingPort = {
    addOrderTag: jest.fn(),
  };

  const orderEligibilityService = {
    evaluateOrderForVerification: jest.fn(),
  };

  const verificationSendService = {
    sendInitial: jest.fn(),
    sendFollowUp: jest.fn(),
  };

  const billingEntitlementService = {
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
    orderTaggingPort as any,
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
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
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
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
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
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
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
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
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
        ordersRepo.findByExternalId.mockResolvedValue(null);
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
      ordersRepo.findByExternalId.mockResolvedValue(null);
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

      ordersRepo.findByExternalId.mockResolvedValue(null);
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

      ordersRepo.findByExternalId.mockResolvedValue(null);
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

      ordersRepo.findByExternalId.mockResolvedValue(null);
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

      ordersRepo.findByExternalId.mockResolvedValue(null);
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

      ordersRepo.findByExternalId.mockResolvedValue({
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

      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-existing',
      });
      expect(verificationsRepo.create).not.toHaveBeenCalled();
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
    });
  });
});
