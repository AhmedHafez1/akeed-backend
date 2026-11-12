import { EasyOrdersOrderNormalizer } from './easyorders/easyorders-order.normalizer';
import { ShopifyOrderNormalizer } from './shopify/services/shopify-order.normalizer';
import { WooCommerceOrderNormalizer } from './woocommerce/woocommerce-order.normalizer';
import { StandaloneManualOrderNormalizer } from '../../modules/webhook-queue/normalizers/standalone-manual-order.normalizer';

/**
 * Admin order intake reads only the store's order id and payment-method name
 * from a payload, without loading anything, so it works for any skip.
 */
describe('describeIntake', () => {
  it('reads a Shopify order id and gateway names', () => {
    const normalizer = new ShopifyOrderNormalizer({} as never);
    expect(
      normalizer.describeIntake({
        id: 6123456789,
        payment_gateway_names: ['manual'],
        phone: '+201000000000',
        customer: { first_name: 'Kept', last_name: 'Out' },
      }),
    ).toEqual({ externalOrderId: '6123456789', paymentMethod: 'manual' });
    expect(
      normalizer.describeIntake({ id: 7, gateway: 'Cash on Delivery (COD)' }),
    ).toEqual({
      externalOrderId: '7',
      paymentMethod: 'Cash on Delivery (COD)',
    });
  });

  it('reads an EasyOrders order id and payment method', () => {
    const normalizer = new EasyOrdersOrderNormalizer(
      ...([{}, {}, {}, {}, {}] as never as ConstructorParameters<
        typeof EasyOrdersOrderNormalizer
      >),
    );
    expect(
      normalizer.describeIntake({ id: 'eo-1', payment_method: 'cod' }),
    ).toEqual({ externalOrderId: 'eo-1', paymentMethod: 'cod' });
    expect(normalizer.describeIntake({})).toEqual({
      externalOrderId: null,
      paymentMethod: '',
    });
  });

  it('reads a stored WooCommerce order id and payment method', () => {
    const normalizer = new WooCommerceOrderNormalizer({} as never, {} as never);
    expect(
      normalizer.describeIntake({
        order: { id: 42, payment_method: 'bacs', billing: { phone: 'x' } },
      }),
    ).toEqual({ externalOrderId: '42', paymentMethod: 'bacs' });
    expect(normalizer.describeIntake({ junk: true })).toEqual({
      externalOrderId: null,
      paymentMethod: '',
    });
  });

  it('reads a Standalone order id and payment method', () => {
    const normalizer = new StandaloneManualOrderNormalizer();
    expect(
      normalizer.describeIntake({
        order: { externalOrderId: 'S-1', paymentMethod: 'Cash' },
      }),
    ).toEqual({ externalOrderId: 'S-1', paymentMethod: 'Cash' });
    expect(normalizer.describeIntake({})).toEqual({
      externalOrderId: null,
      paymentMethod: null,
    });
  });
});
