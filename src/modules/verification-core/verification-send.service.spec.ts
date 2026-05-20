import { VerificationSendService } from './verification-send.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

function createMocks() {
  const verificationsRepo = {
    findById: jest.fn(),
    updateStatus: jest.fn(),
  };
  const ordersRepo = {
    findById: jest.fn(),
  };
  const integrationsRepo = {
    findActiveByOrgAndPlatform: jest.fn(),
  };
  const billingEntitlementService = {
    reserveVerificationSlot: jest.fn(),
    releaseVerificationSlot: jest.fn(),
  };
  const messagingPort = {
    sendVerificationTemplate: jest.fn(),
  };

  const service = new VerificationSendService(
    verificationsRepo as any,
    ordersRepo as any,
    integrationsRepo as any,
    billingEntitlementService as any,
    messagingPort as any,
  );

  return {
    service,
    verificationsRepo,
    ordersRepo,
    integrationsRepo,
    billingEntitlementService,
    messagingPort,
  };
}

const baseIntegration = {
  id: 'int-1',
  orgId: 'org-1',
  defaultLanguage: 'ar',
  billingPlanId: 'pro',
  billingActivatedAt: '2026-01-01T00:00:00Z',
  shopifySubscriptionId: 'sub-1',
};

describe('VerificationSendService', () => {
  describe('sendInitial', () => {
    it('reserves quota at send time and marks status=sent on success', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        billingEntitlementService,
        messagingPort,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        externalOrderId: 'ext-1',
        totalPrice: '100.00',
        integration: baseIntegration,
      });

      const callOrder: string[] = [];
      billingEntitlementService.reserveVerificationSlot.mockImplementation(
        () => {
          callOrder.push('reserve');
          return Promise.resolve({
            allowed: true,
            isOverage: false,
            consumedCount: 1,
            includedLimit: 1000,
            periodStart: '2026-01-01',
            planId: 'pro',
          });
        },
      );
      messagingPort.sendVerificationTemplate.mockImplementation(() => {
        callOrder.push('send');
        return Promise.resolve({ messages: [{ id: 'wamid-1' }] });
      });

      const outcome = await service.sendInitial('ver-1');

      expect(callOrder).toEqual(['reserve', 'send']);
      expect(outcome).toEqual({
        status: 'sent',
        waMessageId: 'wamid-1',
        sentAt: expect.any(String) as string,
      });
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'sent',
        'wamid-1',
      );
    });

    it('releases quota and marks failed when send throws', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        billingEntitlementService,
        messagingPort,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        externalOrderId: 'ext-1',
        totalPrice: '100.00',
        integration: baseIntegration,
      });
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue({
        allowed: true,
        isOverage: false,
        consumedCount: 1,
        includedLimit: 1000,
        periodStart: '2026-01-01',
        planId: 'pro',
      });
      messagingPort.sendVerificationTemplate.mockRejectedValue(
        new Error('Meta timeout'),
      );

      const outcome = await service.sendInitial('ver-1');

      expect(outcome).toEqual({ status: 'failed', reason: 'send_error' });
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

    it('releases quota and marks failed when wamid is missing', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        billingEntitlementService,
        messagingPort,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        externalOrderId: 'ext-1',
        totalPrice: '100.00',
        integration: baseIntegration,
      });
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue({
        allowed: true,
        isOverage: false,
        consumedCount: 1,
        includedLimit: 1000,
        periodStart: '2026-01-01',
        planId: 'pro',
      });
      messagingPort.sendVerificationTemplate.mockResolvedValue({
        messages: [],
      });

      const outcome = await service.sendInitial('ver-1');

      expect(outcome).toEqual({ status: 'failed', reason: 'missing_wamid' });
      expect(
        billingEntitlementService.releaseVerificationSlot,
      ).toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'failed',
      );
    });

    it('returns plan_limit_reached without sending when reservation denied', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        billingEntitlementService,
        messagingPort,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        externalOrderId: 'ext-1',
        totalPrice: '100.00',
        integration: baseIntegration,
      });
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue({
        allowed: false,
        isOverage: false,
        consumedCount: 1000,
        includedLimit: 1000,
        periodStart: '2026-01-01',
        planId: 'pro',
      });

      const outcome = await service.sendInitial('ver-1');

      expect(outcome.status).toBe('plan_limit_reached');
      expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('sendFollowUp', () => {
    it('reserves quota and does NOT mark status=sent on success', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        billingEntitlementService,
        messagingPort,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        externalOrderId: 'ext-1',
        totalPrice: '100.00',
        integration: baseIntegration,
      });
      billingEntitlementService.reserveVerificationSlot.mockResolvedValue({
        allowed: true,
        isOverage: false,
        consumedCount: 2,
        includedLimit: 1000,
        periodStart: '2026-01-01',
        planId: 'pro',
      });
      messagingPort.sendVerificationTemplate.mockResolvedValue({
        messages: [{ id: 'wamid-2' }],
      });

      const outcome = await service.sendFollowUp('ver-1');

      expect(outcome).toEqual({
        status: 'sent',
        waMessageId: 'wamid-2',
        sentAt: expect.any(String) as string,
      });
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).toHaveBeenCalledWith(baseIntegration);
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });
});
