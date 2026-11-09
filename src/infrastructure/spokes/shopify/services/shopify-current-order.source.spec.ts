import { PhoneService } from '../../../../shared/services/phone.service';
import {
  ShopifyCurrentOrderSource,
  toShopifyWebhookShape,
} from './shopify-current-order.source';
import { ShopifyOrderNormalizer } from './shopify-order.normalizer';
import type { ShopifyCurrentOrder } from './shopify-api.service.helpers';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */

const connection = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'shopify',
  platformStoreUrl: 'shop.myshopify.com',
  accessToken: 'token',
  isActive: true,
  metadata: {},
};

const request = {
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: '5551',
  connection,
  stored: {
    customerPhone: '+201000000001',
    totalPrice: '500.00',
    currency: 'EGP',
  },
};

/** An order after the merchant edited it: a new line, one removed, new address. */
const edited: ShopifyCurrentOrder = {
  legacyResourceId: '5551',
  phone: null,
  paymentGatewayNames: ['Cash on Delivery (COD)'],
  currentTotalPriceSet: {
    shopMoney: { amount: '750.00', currencyCode: 'EGP' },
  },
  customer: {
    firstName: 'Mona',
    lastName: 'Ali',
    phone: '+201000000001',
    defaultAddress: { phone: null, countryCodeV2: 'EG' },
  },
  billingAddress: null,
  shippingAddress: {
    phone: null,
    countryCodeV2: 'EG',
    address1: '9 New Street',
    address2: 'Floor 2',
    city: 'Dokki',
    province: 'Giza',
  },
  lineItems: {
    nodes: [
      {
        title: 'Mug',
        variantTitle: 'Blue',
        currentQuantity: 2,
        originalUnitPriceSet: { shopMoney: { amount: '250.00' } },
      },
      {
        title: 'Removed by an edit',
        variantTitle: null,
        currentQuantity: 0,
        originalUnitPriceSet: { shopMoney: { amount: '100.00' } },
      },
      {
        title: 'Plate',
        variantTitle: 'Default Title',
        currentQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '250.00' } },
      },
    ],
  },
};

function setup(read: () => Promise<ShopifyCurrentOrder | null>) {
  const api = { getCurrentOrder: jest.fn(read) };
  const source = new ShopifyCurrentOrderSource(
    api as any,
    new ShopifyOrderNormalizer(new PhoneService()),
  );
  return { source, api };
}

describe('ShopifyCurrentOrderSource', () => {
  it('reads the edited order and keeps only its current lines, total and address', async () => {
    const { source, api } = setup(() => Promise.resolve(edited));
    const result = await source.readCurrentOrder(request);
    expect(api.getCurrentOrder).toHaveBeenCalledWith(connection, '5551');
    expect(result).toEqual({
      status: 'found',
      order: expect.objectContaining({
        customerPhone: '+201000000001',
        customerName: 'Mona Ali',
        totalPrice: '750.00',
        currency: 'EGP',
        shippingRegion: 'Giza',
        shippingAddress: '9 New Street, Floor 2',
      }),
    });
    const lines =
      result.status === 'found' ? (result.order.lineItems ?? []) : [];
    expect(lines.map((line) => [line.name, line.quantity])).toEqual([
      ['Mug', 2],
      ['Plate', 1],
    ]);
  });

  it('answers not found for an order Shopify no longer has', async () => {
    const { source } = setup(() => Promise.resolve(null));
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code: 'order_not_found',
    });
  });

  it('answers unavailable, never throws, when Shopify cannot be read', async () => {
    const { source } = setup(() => Promise.reject(new Error('502')));
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code: 'order_source_unavailable',
    });
  });

  it('does not read through an inactive connection', async () => {
    const { source, api } = setup(() => Promise.resolve(edited));
    await expect(
      source.readCurrentOrder({
        ...request,
        connection: { ...connection, isActive: false },
      }),
    ).resolves.toMatchObject({ status: 'unavailable' });
    expect(api.getCurrentOrder).not.toHaveBeenCalled();
  });

  it('refuses an order the ingestion rules would not take (no usable phone)', async () => {
    const { source } = setup(() =>
      Promise.resolve({ ...edited, customer: null, shippingAddress: null }),
    );
    await expect(source.readCurrentOrder(request)).resolves.toEqual({
      status: 'unavailable',
      code: 'order_not_eligible',
    });
  });

  it('restates the order in the webhook fields the normalizer reads', () => {
    expect(toShopifyWebhookShape('5551', edited)).toMatchObject({
      id: '5551',
      total_price: '750.00',
      currency: 'EGP',
      payment_gateway_names: ['Cash on Delivery (COD)'],
      customer: { first_name: 'Mona', phone: '+201000000001' },
      shipping_address: { province: 'Giza', country_code: 'EG' },
    });
  });
});
