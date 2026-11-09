import { WooCommerceCurrentOrderSource } from './woocommerce-current-order.source';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

jest.mock('./woocommerce-credentials', () => ({
  readWooCommerceCredentials: jest.fn(() => ({
    consumerKey: 'ck',
    consumerSecret: 'cs',
  })),
}));

const request = {
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: '1001',
  connection: {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'woocommerce',
    platformStoreUrl: 'https://shop.example',
    accessToken: null,
    isActive: true,
    metadata: {},
  },
  stored: { customerPhone: '+201000000001', totalPrice: '1', currency: 'EGP' },
};

function setup(options: {
  connection?: unknown;
  read?: unknown;
  normalized?: unknown;
}) {
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(
      options.connection === undefined
        ? {
            storeUrl: 'https://shop.example',
            disconnectedAt: null,
          }
        : options.connection,
    ),
  };
  const api = {
    getOrderDetails: jest
      .fn()
      .mockResolvedValue(
        options.read ?? { kind: 'found', payload: { id: 1001 } },
      ),
  };
  const normalizer = {
    normalizeOrder: jest.fn().mockResolvedValue(
      options.normalized ?? {
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: '1001',
        customerPhone: '+201000000002',
        totalPrice: '900.00',
        currency: 'EGP',
        shippingAddress: 'New address',
        lineItems: [{ name: 'Lamp', quantity: 3 }],
      },
    ),
  };
  const config = { getOrThrow: jest.fn(() => 'key') };
  return {
    source: new WooCommerceCurrentOrderSource(
      connections as any,
      api as any,
      normalizer as any,
      config as any,
    ),
    api,
    normalizer,
  };
}

describe('WooCommerceCurrentOrderSource', () => {
  it('reads the order with the connection keys and normalizes it like a delivery', async () => {
    const { source, api, normalizer } = setup({});
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'found',
      order: {
        customerPhone: '+201000000002',
        totalPrice: '900.00',
        currency: 'EGP',
        shippingAddress: 'New address',
        lineItems: [{ name: 'Lamp', quantity: 3 }],
      },
    });
    expect(api.getOrderDetails).toHaveBeenCalledWith(
      'https://shop.example',
      { consumerKey: 'ck', consumerSecret: 'cs' },
      '1001',
    );
    expect(normalizer.normalizeOrder).toHaveBeenCalledWith(
      { order: { id: 1001 } },
      'int-1',
      'org-1',
    );
  });

  it.each([
    [{ connection: null }, 'order_source_unavailable'],
    [
      { connection: { disconnectedAt: '2026-11-01' } },
      'order_source_unavailable',
    ],
    [{ read: { kind: 'not_found' } }, 'order_not_found'],
    [{ read: { kind: 'unavailable' } }, 'order_source_unavailable'],
    [{ read: { kind: 'unverified' } }, 'order_source_unavailable'],
    [
      { normalized: { skipped: true, reason: 'invalid_phone' } },
      'order_not_eligible',
    ],
  ])('answers %j as %s', async (options, code) => {
    const { source } = setup(options);
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code,
    });
  });
});
