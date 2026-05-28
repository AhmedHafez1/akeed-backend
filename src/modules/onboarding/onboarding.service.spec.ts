import { OnboardingService } from './onboarding.service';

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
    onboardingStatus: 'completed',
    billingPlanId: 'basic',
    billingActivatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('OnboardingService', () => {
  it('returns consolidated settings data', async () => {
    const integration = makeIntegration();
    const state = {
      integrationId: 'int-1',
      onboardingStatus: 'completed',
      isOnboardingComplete: true,
      storeName: 'Test Store',
      defaultLanguage: 'auto',
      isAutoVerifyEnabled: true,
      shippingCurrency: 'USD',
      avgShippingCost: 3,
      billingPlanId: 'basic',
      billingStatus: 'active',
      followUpEnabled: true,
      followUpDelayMinutes: 120,
      escalationEnabled: true,
      escalationDelayMinutes: 360,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Asia/Riyadh',
      sendDelayMinutes: 0,
    };

    const onboardingState = {
      resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
      prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
      toState: jest.fn().mockReturnValue(state),
    };
    const billingService = {
      getBillingPlans: jest.fn().mockResolvedValue({
        plans: [
          {
            id: 'basic',
            name: 'Akeed Basic',
            amount: 8.99,
            currencyCode: 'USD',
            includedVerifications: 300,
          },
        ],
        isFreePlanClaimed: true,
      }),
    };
    const monthlyUsageRepo = {
      getOrgUsageTotalsForPeriod: jest.fn().mockResolvedValue({
        consumedCount: 42,
        includedLimit: 300,
      }),
    };

    const service = new OnboardingService(
      onboardingState as any,
      billingService as any,
      monthlyUsageRepo as any,
    );

    const result = await service.getSettings({
      userId: 'user-1',
      orgId: 'org-1',
      source: 'shopify',
      shop: 'test.myshopify.com',
    });

    expect(result.state).toBe(state);
    expect(result.billing.plans).toHaveLength(1);
    expect(result.billing.isFreePlanClaimed).toBe(true);
    expect(result.billing.usage).toEqual({
      used: 42,
      limit: 300,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    expect(result.template.languages).toEqual(['ar', 'en']);
    expect(result.template.previews.en.confirmButton).toBe('Confirm Order');
    expect(monthlyUsageRepo.getOrgUsageTotalsForPeriod).toHaveBeenCalledWith({
      orgId: 'org-1',
      periodStart: '2026-05-01',
    });
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
