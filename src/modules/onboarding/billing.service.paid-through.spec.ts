import { BillingService } from './billing.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

// The real case: Pro ($22.99, 1,000 messages) activated Oct 31 08:30 UTC,
// uninstalled Nov 11 16:54, reinstalled 7 minutes later with 180 used.
const ACTIVATED_AT = '2026-10-31T08:30:00.000Z';
const PAID_THROUGH_AT = '2026-11-30T08:30:00.000Z';
const REINSTALL_AT = new Date('2026-11-11T17:01:00.000Z');

const PLANS = [
  { id: 'starter', amount: 0, includedVerifications: 30 },
  { id: 'basic', amount: 9.99, includedVerifications: 300 },
  { id: 'pro', amount: 22.99, includedVerifications: 1000 },
  { id: 'business', amount: 49.99, includedVerifications: 2500 },
].map((plan) => ({
  ...plan,
  name: `Akeed ${plan.id}`,
  currencyCode: 'USD',
  testMode: true,
}));

/** The row as the reinstall leaves it: uninstalled Pro with a paid date. */
function reinstalledPro(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    storeName: 'Test Store',
    defaultLanguage: 'auto',
    isAutoVerifyEnabled: true,
    isActive: true,
    onboardingStatus: 'pending',
    billingPlanId: 'pro',
    pendingBillingPlanId: null,
    shopifySubscriptionId: null,
    billingStatus: 'cancelled',
    billingInitiatedAt: null,
    billingActivatedAt: ACTIVATED_AT,
    billingCanceledAt: '2026-11-11T16:54:00.000Z',
    billingStatusUpdatedAt: null,
    paidThroughAt: PAID_THROUGH_AT,
    ...overrides,
  };
}

/** The same store once the reinstall resumed its plan. */
function inPaidThrough(overrides: Record<string, unknown> = {}) {
  return reinstalledPro({
    billingStatus: 'paid_through',
    billingCanceledAt: null,
    onboardingStatus: 'completed',
    ...overrides,
  });
}

function createMocks() {
  const integrationsRepo = {
    findByPlatformDomain: jest.fn(),
    updateById: jest
      .fn<Promise<void>, [string, Record<string, unknown>]>()
      .mockResolvedValue(undefined),
  };
  const freePlanClaimsRepo = {
    hasClaim: jest.fn().mockResolvedValue(true),
    createIfNew: jest.fn().mockResolvedValue(true),
    deleteByPlatformAndShop: jest.fn(),
  };
  const monthlyUsageRepo = {
    resetCountersForPeriod: jest.fn(),
    getIntegrationUsageForPeriod: jest
      .fn()
      .mockResolvedValue({ consumedCount: 180, includedLimit: 1000 }),
  };
  const storePlatform = {
    createRecurringApplicationCharge: jest
      .fn<Promise<string>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue('https://shopify.com/confirm'),
    getAppSubscriptionStatus: jest.fn(),
    cancelAppSubscription: jest.fn(),
  };
  const billingConfig = {
    resolvePlan: jest.fn((planId: string) =>
      PLANS.find((plan) => plan.id === planId),
    ),
    resolveAllPlans: jest.fn().mockReturnValue(PLANS),
    isBillingRequired: jest.fn().mockReturnValue(true),
    getAppUrl: jest.fn().mockReturnValue('https://app.akeed.co'),
    shouldSkipCustomAppBillingError: jest.fn().mockReturnValue(false),
  };
  const adminLifecycles = {
    markMilestone: jest.fn(),
    recordEvent: jest.fn(),
  };
  const capacityRecovery = { request: jest.fn() };
  const service = new BillingService(
    integrationsRepo as any,
    freePlanClaimsRepo as any,
    monthlyUsageRepo as any,
    storePlatform as any,
    billingConfig as any,
    adminLifecycles as any,
    capacityRecovery as any,
  );
  return {
    service,
    integrationsRepo,
    freePlanClaimsRepo,
    monthlyUsageRepo,
    storePlatform,
    adminLifecycles,
    capacityRecovery,
  };
}

function lastUpdate(mocks: ReturnType<typeof createMocks>) {
  const calls = mocks.integrationsRepo.updateById.mock.calls;
  return calls[calls.length - 1]?.[1];
}

