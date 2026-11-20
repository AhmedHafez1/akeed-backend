import { isBillingStatusActive } from '../../../../shared/utils/billing.util';
import { ShopifyBillingWebhookService } from '../services/shopify-billing-webhook.service';
import { ShopifySubscriptionSyncService } from './shopify-subscription-sync.service';
import { isShopifySubscriptionSyncEnabled } from './shopify-subscription-sync.constants';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

const SUB = 'gid://shopify/AppSubscription/CURRENT';
const PAYMENT_REQUIRED = Object.assign(new Error('Payment Required'), {
  isAxiosError: true,
  response: { status: 402 },
});

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'pro',
    shopifySubscriptionId: SUB,
    billingActivatedAt: '2026-01-01T00:00:00Z',
    billingCanceledAt: null,
    billingStatusUpdatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(stores: Array<Record<string, unknown>>) {
  const integrationsRepo = {
    findActiveShopifySubscriptions: jest.fn().mockResolvedValue(stores),
    findByPlatformDomain: jest.fn(
      (domain: string) =>
        stores.find((store) => store.platformStoreUrl === domain) ?? undefined,
    ),
    reconcileShopifySubscriptionStatus: jest.fn().mockResolvedValue(true),
  };
  const billing = {
    getAppSubscriptionStatus: jest.fn(),
    listActiveAppSubscriptions: jest.fn().mockResolvedValue([]),
  };
  const capacityRecovery = { request: jest.fn() };
  // The real webhook rules, so the reconciliation is tested against them.
  const webhookService = new ShopifyBillingWebhookService(
    integrationsRepo as any,
    { insertIfNew: jest.fn() } as any,
    { closeOpenForUninstalledStore: jest.fn() } as any,
    { stopPendingForIntegration: jest.fn() } as any,
    capacityRecovery as any,
  );
  const service = new ShopifySubscriptionSyncService(
    integrationsRepo as any,
    billing as any,
    webhookService,
  );
  return { service, integrationsRepo, billing, capacityRecovery };
}

