import { placedCodFixture } from '../../../../test/fixtures/woocommerce/load';
import {
  projectWooCommerceOrder,
  readStoredWooCommerceOrder,
  toStoredWooCommerceDelivery,
} from './woocommerce-delivery';

describe('projectWooCommerceOrder', () => {
  it('keeps the fields the contract record reads and nothing else', () => {
    expect(projectWooCommerceOrder(placedCodFixture().payload)).toEqual({
      id: 1001,
      number: '1001',
      status: 'processing',
      currency: 'EGP',
      date_created_gmt: '2026-01-01T10:00:00',
      date_modified_gmt: '2026-01-01T10:01:00',
      total: '450.00',
      payment_method: 'cod',
      billing: {
        first_name: 'Test',
        last_name: 'Customer',
        phone: '01000000000',
        country: 'EG',
      },
      meta_data: [],
    });
  });

  it('drops the customer data Akeed has no use for', () => {
    const stored = JSON.stringify(
      projectWooCommerceOrder({
        ...placedCodFixture().payload,
        customer_ip_address: '203.0.113.9',
        customer_user_agent: 'Synthetic agent',
      }),
    );

    for (const dropped of [
      'test.customer@example.com',
      'Synthetic address 1',
      '203.0.113.9',
      'Synthetic agent',
      'Sample item 1',
      'wc_order_SYNTHETIC0001',
      '_links',
      'shipping',
    ])
      expect(stored).not.toContain(dropped);
  });

  it('keeps Akeed’s own outcome marker and no other plugin’s meta', () => {
    const projected = projectWooCommerceOrder({
      ...placedCodFixture().payload,
      meta_data: [
        { id: 1, key: '_gateway_api_secret', value: 'sk_live_synthetic' },
        { id: 2, key: 'akeed_outcome', value: 'customer_confirmation:abc' },
        { id: 3, key: 'akeed_outcome', value: { nested: true } },
        { id: 4, key: 'akeed_outcome', value: 'x'.repeat(256) },
        'not-an-entry',
      ],
    });

    expect(projected.meta_data).toEqual([
      { key: 'akeed_outcome', value: 'customer_confirmation:abc' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('sk_live_synthetic');
  });

  it.each([
    ['text that is too long', { status: 's'.repeat(256) }, 'status'],
    ['a value that is not text', { total: 450 }, 'total'],
    ['an object where text belongs', { currency: { code: 'EGP' } }, 'currency'],
  ])('leaves out %s', (_label, overrides, field) => {
    expect(
      projectWooCommerceOrder({ ...placedCodFixture().payload, ...overrides }),
    ).not.toHaveProperty(field);
  });

  it('survives an order that is not shaped like one', () => {
    expect(
      projectWooCommerceOrder({ id: '1001', billing: 'x', meta_data: 'y' }),
    ).toEqual({ id: null, billing: {}, meta_data: [] });
  });
});

describe('toStoredWooCommerceDelivery', () => {
  const order = placedCodFixture().payload;

  it('keeps the topic and the delivery identifiers for audit', () => {
    expect(
      toStoredWooCommerceDelivery(
        {
          topic: 'order.created',
          webhookId: '9001',
          deliveryId: 'synthetic-delivery-0002',
        },
        order,
      ),
    ).toEqual({
      topic: 'order.created',
      webhookId: '9001',
      deliveryId: 'synthetic-delivery-0002',
      order: projectWooCommerceOrder(order),
    });
  });

  it.each([
    undefined,
    '',
    'has space',
    'x'.repeat(65),
    ['9001'],
    `a${String.fromCharCode(0)}b`,
  ])('drops the identifier %p', (value) => {
    expect(
      toStoredWooCommerceDelivery(
        { topic: 'order.updated', webhookId: value, deliveryId: value },
        order,
      ),
    ).toMatchObject({ webhookId: null, deliveryId: null });
  });
});

describe('readStoredWooCommerceOrder', () => {
  it('reads the order back out of a stored delivery', () => {
    const stored = toStoredWooCommerceDelivery(
      { topic: 'order.created' },
      placedCodFixture().payload,
    );

    expect(readStoredWooCommerceOrder({ ...stored })).toEqual(stored.order);
  });

  it.each([{}, { order: null }, { order: 'x' }, { order: [] }])(
    'answers null for %j',
    (rawPayload) => {
      expect(readStoredWooCommerceOrder(rawPayload)).toBeNull();
    },
  );
});
