import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { ShopifyOutcomeAdapter } from '../../infrastructure/spokes/shopify/services/shopify-outcome.adapter';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { VerificationsService } from './verifications.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

const organizationOwner: AuthenticatedUser = {
  userId: 'owner-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

interface VerificationStatusCounts {
  total: number;
  pending: number;
  failed: number;
  awaitingReply: number;
  confirmed: number;
  canceled: number;
  customerCanceled: number;
  sent: number;
  delivered: number;
  read: number;
  followUpsSent: number;
}

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

function buildCounts(
  overrides: Partial<VerificationStatusCounts>,
): VerificationStatusCounts {
  return {
    total: 0,
    pending: 0,
    failed: 0,
    awaitingReply: 0,
    confirmed: 0,
    canceled: 0,
    customerCanceled: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    followUpsSent: 0,
    ...overrides,
  };
}

function callReplyRate(
  svc: VerificationsService,
  counts: Partial<VerificationStatusCounts>,
): number {
  return (svc as any).calculateReplyRate(buildCounts(counts));
}

function callConfirmationRate(
  svc: VerificationsService,
  counts: Partial<VerificationStatusCounts>,
): number {
  return (svc as any).calculateConfirmationRate(buildCounts(counts));
}

/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMocks() {
  const verificationsRepo = {
    findByIdForOrg: jest.fn(),
    markMerchantNoReplyCanceled: jest.fn(),
  };

  const ordersRepo = {
    findById: jest.fn(),
  };

  const orderAdmin = {
    cancelOrder: jest.fn(),
  };

  const orderTagging = {
    addOrderTag: jest.fn(),
  };

  const billingEntitlements = {
    readEntitlement: jest.fn().mockResolvedValue({
      consumedCount: 4,
      includedLimit: 30,
      periodEnd: '2026-10-01T00:00:00.000Z',
    }),
  };

  const service = new VerificationsService(
    verificationsRepo as any,
    billingEntitlements as any,
    null as any,
    ordersRepo as any,
    new CommerceOutcomeRegistryService(
      {
        findForOutcomeDispatch: (...args: unknown[]) =>
          ordersRepo.findById(...args) as unknown,
      } as never,
      [new ShopifyOutcomeAdapter({ ...orderAdmin, ...orderTagging } as never)],
    ),
  );

  return {
    service,
    verificationsRepo,
    ordersRepo,
    orderAdmin,
    orderTagging,
    billingEntitlements,
  };
}

function buildVerification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v-1',
    orgId: 'org-1',
    orderId: 'order-1',
    status: 'no_reply',
    cancellationSource: null,
    merchantCanceledAt: null,
    ...overrides,
  };
}

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: 'ext-123',
    integration: {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'shopify',
      isActive: true,
      platformStoreUrl: 'test.myshopify.com',
      accessToken: 'tok',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationsService', () => {
  it('rejects a viewer cancellation before tenant or provider lookup', async () => {
    const { service, verificationsRepo, ordersRepo, orderAdmin, orderTagging } =
      createMocks();

    await expect(
      service.cancelNoReplyOrder(
        { ...organizationOwner, userId: 'viewer-1', role: 'viewer' },
        'v-1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'VERIFICATION_ROLE_REQUIRED' },
    });
    expect(verificationsRepo.findByIdForOrg).not.toHaveBeenCalled();
    expect(ordersRepo.findById).not.toHaveBeenCalled();
    expect(orderAdmin.cancelOrder).not.toHaveBeenCalled();
    expect(orderTagging.addOrderTag).not.toHaveBeenCalled();
  });
  describe('calculateReplyRate', () => {
    let service: VerificationsService;

    beforeEach(() => {
      service = new VerificationsService(
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );
    });

    it('should return 0 when sent is 0', () => {
      expect(
        callReplyRate(service, {
          sent: 0,
        }),
      ).toBe(0);
    });

    it('never advertises more replies than sends', () => {
      // Replies and sends are counted off different columns, so a row carrying
      // a customer's answer but no recorded send used to push this past 100 —
      // the dashboard rendered a 150% reply rate. A share of sends is bounded
      // by definition, whatever the columns say.
      expect(
        callReplyRate(service, {
          total: 3,
          confirmed: 2,
          canceled: 1,
          customerCanceled: 1,
          sent: 2,
        }),
      ).toBe(100);
    });

    it('should return correct reply rate using sent denominator and customerCanceled', () => {
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 15,
          customerCanceled: 10,
          sent: 80,
          delivered: 80,
          read: 60,
        }),
      ).toBe(62.5);
    });

    it('should round to 1 decimal place', () => {
      expect(
        callReplyRate(service, {
          total: 3,
          confirmed: 1,
          canceled: 0,
          customerCanceled: 0,
          sent: 3,
          delivered: 2,
          read: 1,
        }),
      ).toBe(33.3);
    });

    it('should exclude merchant_no_reply cancellations from reply rate', () => {
      // 5 merchant_no_reply cancellations should not count as replies
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 15,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(50); // (40 + 10) / 100 = 50%, not (40 + 15) / 100 = 55%
    });

    it('should treat legacy null cancellationSource as customer cancel', () => {
      // When all canceled have customerCanceled = canceled (null source = customer)
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 10,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(50); // (40 + 10) / 100 = 50%
    });

    it('should not count pending or failed verifications as replies', () => {
      expect(
        callReplyRate(service, {
          total: 100,
          pending: 20,
          failed: 10,
          confirmed: 24,
          customerCanceled: 12,
          sent: 60,
        }),
      ).toBe(60);
    });
  });

  describe('calculateConfirmationRate', () => {
    let service: VerificationsService;

    beforeEach(() => {
      service = new VerificationsService(
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );
    });

    it('should return 0 when sent is 0', () => {
      expect(
        callConfirmationRate(service, {
          sent: 0,
        }),
      ).toBe(0);
    });

    it('never advertises more confirmations than sends', () => {
      expect(
        callConfirmationRate(service, {
          total: 2,
          confirmed: 2,
          sent: 1,
        }),
      ).toBe(100);
    });

    it('should return correct confirmation rate using sent denominator', () => {
      expect(
        callConfirmationRate(service, {
          total: 100,
          confirmed: 60,
          canceled: 10,
          customerCanceled: 10,
          sent: 80,
          delivered: 80,
          read: 60,
        }),
      ).toBe(75);
    });

    it('should round to 1 decimal place', () => {
      expect(
        callConfirmationRate(service, {
          total: 3,
          confirmed: 1,
          canceled: 0,
          customerCanceled: 0,
          sent: 3,
          delivered: 2,
          read: 1,
        }),
      ).toBe(33.3);
    });

    it('should return 100 when all are confirmed', () => {
      expect(
        callConfirmationRate(service, {
          total: 50,
          confirmed: 50,
          canceled: 0,
          customerCanceled: 0,
          sent: 50,
          delivered: 50,
          read: 50,
        }),
      ).toBe(100);
    });

    it('should not count pending or failed verifications as confirmations', () => {
      expect(
        callConfirmationRate(service, {
          total: 100,
          pending: 20,
          failed: 10,
          confirmed: 30,
          sent: 60,
        }),
      ).toBe(50);
    });
  });

  describe('cancelNoReplyOrder', () => {
    it('throws NotFoundException for non-owned verification', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(null);

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-nonexistent'),
      ).rejects.toThrow('Verification not found');
    });

    it('returns idempotent success for already merchant_no_reply canceled', async () => {
      const { service, verificationsRepo, orderAdmin } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(
        buildVerification({
          status: 'canceled',
          cancellationSource: 'merchant_no_reply',
          merchantCanceledAt: '2026-04-01T00:00:00Z',
        }),
      );

      const result = await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(result.success).toBe(true);
      expect(result.alreadyCanceled).toBe(true);
      expect(result.status).toBe('canceled');
      expect(orderAdmin.cancelOrder).not.toHaveBeenCalled();
    });

    it('rejects statuses other than no_reply', async () => {
      const statuses = [
        'pending',
        'sent',
        'delivered',
        'read',
        'confirmed',
        'expired',
        'failed',
      ];

      for (const status of statuses) {
        const { service, verificationsRepo } = createMocks();
        verificationsRepo.findByIdForOrg.mockResolvedValue(
          buildVerification({ status }),
        );

        await expect(
          service.cancelNoReplyOrder(organizationOwner, 'v-1'),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('rejects customer-canceled verifications (not idempotent)', async () => {
      const { service, verificationsRepo } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(
        buildVerification({
          status: 'canceled',
          cancellationSource: 'customer',
          merchantCanceledAt: null,
        }),
      );

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when order has no linked integration', async () => {
      const { service, verificationsRepo, ordersRepo } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue({
        integrationId: 'int-1',
        orgId: 'org-1',
        id: 'order-1',
        integration: null,
      });

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow('Cannot cancel: order has no linked integration');
    });

    it('rejects when order has no external order ID', async () => {
      const { service, verificationsRepo, ordersRepo } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(
        buildOrder({ externalOrderId: null }),
      );

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow('Cannot cancel: order has no external order ID');
    });

    it('calls Shopify cancellation before local update', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      const callOrder: string[] = [];

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockImplementation(() => {
        callOrder.push('shopify');
        return Promise.resolve({ jobId: 'job-1' });
      });
      verificationsRepo.markMerchantNoReplyCanceled.mockImplementation(() => {
        callOrder.push('local');
        return Promise.resolve(buildVerification({ status: 'canceled' }));
      });
      orderTagging.addOrderTag.mockResolvedValue(undefined);

      await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(callOrder).toEqual(['shopify', 'local']);
    });

    it('does not mark local canceled if Shopify cancellation fails', async () => {
      const { service, verificationsRepo, ordersRepo, orderAdmin } =
        createMocks();

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockRejectedValue(new Error('Shopify 502'));

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow(BadGatewayException);

      expect(
        verificationsRepo.markMerchantNoReplyCanceled,
      ).not.toHaveBeenCalled();
    });

    it('marks status=canceled with cancellationSource=merchant_no_reply and merchantCanceledAt', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockResolvedValue({ jobId: 'job-1' });
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(
        buildVerification({
          status: 'canceled',
          cancellationSource: 'merchant_no_reply',
        }),
      );
      orderTagging.addOrderTag.mockResolvedValue(undefined);

      const result = await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(result.status).toBe('canceled');
      expect(result.providerOperationId).toBe('job-1');
      expect(
        verificationsRepo.markMerchantNoReplyCanceled,
      ).toHaveBeenCalledWith(
        'v-1',
        'org-1',
        expect.any(String),
        expect.objectContaining({ status: expect.any(String) as unknown }),
      );
    });

    it('cancels test orders locally without calling Shopify', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(
        buildOrder({ externalOrderId: 'akeed-test-1770000000000' }),
      );
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(
        buildVerification({
          status: 'canceled',
          cancellationSource: 'merchant_no_reply',
        }),
      );

      const result = await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(result.status).toBe('canceled');
      expect(result.providerOperationId).toBeUndefined();
      expect(orderAdmin.cancelOrder).not.toHaveBeenCalled();
      expect(orderTagging.addOrderTag).not.toHaveBeenCalled();
      expect(
        verificationsRepo.markMerchantNoReplyCanceled,
      ).toHaveBeenCalledWith(
        'v-1',
        'org-1',
        expect.any(String),
        expect.objectContaining({ status: expect.any(String) as unknown }),
      );
    });

    it('applies Akeed: Canceled tag after local update', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockResolvedValue({ jobId: undefined });
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(
        buildVerification({ status: 'canceled' }),
      );
      orderTagging.addOrderTag.mockResolvedValue(undefined);

      await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(orderTagging.addOrderTag).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'int-1' }),
        'ext-123',
        'Akeed: Canceled',
      );
    });

    it('tag failure logs but still returns cancellation success', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockResolvedValue({ jobId: 'job-1' });
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(
        buildVerification({ status: 'canceled' }),
      );
      orderTagging.addOrderTag.mockRejectedValue(new Error('tag failed'));

      const result = await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(result.success).toBe(true);
      expect(result.status).toBe('canceled');
    });

    it('handles race condition when status changes during cancellation', async () => {
      const { service, verificationsRepo, ordersRepo, orderAdmin } =
        createMocks();

      verificationsRepo.findByIdForOrg
        .mockResolvedValueOnce(buildVerification())
        .mockResolvedValueOnce(buildVerification({ status: 'confirmed' }));
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockResolvedValue({ jobId: 'job-1' });
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(null);

      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns idempotent success on race when another thread already merchant-canceled', async () => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();

      verificationsRepo.findByIdForOrg
        .mockResolvedValueOnce(buildVerification())
        .mockResolvedValueOnce(
          buildVerification({
            status: 'canceled',
            cancellationSource: 'merchant_no_reply',
            merchantCanceledAt: '2026-04-01T00:00:00Z',
          }),
        );
      ordersRepo.findById.mockResolvedValue(buildOrder());
      orderAdmin.cancelOrder.mockResolvedValue({ jobId: 'job-1' });
      verificationsRepo.markMerchantNoReplyCanceled.mockResolvedValue(null);
      orderTagging.addOrderTag.mockResolvedValue(undefined);

      const result = await service.cancelNoReplyOrder(organizationOwner, 'v-1');

      expect(result.success).toBe(true);
      expect(result.alreadyCanceled).toBe(true);
    });
  });
});

