import { BillingService } from './billing.service';

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
    updateById: jest.fn(),
  };
  const freePlanClaimsRepo = {
    hasClaim: jest.fn().mockResolvedValue(false),
    createIfNew: jest.fn().mockResolvedValue(true),
    deleteByPlatformAndShop: jest.fn(),
  };
  const monthlyUsageRepo = {
    resetCountersForPeriod: jest.fn(),
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
        (call: any[]) => call[1].billingPlanId !== undefined,
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
