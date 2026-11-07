import { VerificationsService } from './verifications.service';

function fixture() {
  const repo = {
    findByOrg: jest.fn().mockResolvedValue([]),
    countByOrg: jest.fn().mockResolvedValue(0),
    countByTab: jest.fn().mockResolvedValue({ all: 0 }),
    findHeldByOrg: jest.fn().mockResolvedValue([]),
    countHeldByOrg: jest.fn().mockResolvedValue(0),
    getCustomerHistoryByPhones: jest.fn().mockResolvedValue([]),
  };
  const service = new VerificationsService(
    repo as never,
    {} as never,
    { findByOrg: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    { supports: () => false } as never,
    {} as never,
  );
  return { repo, service };
}

const details = {
  lineItems: [
    {
      name: 'Cotton shirt',
      quantity: 2,
      unitPrice: '125.50',
      options: [{ name: 'Colour', value: 'Red' }, { value: 'XL' }],
    },
    { name: 'Gift', quantity: 1, unitPrice: null, options: [] },
    { name: 'Sample', quantity: 1, unitPrice: '0', options: [] },
  ],
  shippingRegion: 'Cairo',
  shippingAddress: '12 Nile Street\nFloor 3',
  rawPayload: { private: 'not returned' },
};
const row = {
  id: 'verification-1',
  orderId: 'order-1',
  status: 'confirmed',
  createdAt: new Date().toISOString(),
};

describe('Verification list order details', () => {
  it('maps stored details to the public snake_case contract', async () => {
    const { repo, service } = fixture();
    repo.findByOrg.mockResolvedValue([{ ...row, order: details }]);

    const result = await service.listByOrg('org-a', {});

    expect(result.data[0]).toMatchObject({
      line_items: [
        {
          name: 'Cotton shirt',
          quantity: 2,
          unit_price: '125.50',
          options: [{ name: 'Colour', value: 'Red' }, { value: 'XL' }],
        },
        { name: 'Gift', quantity: 1, unit_price: null, options: [] },
        { name: 'Sample', quantity: 1, unit_price: '0', options: [] },
      ],
      shipping_region: 'Cairo',
      shipping_address: '12 Nile Street\nFloor 3',
    });
    expect(result.data[0]).not.toHaveProperty('raw_payload');
    expect(JSON.stringify(result)).not.toContain('not returned');
    expect(JSON.stringify(result)).not.toContain('unitPrice');
  });

  it.each([
    null,
    {},
    { lineItems: null, shippingRegion: null, shippingAddress: null },
  ])(
    'returns explicit nulls when the order has no details: %j',
    async (order) => {
      const { repo, service } = fixture();
      repo.findByOrg.mockResolvedValue([{ ...row, order }]);

      const result = await service.listByOrg('org-a', {});

      expect(result.data[0]).toMatchObject({
        line_items: null,
        shipping_region: null,
        shipping_address: null,
      });
    },
  );

  it.each([
    details,
    { lineItems: null, shippingRegion: null, shippingAddress: null },
  ])(
    'preserves the same details contract for held orders: %j',
    async (orderDetails) => {
      const { repo, service } = fixture();
      repo.findHeldByOrg.mockResolvedValue([
        { ...row, ...orderDetails, stage: 'awaiting_start', orgId: 'org-a' },
      ]);

      const result = await service.listByOrg('org-a', {
        status: 'awaiting_start',
      });

      expect(result.data[0]).toMatchObject({
        status: 'awaiting_start',
        shipping_region: orderDetails.shippingRegion,
        shipping_address: orderDetails.shippingAddress,
        line_items:
          orderDetails.lineItems?.map(({ unitPrice, ...item }) => ({
            ...item,
            unit_price: unitPrice,
          })) ?? null,
      });
      expect(result.data[0]).not.toHaveProperty('raw_payload');
    },
  );
});
