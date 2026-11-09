import { EasyOrdersCurrentOrderSource } from './easyorders-current-order.source';
import { EASYORDERS_UNVERIFIED_MARKER } from './easyorders-ingestion.policy';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const request = {
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: 'eo-1',
  connection: {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'easyorders',
    platformStoreUrl: 'store',
    accessToken: null,
    isActive: true,
    metadata: {},
  },
  stored: { customerPhone: '+201000000001', totalPrice: '1', currency: 'EGP' },
};

function setup(
  normalize: () => Promise<unknown>,
  connection: unknown = {
    storeId: 'store-1',
    apiKeyEncrypted: 'encrypted',
  },
) {
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(connection),
  };
  const normalizer = { normalizeOrder: jest.fn(normalize) };
  return {
    source: new EasyOrdersCurrentOrderSource(
      connections as any,
      normalizer as any,
    ),
    normalizer,
  };
}

describe('EasyOrdersCurrentOrderSource', () => {
  it('makes the normalizer read the order back from EasyOrders', async () => {
    const { source, normalizer } = setup(() =>
      Promise.resolve({
        externalOrderId: 'eo-1',
        customerPhone: '+201000000003',
        totalPrice: '320.00',
        currency: 'EGP',
        shippingRegion: 'Alexandria',
      }),
    );
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'found',
      order: {
        customerPhone: '+201000000003',
        totalPrice: '320.00',
        currency: 'EGP',
        shippingRegion: 'Alexandria',
      },
    });
    expect(normalizer.normalizeOrder).toHaveBeenCalledWith(
      {
        id: 'eo-1',
        store_id: 'store-1',
        [EASYORDERS_UNVERIFIED_MARKER]: true,
      },
      'int-1',
      'org-1',
    );
  });

  it.each([
    ['order_not_found', 'order_not_found'],
    ['source_credentials_rejected', 'order_source_unavailable'],
    ['store_mismatch', 'order_source_unavailable'],
    ['invalid_phone', 'order_not_eligible'],
  ])('maps a %s skip to %s', async (reason, code) => {
    const { source } = setup(() => Promise.resolve({ skipped: true, reason }));
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code,
    });
  });

  it('treats a rate limit or outage as retryable, never throwing', async () => {
    const { source } = setup(() => Promise.reject(new Error('rate limited')));
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code: 'order_source_unavailable',
    });
  });

  it('does not read without a stored key', async () => {
    const { source, normalizer } = setup(() => Promise.resolve(null), {
      storeId: 'store-1',
      apiKeyEncrypted: null,
    });
    await expect(source.readCurrentOrder(request)).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(normalizer.normalizeOrder).not.toHaveBeenCalled();
  });
});