describe('Merchant cancellation source and operation contract', () => {
  it.each([
    'inactive',
    'foreign_owner',
    'wrong_integration',
    'unsupported',
    'foreign_order',
  ])(
    'rejects %s without outbound cancellation or local mutation',
    async (kind) => {
      const {
        service,
        verificationsRepo,
        ordersRepo,
        orderAdmin,
        orderTagging,
      } = createMocks();
      verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
      const order = buildOrder();
      if (kind === 'inactive') order.integration.isActive = false;
      if (kind === 'foreign_owner') order.integration.orgId = 'org-2';
      if (kind === 'wrong_integration') order.integration.id = 'int-2';
      if (kind === 'unsupported') order.integration.platformType = 'standalone';
      if (kind === 'foreign_order') order.orgId = 'org-2';
      ordersRepo.findById.mockResolvedValue(order);
      await expect(
        service.cancelNoReplyOrder(organizationOwner, 'v-1'),
      ).rejects.toThrow(BadRequestException);
      expect(orderAdmin.cancelOrder).not.toHaveBeenCalled();
      expect(orderTagging.addOrderTag).not.toHaveBeenCalled();
      expect(
        verificationsRepo.markMerchantNoReplyCanceled,
      ).not.toHaveBeenCalled();
    },
  );

  it('returns stored pending operation on idempotent repeat without another provider action', async () => {
    const { service, verificationsRepo, orderAdmin } = createMocks();
    const operation = {
      status: 'pending_provider_operation',
      providerOperationId: 'gid://shopify/Job/42',
    };
    verificationsRepo.findByIdForOrg.mockResolvedValue(
      buildVerification({
        status: 'canceled',
        cancellationSource: 'merchant_no_reply',
        merchantCanceledAt: '2026-09-02T00:00:00Z',
        metadata: { commerceCancellation: operation, retained: true },
      }),
    );
    await expect(
      service.cancelNoReplyOrder(organizationOwner, 'v-1'),
    ).resolves.toEqual({
      success: true,
      verificationId: 'v-1',
      status: 'canceled',
      alreadyCanceled: true,
      operation,
      providerOperationId: operation.providerOperationId,
    });
    expect(orderAdmin.cancelOrder).not.toHaveBeenCalled();
  });

  it('keeps the cancel/local/tag sequence across adapter dispatch', async () => {
    const { service, verificationsRepo, ordersRepo, orderAdmin, orderTagging } =
      createMocks();
    const sequence: string[] = [];
    verificationsRepo.findByIdForOrg.mockResolvedValue(buildVerification());
    ordersRepo.findById.mockResolvedValue(buildOrder());
    orderAdmin.cancelOrder.mockImplementation(() => {
      sequence.push('cancel');
      return Promise.resolve({ jobId: 'operation-1' });
    });
    verificationsRepo.markMerchantNoReplyCanceled.mockImplementation(() => {
      sequence.push('local');
      return Promise.resolve(buildVerification({ status: 'canceled' }));
    });
    orderTagging.addOrderTag.mockImplementation(() => {
      sequence.push('tag');
      return Promise.resolve();
    });
    await service.cancelNoReplyOrder(organizationOwner, 'v-1');
    expect(sequence).toEqual(['cancel', 'local', 'tag']);
    expect(verificationsRepo.markMerchantNoReplyCanceled).toHaveBeenCalledWith(
      'v-1',
      'org-1',
      expect.any(String),
      {
        status: 'pending_provider_operation',
        providerOperationId: 'operation-1',
      },
    );
  });
});

