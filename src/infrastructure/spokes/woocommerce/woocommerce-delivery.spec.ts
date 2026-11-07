import { placedCodFixture } from '../../../../test/fixtures/woocommerce/load';
import { ORDER_LINE_ITEMS_MAX } from '../../../shared/interfaces/order.interface';
import {
  projectWooCommerceOrder,
  readStoredWooCommerceOrder,
  toStoredWooCommerceDelivery,
} from './woocommerce-delivery';

describe('projectWooCommerceOrder', () => {
  it('keeps the fields ingestion reads and nothing else', () => {
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
      shipping: {
        state: '',
        city: 'Cairo',
        address_1: 'Synthetic address 1',
        address_2: '',
      },
      line_items: [
        { name: 'Sample item 1', quantity: 2, price: '200', options: [] },
      ],
      meta_data: [],
    });
  });

  it('drops the customer data Akeed has no use for', () => {
    const order = placedCodFixture().payload;
    const stored = JSON.stringify(
      projectWooCommerceOrder({
        ...order,
        billing: { ...order.billing, address_1: 'Synthetic billing street' },
        shipping: {
          ...(order.shipping as Record<string, unknown>),
          first_name: 'Shipping first name',
          postcode: '11511',
          phone: '01099999999',
        },
        customer_ip_address: '203.0.113.9',
        customer_user_agent: 'Synthetic agent',
        payment_method_title: 'Synthetic payment title',
        transaction_id: 'txn_synthetic',
      }),
    );

    for (const dropped of [
      'test.customer@example.com',
      'Synthetic billing street',
      'Shipping first name',
      '11511',
      '01099999999',
      '203.0.113.9',
      'Synthetic agent',
      'Synthetic payment title',
      'txn_synthetic',
      'wc_order_SYNTHETIC0001',
      'SYNTHETIC-0001',
      '_links',
      'product_id',
      'subtotal',
      'taxes',
      '2001',
    ])
      expect(stored).not.toContain(dropped);
  });

  describe('product lines', () => {
    function linesOf(lineItems: unknown): unknown {
      return projectWooCommerceOrder({
        ...placedCodFixture().payload,
        line_items: lineItems,
      }).line_items;
    }

    it.each([
      ['a number', 125.5, '125.5'],
      ['a string', '125.50', '125.50'],
      ['zero', 0, '0'],
      ['zero as text', '0.00', '0.00'],
      ['missing', undefined, null],
      ['negative', -5, null],
      ['not a number', 'free', null],
      ['an object', { amount: 5 }, null],
    ])('keeps the unit price when it is %s', (_label, price, expected) => {
      expect(
        linesOf([{ name: 'Item', quantity: 1, price, total: '999.00' }]),
      ).toEqual([{ name: 'Item', quantity: 1, price: expected, options: [] }]);
    });

    it('keeps several quantities and readable options', () => {
      expect(
        linesOf([
          {
            name: 'Synthetic shirt',
            quantity: 3,
            price: '100',
            meta_data: [
              {
                id: 1,
                key: 'pa_colour',
                value: 'red',
                display_key: 'Colour',
                display_value: 'Red',
              },
              { id: 2, key: 'Size', value: 'XL' },
              { id: 3, key: 'pa_fit', value: 'slim', display_key: 'Fit' },
            ],
          },
        ]),
      ).toEqual([
        {
          name: 'Synthetic shirt',
          quantity: 3,
          price: '100',
          options: [
            { name: 'Colour', value: 'Red' },
            { name: 'Size', value: 'XL' },
            { name: 'Fit', value: 'slim' },
          ],
        },
      ]);
    });

    it('leaves out private, nested, markup and plugin meta', () => {
      const lines = linesOf([
        {
          name: 'Item',
          quantity: 1,
          price: 1,
          meta_data: [
            { key: '_reduced_stock', value: '1' },
            { key: '_plugin_secret', value: 'sk_synthetic_line' },
            { key: 'gift', value: { to: 'Synthetic friend' } },
            { key: 'addons', value: ['Synthetic addon'] },
            { key: 'flag', value: true },
            {
              key: 'engraving',
              value: { text: 'nested' },
              display_key: 'Engraving',
              display_value: '<p>Synthetic</p>',
            },
            {
              key: 'wrap',
              value: 'yes',
              display_key: 'Gift wrap',
              display_value: '<span class="x">Yes</span>',
            },
            { key: 'note', value: 'Fish &amp; chips' },
            { key: 'colour', value: 'Blue', display_value: ['Blue'] },
            'not-an-entry',
            { value: 'no key' },
          ],
        },
      ]);

      expect(lines).toEqual([
        {
          name: 'Item',
          quantity: 1,
          price: '1',
          options: [
            { name: 'Gift wrap', value: 'yes' },
            { name: 'colour', value: 'Blue' },
          ],
        },
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/sk_synthetic|Synthetic|<|_/);
    });

    it('keeps at most five options per line', () => {
      const [line] = linesOf([
        {
          name: 'Item',
          quantity: 1,
          price: 1,
          meta_data: Array.from({ length: 8 }, (_unused, index) => ({
            key: `option_${index}`,
            value: `Value ${index}`,
          })),
        },
      ]) as { options: unknown[] }[];

      expect(line.options).toHaveLength(5);
    });

    it(`keeps the first ${ORDER_LINE_ITEMS_MAX} lines`, () => {
      const lines = linesOf(
        Array.from({ length: 60 }, (_unused, index) => ({
          name: `Item ${index}`,
          quantity: 1,
          price: 1,
        })),
      ) as { name: string }[];

      expect(lines).toHaveLength(ORDER_LINE_ITEMS_MAX);
      expect(lines.at(-1)?.name).toBe(`Item ${ORDER_LINE_ITEMS_MAX - 1}`);
    });

    it('skips lines that cannot be shown without using up the bound', () => {
      const lines = linesOf([
        'not-a-line',
        null,
        { quantity: 2 },
        { name: '   ', quantity: 1 },
        ...Array.from({ length: ORDER_LINE_ITEMS_MAX }, (_unused, index) => ({
          name: `Item ${index}`,
        })),
      ]) as { name: string; quantity: number; price: null }[];

      expect(lines).toHaveLength(ORDER_LINE_ITEMS_MAX);
      expect(lines[0]).toEqual({
        name: 'Item 0',
        quantity: 1,
        price: null,
        options: [],
      });
    });

    it('bounds the name and fixes a quantity that is not a whole number', () => {
      const [line] = linesOf([
        { name: 'n'.repeat(400), quantity: 'many', price: '1' },
      ]) as { name: string; quantity: number }[];

      expect(line.name).toHaveLength(300);
      expect(line.quantity).toBe(1);
    });

    it.each([undefined, null, 'x', {}, 7])(
      'keeps no lines for %p',
      (lineItems) => {
        expect(linesOf(lineItems)).toEqual([]);
      },
    );
  });

  describe('shipping address', () => {
    it('keeps only the region and street lines, each bounded', () => {
      expect(
        projectWooCommerceOrder({
          ...placedCodFixture().payload,
          shipping: {
            state: 'EGGZ',
            city: 'Giza',
            address_1: '12 Synthetic Street',
            address_2: 'x'.repeat(256),
            postcode: '12511',
            country: 'EG',
            phone: '01099999999',
          },
        }).shipping,
      ).toEqual({
        state: 'EGGZ',
        city: 'Giza',
        address_1: '12 Synthetic Street',
      });
    });

    it.each([undefined, null, 'Cairo', ['Cairo']])(
      'keeps no address for %p',
      (shipping) => {
        expect(
          projectWooCommerceOrder({ ...placedCodFixture().payload, shipping })
            .shipping,
        ).toEqual({});
      },
    );
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
    ).toEqual({
      id: null,
      billing: {},
      shipping: {},
      line_items: [],
      meta_data: [],
    });
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
