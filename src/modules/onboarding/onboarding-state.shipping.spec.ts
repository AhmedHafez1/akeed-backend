import { OnboardingStateService } from './onboarding-state.service';
import { OnboardingService } from './onboarding.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { seededTemplateRegistry } from '../../shared/messaging/testing/seeded-template-registry';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const owner: AuthenticatedUser = {
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
    followUpDelayMinutes: 120,
    escalationEnabled: true,
    escalationDelayMinutes: 840,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Asia/Riyadh',
    sendDelayMinutes: 0,
    shippingNotificationsEnabled: false,
    shippingFulfillmentTriggerEnabled: true,
    shippingTags: [],
    metadata: {},
    ...overrides,
  };
}

function setup(options: {
  switchOn: boolean;
  platformType?: string;
  current?: Record<string, unknown>;
}) {
  const current = {
    ...(options.platformType ? { platformType: options.platformType } : {}),
    ...options.current,
  };
  const integrationsRepo = {
    findByOrgAndPlatformDomain: jest
      .fn()
      .mockResolvedValue(integration(current)),
    findActiveByOrg: jest.fn().mockResolvedValue(integration(current)),
    updateById: jest.fn((_id: string, updates: Record<string, unknown>) =>
      Promise.resolve(integration({ ...current, ...updates })),
    ),
  };
  const shipping = {
    isAvailableFor: jest.fn(
      (platform: string) => options.switchOn && platform === 'shopify',
    ),
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
    undefined,
    undefined,
    shipping as any,
  );
  return { service, integrationsRepo };
}

describe('OnboardingStateService shipping notification settings', () => {
  it('hides the fields and refuses them with a code while unavailable', async () => {
    const { service, integrationsRepo } = setup({ switchOn: false });
    const state = await service.updateSettings(owner, base);
    expect(state).not.toHaveProperty('shippingNotificationsEnabled');
    expect(state).not.toHaveProperty('shippingTags');

    await expect(
      service.updateSettings(owner, {
        ...base,
        shippingNotificationsEnabled: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'SETTINGS_SHIPPING_NOTIFICATIONS_UNAVAILABLE' },
    });
    expect(integrationsRepo.updateById).toHaveBeenCalledTimes(1);
  });

  it('refuses a store whose platform has no shipping source', async () => {
    const { service } = setup({ switchOn: true, platformType: 'standalone' });
    await expect(
      service.updateSettings(owner, { ...base, shippingTags: ['شحن'] }),
    ).rejects.toMatchObject({
      response: { code: 'SETTINGS_SHIPPING_NOTIFICATIONS_UNAVAILABLE' },
    });
  });

  it('defaults to off with the fulfillment trigger on and no tags', async () => {
    const { service } = setup({ switchOn: true });
    const state = await service.updateSettings(owner, base);
    expect(state).toMatchObject({
      shippingNotificationsEnabled: false,
      shippingFulfillmentTriggerEnabled: true,
      shippingTags: [],
    });
  });

  it('saves the switch, the trigger and tidied tags', async () => {
    const { service, integrationsRepo } = setup({ switchOn: true });
    const state = await service.updateSettings(owner, {
      ...base,
      shippingNotificationsEnabled: true,
      shippingFulfillmentTriggerEnabled: false,
      shippingTags: [' Shipped ', 'SHIPPED', 'شحن', ' شحن'],
    });
    expect(integrationsRepo.updateById.mock.calls[0][1]).toMatchObject({
      shippingNotificationsEnabled: true,
      shippingFulfillmentTriggerEnabled: false,
      shippingTags: ['Shipped', 'شحن'],
    });
    expect(state.shippingTags).toEqual(['Shipped', 'شحن']);
  });

  it.each([
    [Array.from({ length: 11 }, (_, i) => `tag-${i}`), 'too_many'],
    [['   '], 'length'],
    [['x'.repeat(41)], 'length'],
    [['akeed: verified'], 'akeed_prefix'],
    [['Akeed:Shipped'], 'akeed_prefix'],
  ])('refuses %j with reason %s', async (tags, reason) => {
    const { service, integrationsRepo } = setup({ switchOn: true });
    await expect(
      service.updateSettings(owner, { ...base, shippingTags: tags }),
    ).rejects.toMatchObject({
      response: { code: 'SETTINGS_SHIPPING_TAGS_INVALID', reason },
    });
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it("saves only the store found for the caller's own org and shop", async () => {
    const { service, integrationsRepo } = setup({ switchOn: true });
    await service.updateSettings(owner, {
      ...base,
      shippingNotificationsEnabled: true,
      shippingTags: ['شحن'],
    });
    expect(integrationsRepo.findByOrgAndPlatformDomain).toHaveBeenCalledWith(
      'org-1',
      'test.myshopify.com',
      'shopify',
    );
    expect(integrationsRepo.updateById).toHaveBeenCalledTimes(1);
    expect(integrationsRepo.updateById.mock.calls[0][0]).toBe('int-1');
  });

  it("writes nothing when the shop is not the caller's", async () => {
    const { service, integrationsRepo } = setup({ switchOn: true });
    integrationsRepo.findByOrgAndPlatformDomain.mockResolvedValue(undefined);
    await expect(
      service.updateSettings(
        { ...owner, shop: 'other-store.myshopify.com' },
        { ...base, shippingNotificationsEnabled: true },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(integrationsRepo.updateById).not.toHaveBeenCalled();
  });

  it('keeps viewers read-only', async () => {
    const state = { updateSettings: jest.fn() };
    const onboarding = new OnboardingService(
      state as any,
      {} as any,
      {} as any,
      {} as any,
      seededTemplateRegistry(),
    );
    await expect(
      onboarding.updateSettings(
        { ...owner, role: 'viewer' },
        { ...base, shippingNotificationsEnabled: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});
