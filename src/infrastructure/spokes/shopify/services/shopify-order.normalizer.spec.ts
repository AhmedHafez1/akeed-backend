import { ShopifyOrderNormalizer } from './shopify-order.normalizer';
import { PhoneService } from '../../../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../../../shared/errors/invalid-phone-number.error';
import { ShopifyOrderEligibilityStrategy } from './shopify-order-eligibility.strategy';
import {
  shopifyOrderFixture,
  shopifyPaymentFixtures,
} from './fixtures/shopify-order.fixture';

describe('ShopifyOrderNormalizer compatibility', () => {
  const normalizer = new ShopifyOrderNormalizer(new PhoneService());
  const normalize = (overrides: Record<string, unknown> = {}) =>
    normalizer.normalizeOrder(
      shopifyOrderFixture(overrides),
      'trusted-integration',
      'trusted-org',
    );

  it('preserves display fields, decimal text and resolved identity', () => {
    const raw = shopifyOrderFixture({
      orgId: 'forged-org',
      integrationId: 'forged-integration',
    });
    expect(
      normalizer.normalizeOrder(raw, 'trusted-integration', 'trusted-org'),
    ).toEqual({
      orgId: 'trusted-org',
      integrationId: 'trusted-integration',
      externalOrderId: '12345',
      orderNumber: '1001',
      customerPhone: '+201001234567',
      customerName: 'Synthetic Customer',
      totalPrice: '123.40',
      currency: 'EGP',
      paymentMethod: 'Cash on Delivery (COD)',
      paymentSignals: ['cash on delivery (cod)'],
      codStatus: 'cod',
      rawPayload: raw,
    });
  });

  it('reads the order lines, the governorate and the street for a detailed message', () => {
    expect(
      normalize({
        line_items: [
          {
            title: 'Lunch box',
            name: 'Lunch box - Blue',
            variant_title: 'Blue',
            quantity: 2,
            price: '180.00',
          },
          {
            title: 'Bottle',
            variant_title: 'Default Title',
            quantity: 1,
            price: '40.00',
          },
          null,
        ],
        shipping_address: {
          address1: ' 12 Nile Street ',
          address2: 'Floor 3',
          city: 'Maadi',
          province: 'Cairo',
        },
      }),
    ).toMatchObject({
      lineItems: [
        {
          name: 'Lunch box',
          quantity: 2,
          unitPrice: '180.00',
          options: [{ value: 'Blue' }],
        },
        { name: 'Bottle', quantity: 1, unitPrice: '40.00', options: [] },
      ],
      shippingRegion: 'Cairo',
      shippingAddress: '12 Nile Street, Floor 3',
    });
  });

  it('uses the city when the address has no governorate', () => {
    expect(
      normalize({
        shipping_address: {
          address1: '5 King Road',
          city: 'Riyadh',
          province: null,
        },
      }),
    ).toMatchObject({
      shippingRegion: 'Riyadh',
      shippingAddress: '5 King Road',
    });
  });

  it('leaves the details out when Shopify delivers none', () => {
    const order = normalize({ shipping_address: { phone: '+201001234567' } });

    expect(order).not.toHaveProperty('lineItems');
    expect(order).not.toHaveProperty('shippingRegion');
    expect(order).not.toHaveProperty('shippingAddress');
  });

  it.each([
    [
      'top-level E.164',
      { phone: '+201001234567', customer: { phone: '+14155552671' } },
    ],
    ['top-level local and region', { phone: '01001234567', countryCode: 'eg' }],
    [
      'customer before address',
      {
        phone: undefined,
        customer: {
          phone: '01001234567',
          default_address: { country_code: 'EG', phone: '+14155552671' },
        },
      },
    ],
    [
      'default address before billing',
      {
        phone: undefined,
        customer: {
          default_address: { phone: '01001234567', country_code: 'EG' },
        },
        billing_address: { phone: '+14155552671' },
      },
    ],
    [
      'billing before shipping',
      {
        phone: undefined,
        billing_address: { phone: '01001234567', country_code: 'EG' },
        shipping_address: { phone: '+14155552671' },
      },
    ],
    [
      'shipping',
      {
        phone: undefined,
        shipping_address: { phone: '01001234567', country_code: 'EG' },
      },
    ],
  ])('normalizes %s with the real phone service', (_name, payload) => {
    expect(normalize(payload)?.customerPhone).toBe('+201001234567');
  });

  it('returns null when no phone exists', () => {
    expect(normalize({ phone: undefined })).toBeNull();
  });

  it.each(['not-a-number', '123', '   '])(
    'throws for selected invalid phone %p without trying a later candidate',
    (phone) => {
      expect(() =>
        normalize({ phone, customer: { phone: '+201001234567' } }),
      ).toThrow(InvalidPhoneNumberError);
    },
  );

  it.each([
    [undefined, 'Guest'],
    [{}, ''],
    [{ first_name: 'Synthetic' }, 'Synthetic'],
    [{ last_name: 'Customer' }, 'Customer'],
  ])('maps customer %p to %p', (customer, expected) => {
    expect(normalize({ customer })?.customerName).toBe(expected);
  });

  it.each([12345, '12345'])(
    'stringifies order identifiers %p',
    (identifier) => {
      expect(
        normalize({ id: identifier, order_number: identifier }),
      ).toMatchObject({ externalOrderId: '12345', orderNumber: '12345' });
    },
  );

  it('does not invent a reference from name or missing amounts', () => {
    expect(
      normalize({
        order_number: undefined,
        name: '#SHOP-42',
        total_price: undefined,
        currency: undefined,
      }),
    ).toMatchObject({ orderNumber: '', totalPrice: '', currency: '' });
  });

  it('trims gateway names and prefers the nonempty list over gateway', () => {
    const order = normalize({
      payment_gateway_names: [' ', ' cod ', ' manual '],
      gateway: 'prepaid',
    });
    expect(order?.paymentMethod).toBe('cod, manual');
    expect(order?.paymentSignals).toEqual([
      'cod, manual',
      'cod',
      'manual',
      'prepaid',
    ]);
    expect(order?.codStatus).toBe('cod');
  });

  it('normalizes transaction gateways into canonical payment evidence', () => {
    const order = normalize({
      payment_gateway_names: [],
      gateway: undefined,
      transactions: [{ gateway: ' Pay-On-Delivery ' }, { gateway: 'card' }],
    });
    expect(order?.paymentSignals).toEqual(['pay on delivery', 'card']);
    expect(order?.codStatus).toBe('cod');
  });

  it('distinguishes non-COD from missing payment evidence', () => {
    expect(normalize({ payment_gateway_names: ['card'] })?.codStatus).toBe(
      'non_cod',
    );
    expect(normalize({ payment_gateway_names: [] })?.codStatus).toBe('unknown');
  });

  it.each(shopifyPaymentFixtures)(
    'composes real normalization and eligibility: $name',
    ({ payload, eligible }) => {
      const order = normalize(payload);
      expect(order).not.toBeNull();
      expect(
        new ShopifyOrderEligibilityStrategy().evaluateOrderForVerification(
          order!,
        ).eligible,
      ).toBe(eligible);
    },
  );
});
