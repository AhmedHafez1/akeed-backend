import { OnboardingStateService } from './onboarding-state.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { seededTemplateRegistry } from '../../shared/messaging/testing/seeded-template-registry';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const user: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'shopify',
  shop: 'test.myshopify.com',
};

const base = {
  storeName: 'Test Store',
  defaultLanguage: 'auto' as const,
  isAutoVerifyEnabled: true,
};

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    isActive: true,
    storeName: 'Test Store',
    defaultLanguage: 'auto',
    shippingCurrency: 'SAR',
    avgShippingCost: '5.00',
    isAutoVerifyEnabled: true,
    followUpEnabled: true,
    followUpDelayMinutes: 360,
    escalationEnabled: true,
    escalationDelayMinutes: 1800,
    autoCancelEnabled: false,
    autoCancelRestock: true,
    autoCancelNotifyCustomer: false,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Asia/Riyadh',
    sendDelayMinutes: 0,
    metadata: {},
    ...overrides,
  };
}

function setup(current: Record<string, unknown>) {
  const integrationsRepo = {
    findByOrgAndPlatformDomain: jest
      .fn()
      .mockResolvedValue(integration(current)),
    updateById: jest.fn((_id: string, updates: Record<string, unknown>) =>
      Promise.resolve(integration({ ...current, ...updates })),
    ),
  };
  const autoCancellations = {
    stopPendingForIntegration: jest.fn().mockResolvedValue(2),
  };
  const service = new OnboardingStateService(
    integrationsRepo as any,
    {} as any,
    seededTemplateRegistry(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    autoCancellations as any,
  );
  return { service, integrationsRepo, autoCancellations };
}

describe('OnboardingStateService automatic cancellation settings', () => {
  it('is off by default, with restock on and no customer notice', async () => {
    const { service } = setup({});
    const state = await service.updateSettings(user, base);
    expect(state).toMatchObject({
      autoCancelEnabled: false,
      autoCancelRestock: true,
      autoCancelNotifyCustomer: false,
    });
  });

  it('saves the switch and both store choices', async () => {
    const { service, integrationsRepo } = setup({});
    const state = await service.updateSettings(user, {
      ...base,
      autoCancelEnabled: true,
      autoCancelRestock: false,
      autoCancelNotifyCustomer: true,
      escalationDelayMinutes: 2880,
    });
    expect(integrationsRepo.updateById).toHaveBeenCalledWith(
      'int-1',
      expect.objectContaining({
        autoCancelEnabled: true,
        autoCancelRestock: false,
        autoCancelNotifyCustomer: true,
        escalationDelayMinutes: 2880,
      }),
    );
    expect(state.autoCancelEnabled).toBe(true);
  });

  it('refuses it without the no-reply escalation it runs on', async () => {
    const { service, integrationsRepo } = setup({});
    await expect(
      service.updateSettings(user, {
        ...base,
        autoCancelEnabled: true,
        escalationEnabled: false,
      }),
    ).rejects.toMatchObject({
      response: { code: 'SETTINGS_AUTO_CANCEL_REQUIRES_ESCALATION' },
    });
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('stops every pending cancellation when it is switched off', async () => {
    const { service, autoCancellations } = setup({ autoCancelEnabled: true });
    await service.updateSettings(user, { ...base, autoCancelEnabled: false });
    expect(autoCancellations.stopPendingForIntegration).toHaveBeenCalledWith(
      'org-1',
      'int-1',
      'feature_disabled',
      'user-1',
    );
  });

  it('stops nothing when it stays on or is switched on', async () => {
    const { service, autoCancellations } = setup({ autoCancelEnabled: true });
    await service.updateSettings(user, base);
    const off = setup({});
    await off.service.updateSettings(user, {
      ...base,
      autoCancelEnabled: true,
    });
    expect(autoCancellations.stopPendingForIntegration).not.toHaveBeenCalled();
    expect(
      off.autoCancellations.stopPendingForIntegration,
    ).not.toHaveBeenCalled();
  });
});
