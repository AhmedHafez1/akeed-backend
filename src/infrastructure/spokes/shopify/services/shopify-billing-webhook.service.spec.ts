import { ShopifyBillingWebhookService } from './shopify-billing-webhook.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

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
  };
  const webhookEventsRepo = {
    insertIfNew: jest.fn().mockResolvedValue({ id: 'wh-1' }),
  };

  const service = new ShopifyBillingWebhookService(
    integrationsRepo as any,
    webhookEventsRepo as any,
  );

  return { service, integrationsRepo, webhookEventsRepo };
}

describe('ShopifyBillingWebhookService', () => {
  describe('handleAppSubscriptionUpdate — current subscription', () => {
    it('updates billing status for the current subscription', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration();

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      await service.handleAppSubscriptionUpdate(
        {
          id: 'gid://shopify/AppSubscription/CURRENT',
          status: 'CANCELLED',
        },
        'test.myshopify.com',
        'webhook-1',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          billingStatus: 'cancelled',
          isActive: false,
        }),
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
          id: 'gid://shopify/AppSubscription/PENDING_UPGRADE',
          status: 'DECLINED',
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
          id: 'gid://shopify/AppSubscription/OTHER',
          status: 'CANCELLED',
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
          id: 'gid://shopify/AppSubscription/OTHER',
          status: 'FROZEN',
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
    it('allows active status for a different subscription (new subscription activated)', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      await service.handleAppSubscriptionUpdate(
        {
          id: 'gid://shopify/AppSubscription/NEW',
          status: 'ACTIVE',
        },
        'test.myshopify.com',
        'webhook-5',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          billingStatus: 'active',
          shopifySubscriptionId: 'gid://shopify/AppSubscription/NEW',
          isActive: true,
        }),
      );
    });
  });

  describe('handleAppSubscriptionUpdate — no current subscription ID', () => {
    it('updates normally when integration has no shopifySubscriptionId', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: null,
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      await service.handleAppSubscriptionUpdate(
        {
          id: 'gid://shopify/AppSubscription/NEW',
          status: 'DECLINED',
        },
        'test.myshopify.com',
        'webhook-6',
        'app_subscriptions/update',
      );

      expect(integrationsRepo.updateById).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({
          billingStatus: 'declined',
          isActive: false,
        }),
      );
    });
  });

  describe('handleAppSubscriptionUpdate — admin_graphql_api_id resolution', () => {
    it('uses admin_graphql_api_id when present for subscription comparison', async () => {
      const { service, integrationsRepo } = createMocks();
      const integration = makeIntegration({
        shopifySubscriptionId: 'gid://shopify/AppSubscription/CURRENT',
      });

      integrationsRepo.findByPlatformDomain.mockResolvedValue(integration);

      const result = await service.handleAppSubscriptionUpdate(
        {
          id: '12345',
          status: 'DECLINED',
          admin_graphql_api_id: 'gid://shopify/AppSubscription/OTHER',
        },
        'test.myshopify.com',
        'webhook-7',
        'app_subscriptions/update',
      );

      // Should skip because the resolved ID differs and status is blocked
      expect(result).toEqual({ received: true });
      expect(integrationsRepo.updateById).not.toHaveBeenCalled();
    });
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument */
