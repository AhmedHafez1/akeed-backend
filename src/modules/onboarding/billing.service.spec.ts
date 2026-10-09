import { BillingService } from './billing.service';
import type { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    storeName: 'Test Store',
    defaultLanguage: 'auto',
    isAutoVerifyEnabled: true,
    isActive: true,
    onboardingStatus: 'completed',
    billingPlanId: 'starter',
    pendingBillingPlanId: null,
    shopifySubscriptionId: 'gid://shopify/AppSubscription/OLD',
    billingStatus: 'active',
    billingInitiatedAt: null,
    billingActivatedAt: '2026-01-01T00:00:00Z',
    billingCanceledAt: null,
    billingStatusUpdatedAt: null,
    ...overrides,
  };
}

function createMocks() {
  const integrationsRepo = {
    findByPlatformDomain: jest.fn(),
    updateById: jest.fn<
      ReturnType<IntegrationsRepository['updateById']>,
      Parameters<IntegrationsRepository['updateById']>
    >(),
  };
  const freePlanClaimsRepo = {
    hasClaim: jest.fn().mockResolvedValue(false),
    createIfNew: jest.fn().mockResolvedValue(true),
    deleteByPlatformAndShop: jest.fn(),
  };
  const monthlyUsageRepo = {
    resetCountersForPeriod: jest.fn(),
    getIntegrationUsageForPeriod: jest
      .fn()
      .mockResolvedValue({ consumedCount: 0, includedLimit: 30 }),
  };
  const storePlatform = {
    createRecurringApplicationCharge: jest
      .fn()
      .mockResolvedValue('https://shopify.com/confirm'),
    getAppSubscriptionStatus: jest.fn(),
    cancelAppSubscription: jest.fn(),
  };
  const billingConfig = {
    resolvePlan: jest.fn().mockImplementation((planId: string) => ({
      id: planId,
      name: `Akeed ${planId}`,
      amount: planId === 'starter' ? 0 : 22.99,
      currencyCode: 'USD',
      testMode: true,
      includedVerifications: planId === 'starter' ? 30 : 1000,
    })),
    resolveAllPlans: jest.fn().mockReturnValue([]),
    isBillingRequired: jest.fn().mockReturnValue(true),
    getApiUrl: jest.fn().mockReturnValue('https://api.akeed.co'),
    getAppUrl: jest.fn().mockReturnValue('https://app.akeed.co'),
    getApiKey: jest.fn().mockReturnValue('key'),
    getApiSecret: jest.fn().mockReturnValue('secret'),
  };

  const service = new BillingService(
    integrationsRepo as any,
    freePlanClaimsRepo as any,
    monthlyUsageRepo as any,
    storePlatform as any,
    billingConfig as any,
  );

  return {
    service,
    integrationsRepo,
    freePlanClaimsRepo,
    monthlyUsageRepo,
    storePlatform,
    billingConfig,
  };
}

