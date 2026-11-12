import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ShopifyAppSubscriptionWebhookDto } from '../dto/shopify-webhooks.dto';
import { ShopifyBillingWebhookService } from './shopify-billing-webhook.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'test.myshopify.com',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'starter',
    shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    billingCanceledAt: null,
    ...overrides,
  };
}

function createMocks() {
  const integrationsRepo = {
    findByPlatformDomain: jest.fn(),
    updateById: jest.fn(),
    deleteById: jest.fn(),
    markShopifyUninstalled: jest.fn(),
  };
  const webhookEventsRepo = {
    insertIfNew: jest.fn().mockResolvedValue({ id: 'wh-1' }),
  };
  const storeDataDeletion = {
    deleteStoreData: jest.fn().mockResolvedValue({
      orders: 2,
      verifications: 2,
      webhookEvents: 3,
      messageDispatches: 0,
      orderImportBatches: 0,
      metaWebhookEvents: 0,
      providerMessageReceipts: 0,
    }),
  };
  const capacityRecovery = { request: jest.fn() };
  const service = new ShopifyBillingWebhookService(
    integrationsRepo as any,
    webhookEventsRepo as any,
    storeDataDeletion as any,
    capacityRecovery as any,
  );

  return {
    service,
    integrationsRepo,
    webhookEventsRepo,
    storeDataDeletion,
    capacityRecovery,
  };
}

