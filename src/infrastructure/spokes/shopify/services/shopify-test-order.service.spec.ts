import { ShopifyTestOrderService } from './shopify-test-order.service';

describe('ShopifyTestOrderService', () => {
  const integration = {
    isActive: true,
    accessToken: 'encrypted-token',
    platformStoreUrl: 'test.myshopify.com',
  };

  function setup(found: unknown = integration) {
    const integrations = {
      findByPlatformDomain: jest.fn().mockResolvedValue(found),
    };
    const shopify = {
      createTestCodOrder: jest.fn().mockResolvedValue({
        id: 'gid://shopify/Order/1',
        name: '#1001',
        test: true,
        displayFinancialStatus: 'PENDING',
      }),
    };
    return {
      integrations,
      shopify,
      service: new ShopifyTestOrderService(
        integrations as never,
        shopify as never,
      ),
    };
  }

  it('uses the stored integration without exposing or decrypting its token', async () => {
    const { service, integrations, shopify } = setup();
    await expect(
      service.createCodOrder({
        store: ' Test.myshopify.com ',
        phone: '+201001234567',
      }),
    ).resolves.toMatchObject({ name: '#1001', test: true });

    expect(integrations.findByPlatformDomain).toHaveBeenCalledWith(
      'test.myshopify.com',
      'shopify',
    );
    expect(shopify.createTestCodOrder).toHaveBeenCalledWith(integration, {
      phone: '+201001234567',
      amount: '49.95',
      currencyCode: 'USD',
    });
  });

  it.each([
    [{ store: 'example.com', phone: '+201001234567' }, 'Invalid Shopify'],
    [{ store: 'test.myshopify.com', phone: '01001234567' }, 'E.164'],
    [
      { store: 'test.myshopify.com', phone: '+201001234567', amount: '-1' },
      'Amount',
    ],
  ])('rejects invalid input %#', async (input, message) => {
    await expect(setup().service.createCodOrder(input)).rejects.toThrow(
      message,
    );
  });

  it('rejects stores without an active installed integration', async () => {
    await expect(
      setup(null).service.createCodOrder({
        store: 'test.myshopify.com',
        phone: '+201001234567',
      }),
    ).rejects.toThrow('No active Shopify integration');
  });
});