describe('BillingService — paid-through resume', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: REINSTALL_AT });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('reinstall', () => {
    it('gives the paid plan back as it was, before Starter is considered', async () => {
      const mocks = createMocks();

      await expect(
        mocks.service.activateStarterSilently(reinstalledPro() as any),
      ).resolves.toBe('resumed_paid_through');

      const update = lastUpdate(mocks);
      expect(update).toMatchObject({
        billingStatus: 'paid_through',
        shopifySubscriptionId: null,
        billingCanceledAt: null,
      });
      // Same plan, same period anchor, same counters: 180/1,000 used.
      expect(update).not.toHaveProperty('billingPlanId');
      expect(update).not.toHaveProperty('billingActivatedAt');
      expect(update).not.toHaveProperty('paidThroughAt');
      expect(
        mocks.monthlyUsageRepo.resetCountersForPeriod,
      ).not.toHaveBeenCalled();
      expect(mocks.freePlanClaimsRepo.createIfNew).not.toHaveBeenCalled();
      expect(mocks.capacityRecovery.request).toHaveBeenCalledWith(
        'org-1',
        'plan_activated',
      );
    });

    it('resumes even when the store never claimed Starter (no Starter in its place)', async () => {
      const mocks = createMocks();
      mocks.freePlanClaimsRepo.hasClaim.mockResolvedValue(false);

      await expect(
        mocks.service.activateStarterSilently(reinstalledPro() as any),
      ).resolves.toBe('resumed_paid_through');
      expect(mocks.freePlanClaimsRepo.createIfNew).not.toHaveBeenCalled();
    });

    it('leaves a store planless once the paid-through date has passed', async () => {
      const mocks = createMocks();
      mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);
      jest.setSystemTime(new Date('2026-11-30T08:31:00.000Z'));

      await expect(
        mocks.service.activateStarterSilently(reinstalledPro() as any),
      ).resolves.toBe('already_claimed');
      expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
      expect(mocks.capacityRecovery.request).not.toHaveBeenCalled();
    });

    it('does nothing for a store without a paid-through date (same as today)', async () => {
      const mocks = createMocks();
      mocks.freePlanClaimsRepo.createIfNew.mockResolvedValue(false);

      await expect(
        mocks.service.activateStarterSilently(
          reinstalledPro({ paidThroughAt: null }) as any,
        ),
      ).resolves.toBe('already_claimed');
      expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('a second setup during the period finds the plan already active and moves nothing', async () => {
      const mocks = createMocks();

      await expect(
        mocks.service.activateStarterSilently(inPaidThrough() as any),
      ).resolves.toBe('already_active');
      expect(mocks.integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('plans', () => {
    it('shows the resumed plan as current, with its paid-through date', async () => {
      const mocks = createMocks();
      const response = await mocks.service.getBillingPlans(
        inPaidThrough() as any,
      );
      expect(response.currentPlanId).toBe('pro');
      expect(response.paidThroughAt).toBe(PAID_THROUGH_AT);
    });

    it('shows no plan once the date has passed', async () => {
      const mocks = createMocks();
      jest.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
      const response = await mocks.service.getBillingPlans(
        inPaidThrough() as any,
      );
      expect(response.currentPlanId).toBeNull();
      expect(response.paidThroughAt).toBeNull();
    });
  });

  describe('subscribing during the paid-through period', () => {
    it('asks Shopify for trial days up to the paid-through date (same plan is not short-circuited)', async () => {
      const mocks = createMocks();

      await mocks.service.initiateBilling(inPaidThrough() as any, 'pro');

      // Nov 11 17:01 → Nov 30 08:30 is 18.65 days: 19 trial days.
      expect(
        mocks.storePlatform.createRecurringApplicationCharge,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          amount: 22.99,
          trialDays: 19,
          replaceImmediately: false,
        }),
      );
      expect(lastUpdate(mocks)).toEqual(
        expect.objectContaining({ pendingBillingPlanId: 'pro' }),
      );
    });

    it('treats a renew request as a subscription with trial days', async () => {
      const mocks = createMocks();

      await mocks.service.initiateBilling(inPaidThrough() as any, 'pro', '', {
        renew: true,
      });

      expect(
        mocks.storePlatform.createRecurringApplicationCharge,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trialDays: 19, replaceImmediately: false }),
      );
    });

    it('applies trial days to another plan too', async () => {
      const mocks = createMocks();

      await mocks.service.initiateBilling(inPaidThrough() as any, 'business');

      expect(
        mocks.storePlatform.createRecurringApplicationCharge,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 49.99, trialDays: 19 }),
      );
    });

    it('sends no trial days for a store outside a paid-through period', async () => {
      const mocks = createMocks();

      await mocks.service.initiateBilling(
        reinstalledPro({ paidThroughAt: null }) as any,
        'pro',
      );

      const payload =
        mocks.storePlatform.createRecurringApplicationCharge.mock.calls[0][1];
      expect(payload).not.toHaveProperty('trialDays');
    });

    it('same plan: keeps the period and counters and cancels nothing on approval', async () => {
      const mocks = createMocks();
      const store = inPaidThrough({ pendingBillingPlanId: 'pro' });
      mocks.integrationsRepo.findByPlatformDomain.mockResolvedValue(store);
      mocks.storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'ACTIVE',
        trialDays: 19,
      });

      await mocks.service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'NEW',
      });

      expect(mocks.storePlatform.cancelAppSubscription).not.toHaveBeenCalled();
      expect(
        mocks.monthlyUsageRepo.resetCountersForPeriod,
      ).not.toHaveBeenCalled();
      const update = mocks.integrationsRepo.updateById.mock.calls[0][1];
      expect(update).toMatchObject({
        billingPlanId: 'pro',
        billingStatus: 'active',
        shopifySubscriptionId: 'gid://shopify/AppSubscription/NEW',
        paidThroughAt: null,
      });
      expect(update).not.toHaveProperty('billingActivatedAt');
      expect(mocks.adminLifecycles.recordEvent).toHaveBeenCalledWith(
        'int-1',
        'plan_renewed',
        { planId: 'pro' },
      );
      expect(mocks.capacityRecovery.request).toHaveBeenCalledWith(
        'org-1',
        'plan_activated',
      );
    });

    it('other plan: new allowance, period anchored at Shopify’s first charge', async () => {
      const mocks = createMocks();
      const store = inPaidThrough({ pendingBillingPlanId: 'business' });
      mocks.integrationsRepo.findByPlatformDomain.mockResolvedValue(store);
      mocks.storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'ACTIVE',
        trialDays: 19,
      });

      await mocks.service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'NEW',
      });

      expect(mocks.storePlatform.cancelAppSubscription).not.toHaveBeenCalled();
      const update = mocks.integrationsRepo.updateById.mock.calls[0][1];
      expect(update).toMatchObject({
        billingPlanId: 'business',
        billingStatus: 'active',
        billingActivatedAt: '2026-11-30T17:01:00.000Z',
        paidThroughAt: null,
      });
      expect(
        mocks.monthlyUsageRepo.resetCountersForPeriod,
      ).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart: '2026-11-30',
        includedLimit: 2500,
      });
    });

    it('an ordinary upgrade (no paid-through) still starts now with a fresh period', async () => {
      const mocks = createMocks();
      const store = reinstalledPro({
        billingStatus: 'active',
        shopifySubscriptionId: 'gid://shopify/AppSubscription/OLD',
        paidThroughAt: null,
        pendingBillingPlanId: 'business',
      });
      mocks.integrationsRepo.findByPlatformDomain.mockResolvedValue(store);
      mocks.storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'ACTIVE',
        trialDays: 0,
      });

      await mocks.service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'NEW',
      });

      expect(mocks.storePlatform.cancelAppSubscription).toHaveBeenCalled();
      const update = mocks.integrationsRepo.updateById.mock.calls[0][1];
      expect(update.billingActivatedAt).toBe(REINSTALL_AT.toISOString());
      expect(update).not.toHaveProperty('paidThroughAt');
      expect(
        mocks.monthlyUsageRepo.resetCountersForPeriod,
      ).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart: '2026-11-11',
        includedLimit: 2500,
      });
    });

    it('a declined approval keeps the paid-through plan', async () => {
      const mocks = createMocks();
      mocks.integrationsRepo.findByPlatformDomain.mockResolvedValue(
        inPaidThrough({ pendingBillingPlanId: 'pro' }),
      );
      mocks.storePlatform.getAppSubscriptionStatus.mockResolvedValue({
        id: 'gid://shopify/AppSubscription/NEW',
        status: 'DECLINED',
      });

      await mocks.service.handleBillingCallback({
        shop: 'test.myshopify.com',
        chargeId: 'NEW',
      });

      const update = mocks.integrationsRepo.updateById.mock.calls[0][1];
      expect(update).toEqual({ pendingBillingPlanId: null });
    });
  });
});
