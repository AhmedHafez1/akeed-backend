import { ConflictException } from '@nestjs/common';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { STANDALONE_SOURCE_DEFAULTS } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OnboardingStateService } from './onboarding-state.service';
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
      expect(result.billing.messagesSentLast30Days).toBe(0);
    },
  );

  it('counts the last 30 days of accepted messages for the current source only', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T00:00:00.000Z'));
    const integration = makeIntegration({ id: 'int-7', orgId: 'org-7' });
    const onboardingState = {
      resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
      prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
      toState: jest.fn().mockReturnValue({ timezone: 'Asia/Riyadh' }),
    };
    const messageDispatches = {
      countAcceptedSince: jest.fn().mockResolvedValue(28),
    };
    const service = new OnboardingService(
      onboardingState as any,
      {
        getBillingPlans: jest
          .fn()
          .mockResolvedValue({ plans: [], isFreePlanClaimed: true }),
      } as any,
      {
        readEntitlement: jest.fn().mockResolvedValue({
          consumedCount: 27,
          includedLimit: 30,
          periodStart: '2026-05-01',
          periodEnd: null,
        }),
        evaluateAccess: jest.fn().mockReturnValue({ allowed: true }),
      } as any,
      { readStatus: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      messageDispatches as any,
    );

    const result = await service.getSettings({
      userId: 'user-7',
      orgId: 'org-7',
      role: 'viewer',
      source: 'shopify',
      shop: 'other.myshopify.com',
    });

    expect(result.billing.messagesSentLast30Days).toBe(28);
    expect(messageDispatches.countAcceptedSince).toHaveBeenCalledWith({
      orgId: 'org-7',
      integrationId: 'int-7',
      since: '2026-05-01T00:00:00.000Z',
    });
  });

  /**
   * Standalone onboarding v2: the "Your store" form saves settings on a source
   * created with the provisioning defaults, then /complete runs once the test
   * is confirmed or skipped (the frontend decides when to call it).
   */
  describe('completeStandaloneOnboarding (v2 flow)', () => {
    const owner = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner' as const,
      source: 'supabase' as const,
    };
    const yourStoreForm = {
      storeName: 'Nile Shop',
      defaultLanguage: 'auto' as const,
      isAutoVerifyEnabled: true,
      merchantWhatsappPhone: '+201001234567',
      shippingCurrency: 'EGP' as const,
      timezone: 'Africa/Cairo',
    };

    function setup(accountStatus: 'active' | 'suspended' = 'active') {
      let row: Record<string, unknown> = {
        id: 'int-1',
        orgId: 'org-1',
        platformType: 'standalone',
        platformStoreUrl: 'standalone:org-1',
        isActive: true,
        onboardingStatus: 'pending',
        storeName: null,
        defaultLanguage: 'auto',
        shippingCurrency: 'USD',
        timezone: 'Asia/Riyadh',
        shopTimezone: null,
        billingPlanId: null,
        billingStatus: null,
        ...STANDALONE_SOURCE_DEFAULTS,
      };
      const integrationsRepo = {
        findActiveByOrg: jest.fn(() => Promise.resolve([row])),
        updateById: jest.fn((_id: string, updates: Record<string, unknown>) => {
          row = { ...row, ...updates };
          return Promise.resolve(row);
        }),
      };
      const onboardingState = new OnboardingStateService(
        integrationsRepo as never,
        {} as never,
        undefined,
        undefined,
        {
          findById: jest.fn().mockResolvedValue({ name: 'Nile Shop' }),
        } as never,
      );
      const service = new OnboardingService(
        onboardingState,
        {} as never,
        {
          evaluateAccess: jest.fn().mockReturnValue({ allowed: true }),
        } as never,
        { readStatus: jest.fn().mockResolvedValue(accountStatus) } as never,
      );
      return { service, integrationsRepo, current: () => row };
    }

    it('completes after the your-store settings are saved', async () => {
      const { service, current } = setup();

      await service.updateSettings(owner, yourStoreForm);
      const { state } = await service.completeStandaloneOnboarding(owner);

      expect(current()).toMatchObject({
        onboardingStatus: 'completed',
        merchantWhatsappPhone: '+201001234567',
        shippingCurrency: 'EGP',
        timezone: 'Africa/Cairo',
      });
      expect(state).toMatchObject({
        isOnboardingComplete: true,
        storeName: 'Nile Shop',
        shippingCurrency: 'EGP',
        timezone: 'Africa/Cairo',
        followUpEnabled: true,
        followUpDelayMinutes: 120,
        escalationDelayMinutes: 360,
        sendDelayMinutes: 0,
        standaloneSetup: { canComplete: true, blockedReasons: [] },
      });
    });

    it('stays blocked for a suspended account', async () => {
      const { service, current } = setup('suspended');

      await service.updateSettings(owner, yourStoreForm);
      const error = await service
        .completeStandaloneOnboarding(owner)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'ONBOARDING_BLOCKED',
        blockedReasons: ['account_suspended'],
      });
      expect(current().onboardingStatus).toBe('pending');
    });
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