describe('Dashboard cancellation capabilities', () => {
  it.each(['shopify', 'standalone', 'inactive', 'missing', 'foreign'])(
    'reports per-order support for %s without provider calls',
    async (kind) => {
      const repo = {
        findByOrg: jest.fn().mockResolvedValue([
          {
            id: 'ver-1',
            status: 'no_reply',
            orderId: 'order-1',
            order: { orgId: 'org-1', integrationId: 'int-1' },
          },
        ]),
        countByOrg: jest.fn().mockResolvedValue(1),
      };
      const integration = {
        id: 'int-1',
        orgId: kind === 'foreign' ? 'org-2' : 'org-1',
        isActive: kind !== 'inactive',
        platformType: kind === 'standalone' ? 'standalone' : 'shopify',
      };
      const integrations = {
        findByOrg: jest
          .fn()
          .mockResolvedValue(kind === 'missing' ? [] : [integration]),
      };
      const registry = new CommerceOutcomeRegistryService({} as never, [
        new ShopifyOutcomeAdapter({} as never),
      ]);
      const service = new VerificationsService(
        repo as never,
        {
          readEntitlement: jest.fn().mockResolvedValue({
            consumedCount: 0,
            includedLimit: 30,
            periodEnd: null,
          }),
        } as never,
        integrations as never,
        {} as never,
        registry,
      );
      const result = await service.listByOrg('org-1', {});
      expect(result.data[0].capabilities).toEqual([
        {
          action: 'merchant_no_reply_cancellation',
          supported: kind === 'shopify',
        },
        // A `no_reply` verification is never retryable, whatever the source —
        // retry is reserved for resolvable send failures.
        { action: 'retry_verification', supported: false },
      ]);
      if (kind === 'standalone') {
        expect(result.page_context?.usage).toEqual({
          used: 0,
          limit: 30,
          remaining: 30,
          period_end: null,
        });
      }
      expect(JSON.stringify(result)).not.toContain('accessToken');
    },
  );
});
