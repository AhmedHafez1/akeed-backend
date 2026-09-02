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
  isActive: true,
  billingStatus: 'active',
  storeName: 'Akeed Fashion',
  defaultLanguage: 'ar',
  codTemplateArVariant: 'gulf',
  codTemplateEnVariant: 'direct',
  billingPlanId: 'pro',
  billingActivatedAt: '2026-01-01T00:00:00Z',
  shopifySubscriptionId: 'sub-1',
};

describe('VerificationSendService', () => {
  describe('failure and retry boundaries', () => {
    function setup(billingStatus = 'active') {
      const mocks = createMocks();
      const verification = {
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        waMessageId: 'original-wamid',
      };
      mocks.verificationsRepo.findById.mockResolvedValue(verification);
      mocks.ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-1',
        customerPhone: '+201001234567',
        totalPrice: '123.40',
        integration: { ...baseIntegration, billingStatus },
      });
      mocks.billingEntitlementService.reserveVerificationSlot.mockResolvedValue(
        {
          allowed: true,
          periodStart: '2026-05-01',
          includedLimit: 1000,
          consumedCount: 1,
        },
      );
      mocks.messagingPort.sendVerificationTemplate.mockResolvedValue({
        messages: [{ id: 'new-wamid' }],
      });
      return { ...mocks, verification };
    }

    it.each(['active', 'not_required'])(
      'allows initial and follow-up sends with %s billing',
      async (billingStatus) => {
        const { service, billingEntitlementService, messagingPort } =
          setup(billingStatus);
        await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
          status: 'sent',
        });
        await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
          status: 'sent',
        });
        expect(
          billingEntitlementService.reserveVerificationSlot,
        ).toHaveBeenCalledTimes(2);
        expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledTimes(2);
      },
    );

    it.each(['send_error', 'missing_wamid'])(
      'follow-up %s releases quota and preserves the original request',
      async (reason) => {
        const {
          service,
          verificationsRepo,
          messagingPort,
          billingEntitlementService,
          verification,
        } = setup();
        if (reason === 'send_error')
          messagingPort.sendVerificationTemplate.mockRejectedValue(
            new Error('known rejection'),
          );
        else
          messagingPort.sendVerificationTemplate.mockResolvedValue({
            messages: [],
          });
        await expect(service.sendFollowUp('ver-1')).resolves.toEqual({
          status: 'failed',
          reason,
        });
        expect(
          billingEntitlementService.releaseVerificationSlot,
        ).toHaveBeenCalledWith({
          integrationId: 'int-1',
          periodStart: '2026-05-01',
        });
        expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
        expect(verification).toMatchObject({
          status: 'sent',
          waMessageId: 'original-wamid',
        });
      },
    );

    it('allows a later follow-up attempt after a known rejection with successful release', async () => {
      const { service, messagingPort, billingEntitlementService } = setup();
      messagingPort.sendVerificationTemplate.mockRejectedValueOnce(
        new Error('known rejection'),
      );
      await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).toHaveBeenCalledTimes(2);
      expect(
        billingEntitlementService.releaseVerificationSlot,
      ).toHaveBeenCalledTimes(1);
    });

    it.each(['sendInitial', 'sendFollowUp'] as const)(
      'US-06-02: %s swallows failed quota release; reservation recovery is not guaranteed',
      async (method) => {
        const {
          service,
          messagingPort,
          billingEntitlementService,
          verificationsRepo,
        } = setup();
        messagingPort.sendVerificationTemplate.mockRejectedValue(
          new Error('provider rejection'),
        );
        billingEntitlementService.releaseVerificationSlot.mockRejectedValue(
          new Error('usage store unavailable'),
        );
        await expect(service[method]('ver-1')).resolves.toEqual({
          status: 'failed',
          reason: 'send_error',
        });
        expect(
          billingEntitlementService.releaseVerificationSlot,
        ).toHaveBeenCalledTimes(1);
        if (method === 'sendInitial')
          expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
            'ver-1',
            'failed',
          );
        else expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      },
    );

    it('US-06-02: provider acceptance then failed local persistence leaves a retry able to send and reserve again', async () => {
      const {
        service,
        verificationsRepo,
        messagingPort,
        billingEntitlementService,
        verification,
      } = setup();
      verification.status = 'pending';
      verificationsRepo.updateStatus.mockRejectedValueOnce(
        new Error('local persistence unavailable'),
      );
      await expect(service.sendInitial('ver-1')).rejects.toThrow(
        'local persistence unavailable',
      );
      expect(verification.status).toBe('pending');
      expect(
        billingEntitlementService.releaseVerificationSlot,
      ).not.toHaveBeenCalled();
      await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledTimes(2);
      expect(
        billingEntitlementService.reserveVerificationSlot,
      ).toHaveBeenCalledTimes(2);
    });
  });
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
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        customerName: 'Sara',
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
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith({
        to: '+966500000000',
        customerName: 'Sara',
        storeName: 'Akeed Fashion',
        orderNumber: 'ext-1',
        totalPrice: '100.00',
        verificationId: 'ver-1',
        preferredLanguage: 'ar',
        templateSelection: {
          ar: 'gulf',
          en: 'direct',
        },
      });
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
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        customerName: 'Sara',
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
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        customerName: 'Sara',
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
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        customerName: 'Sara',
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

    it.each([
      [
        'an uninstalled integration',
        { isActive: false, billingStatus: 'active' },
        'integration_inactive',
      ],
      [
        'inactive billing',
        { isActive: true, billingStatus: 'cancelled' },
        'billing_not_active',
      ],
    ])(
      'skips before reserving quota for %s',
      async (_label, integrationOverrides, expectedReason) => {
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
          integrationId: 'int-1',
          id: 'order-1',
          orgId: 'org-1',
          customerPhone: '+966500000000',
          externalOrderId: 'ext-1',
          integration: { ...baseIntegration, ...integrationOverrides },
        });

        await expect(service.sendInitial('ver-1')).resolves.toEqual({
          status: 'skipped',
          reason: expectedReason,
        });
        expect(
          billingEntitlementService.reserveVerificationSlot,
        ).not.toHaveBeenCalled();
        expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
      },
    );
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
        integrationId: 'int-1',
        id: 'order-1',
        orgId: 'org-1',
        customerPhone: '+966500000000',
        customerName: 'Sara',
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

describe('VerificationSendService trusted integration boundary', () => {
  it.each(['sendInitial', 'sendFollowUp'] as const)(
    'rejects invalid source identity before quota or messaging for %s',
    async (method) => {
      for (const kind of [
        'missing',
        'wrong_integration',
        'wrong_owner',
        'wrong_order_owner',
      ]) {
        const {
          service,
          verificationsRepo,
          ordersRepo,
          integrationsRepo,
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
          orgId: kind === 'wrong_order_owner' ? 'org-2' : 'org-1',
          integrationId: 'int-1',
          integration:
            kind === 'missing'
              ? null
              : {
                  ...baseIntegration,
                  id: kind === 'wrong_integration' ? 'int-2' : 'int-1',
                  orgId: kind === 'wrong_owner' ? 'org-2' : 'org-1',
                },
        });
        await expect(service[method]('ver-1')).resolves.toEqual({
          status: 'skipped',
          reason:
            kind === 'missing'
              ? 'missing_linked_integration'
              : 'source_identity_mismatch',
        });
        expect(
          integrationsRepo.findActiveByOrgAndPlatform,
        ).not.toHaveBeenCalled();
        expect(
          billingEntitlementService.reserveVerificationSlot,
        ).not.toHaveBeenCalled();
        expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
      }
    },
  );
});
