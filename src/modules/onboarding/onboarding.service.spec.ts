import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OnboardingService } from './onboarding.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    isActive: true,
    billingStatus: 'active',
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
  afterEach(() => jest.useRealTimers());

  it.each([
    ['2026-05-15T00:00:00.000Z', '2026-05-01', '2026-05-31'],
    ['2026-05-30T23:59:59.999Z', '2026-05-01', '2026-05-31'],
    ['2026-05-31T00:00:00.000Z', '2026-05-31', '2026-06-30'],
  ])(
    'returns consolidated settings data at %s',
    async (now, periodStart, periodEnd) => {
      jest.useFakeTimers().setSystemTime(new Date(now));
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
              amount: 9.99,
              currencyCode: 'USD',
              includedVerifications: 300,
            },
          ],
          isFreePlanClaimed: true,
        }),
      };
      const monthlyUsageRepo = {
        getEntitlementSource: jest.fn().mockResolvedValue(integration),
        getIntegrationUsageForPeriod: jest.fn().mockResolvedValue({
          consumedCount: 42,
          includedLimit: 300,
        }),
      };

      const service = new OnboardingService(
        onboardingState as any,
        billingService as any,
        new BillingEntitlementService(
          monthlyUsageRepo as never,
          usageAccountingFixture(),
        ),
        { readStatus: jest.fn().mockResolvedValue(null) } as never,
      );

      const result = await service.getSettings({
        userId: 'user-1',
        orgId: 'org-1',
        role: 'owner',
        source: 'shopify',
        shop: 'test.myshopify.com',
      });

      expect(result.state).toMatchObject({
        ...state,
        permissions: {
          canUpdateConfiguration: true,
          canCompleteOnboarding: false,
        },
        standaloneSetup: null,
      });
      expect(result.billing.plans).toHaveLength(1);
      expect(result.billing.isFreePlanClaimed).toBe(true);
      expect(result.billing.usage).toEqual({
        used: 42,
        limit: 300,
        periodStart,
        periodEnd,
      });
      expect(result.template.languages).toEqual(['ar', 'en']);
      expect(result.template.defaults).toEqual({
        ar: 'standard',
        en: 'friendly',
      });
      expect(result.template.selected).toEqual({
        ar: 'standard',
        en: 'friendly',
      });
      expect(
        result.template.variants.ar.map((variant) => variant.variant),
      ).toEqual(['standard', 'egyptian', 'gulf', 'short']);
      expect(
        result.template.variants.en.map((variant) => variant.variant),
      ).toEqual(['friendly', 'professional', 'direct', 'short']);
      expect(result.template.previews.en.confirmButton).toBe('Confirm Order');
      expect(
        monthlyUsageRepo.getIntegrationUsageForPeriod,
      ).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart,
      });
    },
  );
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