describe('BillingService', () => {
  it.each(['starter', 'pro'])(
    'blocks manual %s billing at the service boundary',
    async (planId) => {
      const mocks = createMocks();
      mocks.billingConfig.isBillingRequired.mockReturnValue(false);
      await expect(
        mocks.service.initiateBilling(
          makeIntegration({
            platformType: 'standalone',
            billingStatus: 'not_required',
          }) as never,
          planId as 'starter' | 'pro',
        ),
      ).rejects.toThrow('unavailable');
      expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
      expect(mocks.freePlanClaimsRepo.createIfNew).not.toHaveBeenCalled();
      expect(
        mocks.storePlatform.createRecurringApplicationCharge,
      ).not.toHaveBeenCalled();
      expect(mocks.storePlatform.cancelAppSubscription).not.toHaveBeenCalled();
    },
  );

  describe('activateStarterSilently — onboarding v2', () => {
    const starterPlan = {
      id: 'starter',
      name: 'Akeed Starter',
      amount: 0,
      currencyCode: 'USD',
      testMode: true,
      includedVerifications: 30,
    };
    const planless = {
      billingPlanId: null,
      billingStatus: null,
      shopifySubscriptionId: null,
    };

    it('claims and activates Starter for a planless store', async () => {
      const { service, freePlanClaimsRepo, integrationsRepo, billingConfig } =
        createMocks();
      billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
      integrationsRepo.updateById.mockResolvedValue(makeIntegration() as never);

      await expect(
        service.activateStarterSilently(makeIntegration(planless) as any),
      ).resolves.toBe('activated');
      expect(freePlanClaimsRepo.createIfNew).toHaveBeenCalled();
      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          billingPlanId: 'starter',
          billingStatus: 'active',
        }),
      );
    });

    it('leaves a reinstalled store planless instead of failing setup', async () => {
      const { service, freePlanClaimsRepo, integrationsRepo, billingConfig } =
        createMocks();
      billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
      freePlanClaimsRepo.createIfNew.mockResolvedValue(false);

      await expect(
        service.activateStarterSilently(makeIntegration(planless) as any),
      ).resolves.toBe('already_claimed');
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });

    describe('reinstall with the free claim already used', () => {
      const cancelledStarter = {
        billingPlanId: 'starter',
        billingStatus: 'cancelled',
        shopifySubscriptionId: null,
        onboardingStatus: 'pending',
      };

      it('resumes Starter with its remaining messages', async () => {
        const mocks = createMocks();
        mocks.billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
        mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);
        mocks.monthlyUsageRepo.getIntegrationUsageForPeriod.mockResolvedValue({
          consumedCount: 12,
          includedLimit: 30,
        });

        await expect(
          mocks.service.activateStarterSilently(
            makeIntegration(cancelledStarter) as any,
          ),
        ).resolves.toBe('resumed');

        expect(
          mocks.monthlyUsageRepo.getIntegrationUsageForPeriod,
        ).toHaveBeenCalledWith({
          integrationId: 'int-1',
          periodStart: '2026-01-01',
        });
        const [, updates] = mocks.integrationsRepo.updateById.mock.calls[0];
        expect(updates).toMatchObject({
          billingStatus: 'active',
          billingCanceledAt: null,
        });
        // The activation date keys the one-time allowance; moving it or
        // resetting the counters would hand out a second grant.
        expect(updates).not.toHaveProperty('billingActivatedAt');
        expect(updates).not.toHaveProperty('billingPlanId');
        expect(
          mocks.monthlyUsageRepo.resetCountersForPeriod,
        ).not.toHaveBeenCalled();
      });

      it('leaves the store planless once the allowance is spent', async () => {
        const mocks = createMocks();
        mocks.billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
        mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);
        mocks.monthlyUsageRepo.getIntegrationUsageForPeriod.mockResolvedValue({
          consumedCount: 30,
          includedLimit: 30,
        });

        await expect(
          mocks.service.activateStarterSilently(
            makeIntegration(cancelledStarter) as any,
          ),
        ).resolves.toBe('already_claimed');
        expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
      });

      it('does not resume a store that left on a paid plan', async () => {
        const mocks = createMocks();
        mocks.billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
        mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);

        await expect(
          mocks.service.activateStarterSilently(
            makeIntegration({
              ...cancelledStarter,
              billingPlanId: 'pro',
            }) as any,
          ),
        ).resolves.toBe('already_claimed');
        expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
      });

      it('lets the store pick Starter again from the plan list', async () => {
        const mocks = createMocks();
        mocks.billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
        mocks.freePlanClaimsRepo.hasClaim.mockResolvedValue(true);
        mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);
        const integration = makeIntegration(cancelledStarter);

        await expect(
          mocks.service.getBillingPlans(integration as any),
        ).resolves.toMatchObject({ isFreePlanClaimed: false });
        const result = await mocks.service.initiateBilling(
          integration as any,
          'starter',
        );
        expect(result.confirmationUrl).toContain('app.akeed.co');
        expect(mocks.integrationsRepo.updateById).toHaveBeenCalledWith(
          'int-1',
          expect.objectContaining({ billingStatus: 'active' }),
        );
      });

      it('reports the free plan as claimed once the allowance is spent', async () => {
        const mocks = createMocks();
        mocks.billingConfig.resolveAllPlans.mockReturnValue([starterPlan]);
        mocks.freePlanClaimsRepo.hasClaim.mockResolvedValue(true);
        mocks.monthlyUsageRepo.getIntegrationUsageForPeriod.mockResolvedValue({
          consumedCount: 30,
          includedLimit: 30,
        });

        await expect(
          mocks.service.getBillingPlans(
            makeIntegration(cancelledStarter) as any,
          ),
        ).resolves.toMatchObject({ isFreePlanClaimed: true });
      });
    });

    it('keeps an already active plan untouched', async () => {
      const { service, freePlanClaimsRepo } = createMocks();

      await expect(
        service.activateStarterSilently(
          makeIntegration({ billingPlanId: 'pro' }) as any,
        ),
      ).resolves.toBe('already_active');
      expect(freePlanClaimsRepo.createIfNew).not.toHaveBeenCalled();
    });
  });

  describe('initiateBilling — free plan claimed once per store', () => {
    it('rejects a second starter claim with a stable code', async () => {
      const mocks = createMocks();
      mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);

      await expect(
        mocks.service.initiateBilling(
          makeIntegration({
            billingPlanId: 'starter',
            billingStatus: 'cancelled',
            onboardingStatus: 'pending',
          }) as never,
          'starter',
        ),
      ).rejects.toMatchObject({
        response: { code: 'BILLING_FREE_PLAN_ALREADY_CLAIMED' },
      });
      expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
      expect(
        mocks.freePlanClaimsRepo.deleteByPlatformAndShop,
      ).not.toHaveBeenCalled();
    });
  });

  describe('initiateBilling — same-plan guard', () => {
    it('returns redirect without Shopify call when plan is already active', async () => {
      const { service, storePlatform } = createMocks();
      const integration = makeIntegration({
        billingPlanId: 'pro',
        billingStatus: 'active',
      });

      const result = await service.initiateBilling(integration as any, 'pro');

      expect(result.confirmationUrl).toContain('app.akeed.co');
      expect(
        storePlatform.createRecurringApplicationCharge,
      ).not.toHaveBeenCalled();
    });

    it('proceeds when plan differs from current', async () => {
      const { service, storePlatform } = createMocks();
      const integration = makeIntegration({
        billingPlanId: 'starter',
        billingStatus: 'active',
      });

      await service.initiateBilling(integration as any, 'pro');

      expect(storePlatform.createRecurringApplicationCharge).toHaveBeenCalled();
    });

    it('proceeds when billing status is not active', async () => {
      const { service, storePlatform } = createMocks();
      const integration = makeIntegration({
        billingPlanId: 'pro',
        billingStatus: 'declined',
      });

      await service.initiateBilling(integration as any, 'pro');

      expect(storePlatform.createRecurringApplicationCharge).toHaveBeenCalled();
    });
  });

  describe('initiatePaidPlan — does not overwrite active billing state', () => {
    it('writes pendingBillingPlanId and preserves billingPlanId and billingStatus', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        billingPlanId: 'starter',
        billingStatus: 'active',
      });

      await service.initiateBilling(integration as any, 'pro');

      const updateCall = integrationsRepo.updateById.mock.calls[0];
      expect(updateCall[0]).toBe('int-1');
      const updates = updateCall[1];

      // Should write pendingBillingPlanId
      expect(updates.pendingBillingPlanId).toBe('pro');
      // Should NOT write billingPlanId or billingStatus
      expect(updates.billingPlanId).toBeUndefined();
      expect(updates.billingStatus).toBeUndefined();
      // Should write billingInitiatedAt
      expect(updates.billingInitiatedAt).toBeDefined();
    });
  });

  describe('handleBillingCallback — active approval', () => {
    it('promotes pendingBillingPlanId to billingPlanId and resets usage', async () => {
      const { service, integrationsRepo, monthlyUsageRepo, storePlatform } =
        createMocks();
      const integration = makeIntegration({
        billingPlanId: 'starter',
        pendingBillingPlanId: 'pro',
        billingStatus: 'active',
        shopifySubscriptionId: 'gid://shopify/AppSubscription/OLD',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);
      storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'ACTIVE',
      });

      await service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'gid://shopify/AppSubscription/NEW',
      });

      // Should have called cancelAppSubscription for the old subscription
      expect(storePlatform.cancelAppSubscription).toHaveBeenCalledWith(
        integration,
        'gid://shopify/AppSubscription/OLD',
      );

      // Find the persistBillingState update (the one with planId)
      const activationCall = integrationsRepo.updateById.mock.calls.find(
        (call) => call[1].billingPlanId !== undefined,
      );
      expect(activationCall).toBeDefined();
      const updates = activationCall![1];
      expect(updates.billingPlanId).toBe('pro');
      expect(updates.pendingBillingPlanId).toBeNull();
      expect(updates.billingStatus).toBe('active');
      expect(updates.shopifySubscriptionId).toBe(
        'gid://shopify/AppSubscription/NEW',
      );

      // Should reset usage
      expect(monthlyUsageRepo.resetCountersForPeriod).toHaveBeenCalled();
    });
  });

  describe('handleBillingCallback — declined with existing active plan', () => {
    it('preserves current billingPlanId and billingStatus, clears pendingBillingPlanId', async () => {
      const { service, integrationsRepo, monthlyUsageRepo, storePlatform } =
        createMocks();
      const integration = makeIntegration({
        billingPlanId: 'starter',
        pendingBillingPlanId: 'pro',
        billingStatus: 'active',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);
      storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'DECLINED',
      });

      await service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'gid://shopify/AppSubscription/NEW',
      });

      const updateCall = integrationsRepo.updateById.mock.calls[0];
      const updates = updateCall[1];

      // Should clear pendingBillingPlanId
      expect(updates.pendingBillingPlanId).toBeNull();
      // Should NOT overwrite billingStatus or billingPlanId
      expect(updates.billingStatus).toBeUndefined();
      expect(updates.billingPlanId).toBeUndefined();
      // Should NOT reset usage
      expect(monthlyUsageRepo.resetCountersForPeriod).not.toHaveBeenCalled();
    });
  });

  describe('handleBillingCallback — declined during first onboarding (no active plan)', () => {
    it('writes declined status when there is no existing active plan', async () => {
      const { service, integrationsRepo, storePlatform } = createMocks();
      const integration = makeIntegration({
        billingPlanId: null,
        pendingBillingPlanId: 'pro',
        billingStatus: null,
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);
      storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'DECLINED',
      });

      await service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'gid://shopify/AppSubscription/NEW',
      });

      const updateCall = integrationsRepo.updateById.mock.calls[0];
      const updates = updateCall[1];

      expect(updates.pendingBillingPlanId).toBeNull();
      // Should write the declined status since there's no active plan
      expect(updates.billingStatus).toBe('declined');
    });
  });

  describe('free plan dead-end scenario — resolved by pendingBillingPlanId', () => {
    it('starter user upgrading to pro keeps billingPlanId=starter, so decline does not cause dead-end', async () => {
      const { service, integrationsRepo, storePlatform } = createMocks();

      // Step 1: Starter user initiates upgrade to pro
      const integration = makeIntegration({
        billingPlanId: 'starter',
        billingStatus: 'active',
      });

      await service.initiateBilling(integration as any, 'pro');

      // Verify billingPlanId was NOT changed
      const initiateUpdate = integrationsRepo.updateById.mock.calls[0][1];
      expect(initiateUpdate.billingPlanId).toBeUndefined();
      expect(initiateUpdate.pendingBillingPlanId).toBe('pro');

      // Step 2: Merchant declines
      const integrationAfterInitiate = makeIntegration({
        billingPlanId: 'starter',
        pendingBillingPlanId: 'pro',
        billingStatus: 'active',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        integrationAfterInitiate,
      );
      integrationsRepo.updateById.mockClear();
      storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'DECLINED',
      });

      await service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'gid://shopify/AppSubscription/NEW',
      });

      // Verify billingPlanId remains starter, billingStatus remains active
      const declineUpdate = integrationsRepo.updateById.mock.calls[0][1];
      expect(declineUpdate.billingPlanId).toBeUndefined();
      expect(declineUpdate.billingStatus).toBeUndefined();
      expect(declineUpdate.pendingBillingPlanId).toBeNull();
    });
  });

  describe('usage reset prevention', () => {
    it('does not reset usage when initiatePaidPlan is called (only on activation)', async () => {
      const { service, monthlyUsageRepo } = createMocks();
      const integration = makeIntegration({
        billingPlanId: 'starter',
        billingStatus: 'active',
      });

      await service.initiateBilling(integration as any, 'pro');

      expect(monthlyUsageRepo.resetCountersForPeriod).not.toHaveBeenCalled();
    });
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
