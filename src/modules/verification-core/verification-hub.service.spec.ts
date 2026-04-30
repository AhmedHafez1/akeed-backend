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
    ...overrides,
  } as IntegrationRecord;
}

function buildMockReservation(
  overrides: Partial<{
    allowed: boolean;
    isOverage: boolean;
    consumedCount: number;
    includedLimit: number;
    periodStart: string;
    planId: string;
  }> = {},
) {
  return {
    allowed: true,
    isOverage: false,
    consumedCount: 5,
    includedLimit: 1000,
    periodStart: '2026-01-01',
    planId: 'pro',
    ...overrides,
  };
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
  };

  const messagingPort = {
    sendVerificationTemplate: jest.fn(),
  };

  const orderTaggingPort = {
    addOrderTag: jest.fn(),
  };

  const billingEntitlementService = {
    reserveVerificationSlot: jest.fn(),
    releaseVerificationSlot: jest.fn(),
  };

  const orderEligibilityService = {
    evaluateOrderForVerification: jest.fn(),
  };

  const service = new VerificationHubService(
    ordersRepo as any,
    verificationsRepo as any,
    messagingPort as any,
    orderTaggingPort as any,
    billingEntitlementService as any,
    orderEligibilityService as any,
  );

  return {
    service,
    ordersRepo,
    verificationsRepo,
    messagingPort,
    orderTaggingPort,
    billingEntitlementService,
    orderEligibilityService,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationHubService', () => {
  describe('handleNewOrder — auto-verify disabled', () => {
    it('should skip before order creation when isAutoVerifyEnabled=false', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const order = buildOrder();
      const integration = buildIntegration({ isAutoVerifyEnabled: false });

      const result = await service.handleNewOrder(order, integration);

      expect(result).toEqual({ skipped: true, reason: 'auto_verify_disabled' });
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
      expect(ordersRepo.create).not.toHaveBeenCalled();
      expect(verificationsRepo.create).not.toHaveBeenCalled();
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).not.toHaveBeenCalled();
      expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
    });

    it('should process normally when isAutoVerifyEnabled=true', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const dbOrder = {
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      };
      ordersRepo.findByExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue(dbOrder);
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue(
        buildMockReservation(),
      );
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      messagingPort.sendVerificationTemplate.mockResolvedValue({
        messages: [{ id: 'wamid-123' }],
      });
      verificationsRepo.updateStatus.mockResolvedValue([{ id: 'ver-1' }]);

      const order = buildOrder();
      const integration = buildIntegration({ isAutoVerifyEnabled: true });

      const result = await service.handleNewOrder(order, integration);

      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-1',
      });
      expect(ordersRepo.create).toHaveBeenCalled();
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).toHaveBeenCalled();
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalled();
    });

    it('should check COD eligibility before auto-verify', async () => {
      const {
        service,
        ordersRepo,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: false,
        reason: 'non_cod_payment_method',
      });

      const order = buildOrder();
      const integration = buildIntegration({ isAutoVerifyEnabled: false });

      const result = await service.handleNewOrder(order, integration);

      // Non-COD should be the reason, not auto_verify_disabled
      expect(result).toEqual({
        skipped: true,
        reason: 'non_cod_payment_method',
      });
      expect(ordersRepo.findByExternalId).not.toHaveBeenCalled();
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).not.toHaveBeenCalled();
    });
  });

  describe('handleNewOrder — billing guardrails', () => {
    it('should reserve quota before sending WhatsApp', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const dbOrder = {
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      };
      ordersRepo.findByExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue(dbOrder);
      verificationsRepo.findByOrderId.mockResolvedValue(null);

      const callOrder: string[] = [];
      billingEntitlementService.reserveVerificationSlot.mockImplementation(
        () => {
          callOrder.push('reserveSlot');
          return Promise.resolve(buildMockReservation());
        },
      );
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      messagingPort.sendVerificationTemplate.mockImplementation(() => {
        callOrder.push('sendTemplate');
        return Promise.resolve({ messages: [{ id: 'wamid-123' }] });
      });
      verificationsRepo.updateStatus.mockResolvedValue([{ id: 'ver-1' }]);

      const order = buildOrder();
      const integration = buildIntegration();

      await service.handleNewOrder(order, integration);

      expect(callOrder).toEqual(['reserveSlot', 'sendTemplate']);
    });

    it('should release quota when WhatsApp send throws', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const dbOrder = {
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      };
      ordersRepo.findByExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue(dbOrder);
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue(
        buildMockReservation({ periodStart: '2026-01-01' }),
      );
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      messagingPort.sendVerificationTemplate.mockRejectedValue(
        new Error('Meta API timeout'),
      );
      verificationsRepo.updateStatus.mockResolvedValue([]);

      const order = buildOrder();
      const integration = buildIntegration();

      await expect(service.handleNewOrder(order, integration)).rejects.toThrow(
        'Meta API timeout',
      );

      expect(
        billingEntitlementService.releaseVerificationSlot,
      ).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart: '2026-01-01',
      });
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'failed',
      );
    });

    it('should release quota when Meta returns no message ID', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const dbOrder = {
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      };
      ordersRepo.findByExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue(dbOrder);
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue(
        buildMockReservation({ periodStart: '2026-01-01' }),
      );
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });
      messagingPort.sendVerificationTemplate.mockResolvedValue({
        messages: [],
      });
      verificationsRepo.updateStatus.mockResolvedValue([]);

      const order = buildOrder();
      const integration = buildIntegration();

      const result = await service.handleNewOrder(order, integration);

      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-1',
      });
      expect(
        billingEntitlementService.releaseVerificationSlot,
      ).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart: '2026-01-01',
      });
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'failed',
      );
    });

    it('should not send when plan limit is reached', async () => {
      const {
        service,
        ordersRepo,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        orderEligibilityService,
      } = createMocks();

      orderEligibilityService.evaluateOrderForVerification.mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      });

      const dbOrder = {
        id: 'order-db-1',
        orgId: 'org-1',
        externalOrderId: 'ext-order-1',
      };
      ordersRepo.findByExternalId.mockResolvedValue(null);
      ordersRepo.create.mockResolvedValue(dbOrder);
      verificationsRepo.findByOrderId.mockResolvedValue(null);
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue(
        buildMockReservation({
          allowed: false,
          consumedCount: 1000,
          includedLimit: 1000,
        }),
      );
      verificationsRepo.create.mockResolvedValue({
        id: 'ver-1',
        orgId: 'org-1',
      });

      const order = buildOrder();
      const integration = buildIntegration();

      const result = await service.handleNewOrder(order, integration);

      expect(result).toEqual({
        orderId: 'order-db-1',
        verificationId: 'ver-1',
      });
      expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
      // Verification is created with status=failed metadata
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const createCall = verificationsRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(createCall.status).toBe('failed');
      expect(createCall.metadata).toEqual(
        expect.objectContaining({ reason: 'plan_limit_reached' }),
      );
    });
  });
});
