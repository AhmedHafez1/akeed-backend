import { ShopifyBillingAdapter } from './shopify-billing.adapter';

describe('ShopifyBillingAdapter', () => {
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'synthetic.myshopify.com',
    accessToken: 'synthetic',
    isActive: true,
    metadata: {},
  };
  const input = {
    name: 'Akeed Basic',
    amount: 9.99,
    currencyCode: 'USD',
    returnUrl: 'https://example.com/callback',
    test: true,
  };
  function setup() {
    const api = {
      createRecurringApplicationCharge: jest
        .fn()
        .mockResolvedValue('https://example.com/approve'),
      getAppSubscriptionStatus: jest
        .fn()
        .mockResolvedValue({ id: 'sub-1', status: 'ACTIVE' }),
      cancelAppSubscription: jest.fn(),
      reportUsageCharge: jest.fn(),
    };
    return { api, adapter: new ShopifyBillingAdapter(api as never) };
  }
  it('preserves provider inputs and responses', async () => {
    const { api, adapter } = setup();
    expect(await adapter.createRecurringApplicationCharge(source, input)).toBe(
      'https://example.com/approve',
    );
    expect(await adapter.getAppSubscriptionStatus(source, 'sub-1')).toEqual({
      id: 'sub-1',
      status: 'ACTIVE',
    });
    await adapter.cancelAppSubscription(source, 'sub-1', false);
    await adapter.reportUsageCharge(source, 'sub-1', 1, 'USD', 'usage');
    expect(api.createRecurringApplicationCharge).toHaveBeenCalledWith(
      source,
      input,
    );
    expect(api.cancelAppSubscription).toHaveBeenCalledWith(
      source,
      'sub-1',
      false,
    );
    expect(api.reportUsageCharge).toHaveBeenCalledWith(
      source,
      'sub-1',
      1,
      'USD',
      'usage',
    );
  });
  it('rejects manual connections before every Shopify operation', async () => {
    const { api, adapter } = setup();
    const manual = { ...source, platformType: 'standalone' };
    await expect(
      adapter.createRecurringApplicationCharge(manual, input),
    ).rejects.toThrow('unavailable');
    await expect(
      adapter.getAppSubscriptionStatus(manual, 'sub-1'),
    ).rejects.toThrow('unavailable');
    await expect(
      adapter.cancelAppSubscription(manual, 'sub-1'),
    ).rejects.toThrow('unavailable');
    await expect(
      adapter.reportUsageCharge(manual, 'sub-1', 1, 'USD', 'usage'),
    ).rejects.toThrow('unavailable');
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  });
});
