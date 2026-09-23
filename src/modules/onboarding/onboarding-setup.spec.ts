import { HttpException } from '@nestjs/common';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OnboardingService } from './onboarding.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'shopify',
  shop: 'test.myshopify.com',
};

const payload = {
  storeName: 'AAHI',
  defaultLanguage: 'auto' as const,
  isAutoVerifyEnabled: true,
  merchantWhatsappPhone: '+201148675077',
};

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    isActive: true,
    storeName: 'AAHI',
    defaultLanguage: 'auto',
    isAutoVerifyEnabled: true,
    onboardingStatus: 'pending',
    billingPlanId: null,
    billingStatus: null,
    merchantWhatsappPhone: '+201148675077',
    ...overrides,
  };
}

function setup(
  options: {
    integration?: Record<string, unknown>;
    starter?: string;
  } = {},
) {
  const integration = makeIntegration(options.integration);
  const onboardingState = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
    resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
    prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
    markOnboardingCompleted: jest.fn().mockResolvedValue(undefined),
    toState: jest.fn().mockReturnValue({
      isOnboardingComplete: true,
      onboardingStatus: 'completed',
    }),
  };
  const billingService = {
    activateStarterSilently: jest
      .fn()
      .mockResolvedValue(options.starter ?? 'activated'),
  };
  const lifecycles = {
    reachMilestone: jest.fn().mockResolvedValue(true),
    recordEvent: jest.fn(),
    findCurrent: jest.fn().mockResolvedValue({
      setupCompletedAt: '2026-09-23T08:00:00.000Z',
      testSentAt: null,
      testConfirmedAt: null,
      testSkippedAt: null,
      firstRealConfirmedAt: null,
    }),
  };
  const monthlyUsageRepo = {
    getEntitlementSource: jest.fn().mockResolvedValue(integration),
    getIntegrationUsageForPeriod: jest
      .fn()
      .mockResolvedValue({ consumedCount: 0, includedLimit: 30 }),
  };
  const service = new OnboardingService(
    onboardingState as never,
    billingService as never,
    new BillingEntitlementService(
      monthlyUsageRepo as never,
      usageAccountingFixture(),
    ),
    { readStatus: jest.fn().mockResolvedValue(null) } as never,
    lifecycles as never,
  );
  return { service, onboardingState, billingService, lifecycles };
}

describe('OnboardingService.completeSetup', () => {
  it('saves setup, activates Starter silently and takes the store live', async () => {
    const { service, onboardingState, billingService, lifecycles } = setup();

    const state = await service.completeSetup(owner, payload);

    expect(onboardingState.updateSettings).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        storeName: 'AAHI',
        merchantWhatsappPhone: '+201148675077',
      }),
    );
    expect(billingService.activateStarterSilently).toHaveBeenCalled();
    expect(onboardingState.markOnboardingCompleted).toHaveBeenCalledWith(
      'int-1',
    );
    expect(lifecycles.reachMilestone).toHaveBeenCalledWith(
      'int-1',
      'setupCompletedAt',
      'setup_completed',
      expect.objectContaining({
        props: { starter: 'activated', autoConfirm: true },
      }),
    );
    expect(state.activation.setupCompletedAt).toBe('2026-09-23T08:00:00.000Z');
  });

  it('still goes live when the free plan was already claimed, and asks for a plan', async () => {
    const { service, onboardingState, lifecycles } = setup({
      starter: 'already_claimed',
    });

    const state = await service.completeSetup(owner, payload);

    expect(onboardingState.markOnboardingCompleted).toHaveBeenCalled();
    expect(lifecycles.reachMilestone).toHaveBeenCalledWith(
      'int-1',
      'setupCompletedAt',
      'setup_completed',
      expect.objectContaining({
        props: expect.objectContaining({ starter: 'already_claimed' }),
      }),
    );
    expect(state.activation.needsPlan).toBe(true);
    expect(state.activation.isLive).toBe(false);
  });

  it('reports the store live once Starter is active', async () => {
    const { service } = setup({
      integration: {
        onboardingStatus: 'completed',
        billingPlanId: 'starter',
        billingStatus: 'active',
        billingActivatedAt: '2026-09-23T08:00:00.000Z',
      },
    });

    const state = await service.completeSetup(owner, payload);

    expect(state.activation).toMatchObject({ isLive: true, needsPlan: false });
    expect(state.usage).toEqual({ used: 0, limit: 30, remaining: 30 });
  });

  it('refuses setup without a WhatsApp number to test with', async () => {
    const { service, onboardingState } = setup({
      integration: { merchantWhatsappPhone: null },
    });

    const error = await service
      .completeSetup(owner, payload)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'ONBOARDING_INVALID_PHONE',
    });
    expect(onboardingState.markOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('keeps viewers read-only', async () => {
    const { service, onboardingState } = setup();

    await expect(
      service.completeSetup({ ...owner, role: 'viewer' }, payload),
    ).rejects.toBeInstanceOf(HttpException);
    expect(onboardingState.updateSettings).not.toHaveBeenCalled();
  });
});