describe('ShopifySubscriptionSyncService', () => {
  it('blocks a store whose subscription Shopify reports as cancelled', async () => {
    const { service, integrationsRepo, billing, capacityRecovery } = setup([
      makeStore(),
    ]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });

    const summary = await service.reconcileAll();

    expect(billing.getAppSubscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
      SUB,
    );
    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
      SUB,
      expect.objectContaining({
        billingStatus: 'cancelled',
        billingCanceledAt: expect.any(String),
      }),
    );
    const [, , update] =
      integrationsRepo.reconcileShopifySubscriptionStatus.mock.calls[0];
    expect(update).not.toHaveProperty('isActive');
    expect(capacityRecovery.request).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checked: 1, corrected: 1, failed: 0 });
  });

  it('holds a store that Shopify bills through a newer subscription', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });
    billing.listActiveAppSubscriptions.mockResolvedValue([
      { id: 'gid://shopify/AppSubscription/NEWER', status: 'ACTIVE' },
    ]);

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checked: 1, corrected: 0, held: 1 });
  });

  it('leaves a store untouched when its active subscriptions cannot be read', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });
    billing.listActiveAppSubscriptions.mockRejectedValue(
      new Error('Shopify unavailable'),
    );

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ corrected: 0, failed: 1 });
  });

  it('pauses paid sends on a Shopify 402 and still checks other stores', async () => {
    const { service, integrationsRepo, billing, capacityRecovery } = setup([
      makeStore(),
      makeStore({
        id: 'int-2',
        orgId: 'org-2',
        platformStoreUrl: 'other.myshopify.com',
      }),
    ]);
    billing.getAppSubscriptionStatus
      .mockRejectedValueOnce(PAYMENT_REQUIRED)
      .mockResolvedValueOnce({ id: SUB, status: 'ACTIVE' });

    const summary = await service.reconcileAll();

    expect(billing.listActiveAppSubscriptions).not.toHaveBeenCalled();
    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledTimes(1);
    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledWith(expect.objectContaining({ id: 'int-1' }), SUB, {
      billingStatus: 'frozen',
      billingStatusUpdatedAt: expect.any(String),
      billingCanceledAt: expect.any(String),
    });
    const [, , update] =
      integrationsRepo.reconcileShopifySubscriptionStatus.mock.calls[0];
    expect(isBillingStatusActive(update.billingStatus)).toBe(false);
    expect(capacityRecovery.request).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      checked: 2,
      corrected: 1,
      unchanged: 1,
      failed: 0,
    });
  });

  it('handles a shop freeze detected during the replacement subscription lookup', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });
    billing.listActiveAppSubscriptions.mockRejectedValue(PAYMENT_REQUIRED);

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
      SUB,
      expect.objectContaining({ billingStatus: 'frozen' }),
    );
    expect(summary).toMatchObject({ corrected: 1, failed: 0 });
  });

  it.each(['frozen', 'cancelled'])(
    'preserves an existing %s denial when Shopify returns 402',
    async (billingStatus) => {
      const { service, integrationsRepo, billing } = setup([
        makeStore({ billingStatus }),
      ]);
      billing.getAppSubscriptionStatus.mockRejectedValue(PAYMENT_REQUIRED);

      const summary = await service.reconcileAll();

      expect(
        integrationsRepo.reconcileShopifySubscriptionStatus,
      ).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ unchanged: 1, corrected: 0, failed: 0 });
    },
  );

  it('ignores a shop freeze if billing changed during the lookup', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockRejectedValue(PAYMENT_REQUIRED);
    integrationsRepo.findByPlatformDomain.mockImplementation(() =>
      makeStore({ billingStatusUpdatedAt: '2026-01-02T00:00:00Z' }),
    );

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ ignored: 1, corrected: 0, failed: 0 });
  });

  it('ignores a freeze rejected by the conditional update', async () => {
    const { service, integrationsRepo, billing, capacityRecovery } = setup([
      makeStore(),
    ]);
    billing.getAppSubscriptionStatus.mockRejectedValue(PAYMENT_REQUIRED);
    integrationsRepo.reconcileShopifySubscriptionStatus.mockResolvedValue(
      false,
    );

    const summary = await service.reconcileAll();

    expect(capacityRecovery.request).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ ignored: 1, corrected: 0, failed: 0 });
  });

  it('restores a frozen store that Shopify reports as active again', async () => {
    const { service, integrationsRepo, billing, capacityRecovery } = setup([
      makeStore({ billingStatus: 'frozen' }),
    ]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'ACTIVE',
    });

    await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
      SUB,
      expect.objectContaining({
        billingStatus: 'active',
        billingCanceledAt: null,
      }),
    );
    expect(capacityRecovery.request).toHaveBeenCalledWith(
      'org-1',
      'subscription_active',
    );
  });

  it('writes nothing when Shopify agrees with the stored status', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'ACTIVE',
    });

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checked: 1, unchanged: 1 });
  });

  it('leaves a store untouched when Shopify cannot be reached and checks the rest', async () => {
    const { service, integrationsRepo, billing } = setup([
      makeStore(),
      makeStore({
        id: 'int-2',
        orgId: 'org-2',
        platformStoreUrl: 'other.myshopify.com',
      }),
    ]);
    billing.getAppSubscriptionStatus
      .mockRejectedValueOnce(new Error('Shopify request timed out'))
      .mockResolvedValueOnce({ id: SUB, status: 'EXPIRED' });

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledTimes(1);
    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-2' }),
      SUB,
      expect.objectContaining({ billingStatus: 'expired' }),
    );
    expect(summary).toMatchObject({ checked: 2, corrected: 1, failed: 1 });
  });

  it('ignores the result when the store adopted another subscription meanwhile', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });
    integrationsRepo.findByPlatformDomain.mockImplementation(() =>
      makeStore({ shopifySubscriptionId: 'gid://shopify/AppSubscription/NEW' }),
    );

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ corrected: 0, ignored: 1 });
  });

  it('ignores the result when the store was uninstalled meanwhile', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'CANCELLED',
    });
    integrationsRepo.findByPlatformDomain.mockImplementation(() =>
      makeStore({ isActive: false }),
    );

    await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
  });

  it('does not let a pending status stop the current plan', async () => {
    const { service, integrationsRepo, billing } = setup([makeStore()]);
    billing.getAppSubscriptionStatus.mockResolvedValue({
      id: SUB,
      status: 'PENDING',
    });

    const summary = await service.reconcileAll();

    expect(
      integrationsRepo.reconcileShopifySubscriptionStatus,
    ).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ ignored: 1 });
  });
});

describe('isShopifySubscriptionSyncEnabled', () => {
  it('is on unless explicitly switched off', () => {
    expect(isShopifySubscriptionSyncEnabled(undefined)).toBe(true);
    expect(isShopifySubscriptionSyncEnabled('true')).toBe(true);
    expect(isShopifySubscriptionSyncEnabled(' FALSE ')).toBe(false);
  });
});