describe('ShopifyBillingWebhookService', () => {
  describe('handleAppUninstalled', () => {
    it('retains the integration while clearing credentials and closing the lifecycle', async () => {
      const { service, integrationsRepo } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );

      await service.handleAppUninstalled(
        { id: 123 } as any,
        'test.myshopify.com',
      );

      expect(integrationsRepo.markShopifyUninstalled).toHaveBeenCalledWith(
        'int-1',
        expect.any(String),
      );
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
      expect(integrationsRepo.deleteById).not.toHaveBeenCalled();
    });

    it('deletes the store data, unlinked webhook rows included, after marking it uninstalled', async () => {
      const { service, integrationsRepo, storeDataDeletion } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );

      await service.handleAppUninstalled(
        { id: 123 } as any,
        'test.myshopify.com',
      );

      expect(storeDataDeletion.deleteStoreData).toHaveBeenCalledWith(
        {
          orgId: 'org-1',
          integrationId: 'int-1',
          platform: 'shopify',
          storeDomain: 'test.myshopify.com',
        },
        { scope: 'store' },
      );
      expect(
        integrationsRepo.markShopifyUninstalled.mock.invocationCallOrder[0],
      ).toBeLessThan(
        storeDataDeletion.deleteStoreData.mock.invocationCallOrder[0],
      );
    });

    it('purges nothing when the shop has no integration', async () => {
      const { service, integrationsRepo, storeDataDeletion } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(undefined);

      await service.handleAppUninstalled(
        { id: 123 } as any,
        'unknown.myshopify.com',
      );

      expect(storeDataDeletion.deleteStoreData).not.toHaveBeenCalled();
    });

    it('propagates a purge failure so Shopify retries the webhook', async () => {
      const { service, integrationsRepo, storeDataDeletion } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );
      storeDataDeletion.deleteStoreData.mockRejectedValue(new Error('fk'));

      await expect(
        service.handleAppUninstalled({ id: 123 } as any, 'test.myshopify.com'),
      ).rejects.toThrow('fk');
    });
  });

  describe('handleAppSubscriptionUpdate — current subscription', () => {
    it('updates billing status for the current subscription', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration();

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/CURRENT',
            status: 'CANCELLED',
          },
        },
        'test.myshopify.com',
        'webhook-1',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          billingStatus: 'cancelled',
        }),
      );
      expect(integrationsRepo.updateById.mock.calls[0][1]).not.toHaveProperty(
        'isActive',
      );
    });
  });

  describe('handleAppSubscriptionUpdate — non-current subscription declined', () => {
    it('ignores declined status for a different subscription ID', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      const result = await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id:
              'gid://shopify/AppSubscription/PENDING_UPGRADE',
            status: 'DECLINED',
          },
        },
        'test.myshopify.com',
        'webhook-2',
        'app_subscriptions/update',
      );

      expect(result).toEqual({ received: true });
      // Should NOT have called updateById
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('ignores cancelled status for a different subscription ID', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      const result = await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/OTHER',
            status: 'CANCELLED',
          },
        },
        'test.myshopify.com',
        'webhook-3',
        'app_subscriptions/update',
      );

      expect(result).toEqual({ received: true });
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });

    it('ignores frozen status for a different subscription ID', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      const result = await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/OTHER',
            status: 'FROZEN',
          },
        },
        'test.myshopify.com',
        'webhook-4',
        'app_subscriptions/update',
      );

      expect(result).toEqual({ received: true });
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('handleAppSubscriptionUpdate — non-current subscription active', () => {
    it('leaves a new subscription for the billing callback to adopt', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/NEW',
            status: 'ACTIVE',
          },
        },
        'test.myshopify.com',
        'webhook-5',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('handleAppSubscriptionUpdate — no current subscription ID', () => {
    it.each(['DECLINED', 'PENDING', 'ACTIVE'])(
      'leaves a free store unchanged on %s',
      async (status) => {
        const { service, integrationsRepo } = createMocks();
        integrationsRepo.findByPlatformDomain.mockResolvedValue(
          makeIntegration({ shopifySubscriptionId: null }),
        );

        await service.handleAppSubscriptionUpdate(
          {
            app_subscription: {
              admin_graphql_api_id: 'gid://shopify/AppSubscription/NEW',
              status,
            },
          },
          'test.myshopify.com',
          'webhook-6',
          'app_subscriptions/update',
        );

        expect(integrationsRepo.updateById).not.toHaveBeenCalled();
      },
    );
  });

  describe('handleAppSubscriptionUpdate — activation date', () => {
    it('keeps the activation date and subscription on an active update', async () => {
      const { service, integrationsRepo } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );

      await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/CURRENT',
            status: 'ACTIVE',
          },
        },
        'test.myshopify.com',
        'webhook-anchor',
        'app_subscriptions/update',
      );

      const updates = integrationsRepo.updateById.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(updates.billingStatus).toBe('active');
      expect(updates).not.toHaveProperty('billingActivatedAt');
      expect(updates).not.toHaveProperty('shopifySubscriptionId');
    });

    it('does not let a pending status stop the current subscription', async () => {
      const { service, integrationsRepo } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );

      await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/CURRENT',
            status: 'PENDING',
          },
        },
        'test.myshopify.com',
        'webhook-pending',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('handleAppSubscriptionUpdate — uninstalled integration', () => {
    it('acknowledges without changing billing or installation state', async () => {
      const { service, integrationsRepo } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration({ isActive: false, billingStatus: 'cancelled' }),
      );

      const result = await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/CURRENT',
            status: 'ACTIVE',
          },
        },
        'test.myshopify.com',
        'webhook-uninstalled',
        'app_subscriptions/update',
      );

      expect(result).toEqual({ received: true });
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('ShopifyAppSubscriptionWebhookDto', () => {
    const validatePayload = (payload: unknown) =>
      validate(plainToInstance(ShopifyAppSubscriptionWebhookDto, payload), {
        whitelist: true,
      });

    it('accepts the payload Shopify documents for the topic', async () => {
      const errors = await validatePayload({
        app_subscription: {
          admin_graphql_api_id: 'gid://shopify/AppSubscription/1029266965',
          name: 'Webhook Test',
          status: 'PENDING',
          admin_graphql_api_shop_id: 'gid://shopify/Shop/548380009',
          created_at: '2021-12-31T19:00:00-05:00',
          updated_at: '2021-12-31T19:00:00-05:00',
          currency: 'USD',
          capped_amount: '20.0',
        },
      });

      expect(errors).toEqual([]);
    });

    it('rejects a payload without the subscription', async () => {
      expect(await validatePayload({ status: 'ACTIVE' })).not.toEqual([]);
    });
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */

describe('ShopifyBillingWebhookService capacity recovery', () => {
  it.each([
    ['ACTIVE', 1],
    ['CANCELLED', 0],
  ])(
    'resumes blocked orders only for an active subscription (%s)',
    async (status, calls) => {
      const { service, integrationsRepo, capacityRecovery } = createMocks();
      integrationsRepo.findByPlatformDomain.mockResolvedValue(
        makeIntegration(),
      );

      await service.handleAppSubscriptionUpdate(
        {
          app_subscription: {
            admin_graphql_api_id: 'gid://shopify/AppSubscription/CURRENT',
            status,
          },
        },
        'test.myshopify.com',
        'webhook-recovery',
        'app_subscriptions/update',
      );

      expect(capacityRecovery.request).toHaveBeenCalledTimes(calls);
      if (calls) {
        expect(capacityRecovery.request).toHaveBeenCalledWith(
          'org-1',
          'subscription_active',
        );
      }
    },
  );
});
