import type { OrderLineItem } from '../interfaces/order.interface';
import {
  ORDER_DETAIL_MAX_LENGTH,
  buildOrderDetailValues,
  canFillTemplate,
  formatItemList,
  lineTotal,
  sanitizeParameterValue,
} from './order-detail-values';
import type { TemplateVariable } from './template-registry.types';

const lunchBox = (colour: string): OrderLineItem => ({
  name: 'Double Layer Lunch Box (2 Litre)',
  quantity: 1,
  unitPrice: '180',
  options: [{ name: 'color', value: colour }],
});

const item = (name: string): OrderLineItem => ({
  name,
  quantity: 1,
  unitPrice: '10.00',
  options: [],
});

const DETAILED: TemplateVariable[] = [
  { key: 'customer', name: 'customer' },
  { key: 'order', name: 'order' },
  { key: 'items', name: 'items' },
  { key: 'total', name: 'total' },
  { key: 'region', name: 'region' },
  { key: 'address', name: 'address' },
];
const PLAIN: TemplateVariable[] = [
  { key: 'order', name: 'order' },
  { key: 'total', name: 'total' },
];

describe('sanitizeParameterValue', () => {
  it('puts a value on one line: no line break, no tab, no run of spaces', () => {
    expect(
      sanitizeParameterValue(
        '  حلوان\r\nالمشروع\tالامريكي      مجاورة 3 ',
        300,
      ),
    ).toBe('حلوان المشروع الامريكي مجاورة 3');
  });

  it('cuts a long value to the limit and marks the cut', () => {
    const value = sanitizeParameterValue('a'.repeat(400), 300);
    expect(value).toHaveLength(300);
    expect(value.endsWith('…')).toBe(true);
  });

  it('reads a missing value as empty', () => {
    expect(sanitizeParameterValue(null, 80)).toBe('');
    expect(sanitizeParameterValue(undefined, 80)).toBe('');
    expect(sanitizeParameterValue(' \n ', 80)).toBe('');
  });
});

describe('lineTotal', () => {
  it.each([
    ['180', 2, '360'],
    ['19.99', 3, '59.97'],
    ['0.05', 1, '0.05'],
    ['0.10', 3, '0.30'],
    ['99999999999999.99', 9, '899999999999999.91'],
  ])('multiplies %s by %d on the decimal text', (price, quantity, total) => {
    expect(lineTotal(price, quantity)).toBe(total);
  });

  it.each([
    ['abc', 1],
    ['-5', 1],
    ['10', 0],
    ['10', 1.5],
  ])('gives no total for %p times %p', (price, quantity) => {
    expect(lineTotal(price, quantity)).toBeNull();
  });
});

describe('formatItemList', () => {
  it('numbers the items on one line, with quantity, price, total and options', () => {
    expect(
      formatItemList([lunchBox('Blue'), lunchBox('Blush pink')], 'en'),
    ).toBe(
      '1. Double Layer Lunch Box (2 Litre) (1x 180) = 180, color: Blue • 2. Double Layer Lunch Box (2 Litre) (1x 180) = 180, color: Blush pink',
    );
  });

  it('drops an all-zero fraction and keeps a real one', () => {
    expect(
      formatItemList(
        [
          { name: 'Shirt', quantity: 2, unitPrice: '150.00', options: [] },
          { name: 'Socks', quantity: 3, unitPrice: '19.50', options: [] },
        ],
        'en',
      ),
    ).toBe('1. Shirt (2x 150) = 300 • 2. Socks (3x 19.50) = 58.50');
  });

  it('writes an item without a price with its quantity only', () => {
    expect(
      formatItemList(
        [{ name: 'Gift', quantity: 2, unitPrice: null, options: [] }],
        'en',
      ),
    ).toBe('1. Gift (2x)');
  });

  it('writes an option without a name as its value, with the Arabic comma', () => {
    expect(
      formatItemList(
        [
          {
            name: 'قميص',
            quantity: 1,
            unitPrice: '100',
            options: [{ value: 'أزرق' }],
          },
        ],
        'ar',
      ),
    ).toBe('1. قميص (1x 100) = 100، أزرق');
  });

  it('lists five items and counts the rest', () => {
    const list = formatItemList(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(item),
      'en',
    );
    expect(list.split(' • ')).toEqual([
      '1. A (1x 10) = 10',
      '2. B (1x 10) = 10',
      '3. C (1x 10) = 10',
      '4. D (1x 10) = 10',
      '5. E (1x 10) = 10',
      '+2 more items',
    ]);
    expect(
      formatItemList(['A', 'B', 'C', 'D', 'E', 'F'].map(item), 'ar'),
    ).toMatch(/\+1 منتجات أخرى$/);
  });

  it('leaves out whole items, never half of one, to stay within the limit', () => {
    const long = 'x'.repeat(200);
    const list = formatItemList(
      [1, 2, 3, 4, 5, 6].map(() => item(long)),
      'en',
    );

    expect(list.length).toBeLessThanOrEqual(ORDER_DETAIL_MAX_LENGTH.items);
    const parts = list.split(' • ');
    expect(parts[parts.length - 1]).toMatch(/^\+\d more items$/);
    // Each listed item is cut to its own limit; the count covers the rest.
    expect(
      parts.length - 1 + Number(/\d/.exec(parts[parts.length - 1])![0]),
    ).toBe(6);
  });

  it('keeps the list on one line whatever the product names hold', () => {
    expect(
      formatItemList([item('Box\nwith\tforks      and bottle')], 'en'),
    ).toBe('1. Box with forks and bottle (1x 10) = 10');
  });

  it('is empty for an order with no named item', () => {
    expect(formatItemList(null, 'en')).toBe('');
    expect(formatItemList([], 'en')).toBe('');
    expect(formatItemList([item('  ')], 'en')).toBe('');
  });
});

describe('buildOrderDetailValues and canFillTemplate', () => {
  const full = {
    lineItems: [lunchBox('Blue')],
    shippingRegion: 'القاهرة',
    shippingAddress: 'حلوان المشروع الامريكي\nمجاورة 3',
  };

  it('fills only the detail variables the template uses', () => {
    expect(buildOrderDetailValues(full, PLAIN, 'ar')).toEqual({});
    expect(buildOrderDetailValues(full, DETAILED, 'ar')).toEqual({
      items: '1. Double Layer Lunch Box (2 Litre) (1x 180) = 180، color: Blue',
      region: 'القاهرة',
      address: 'حلوان المشروع الامريكي مجاورة 3',
    });
  });

  it('a template without detail variables can always be filled', () => {
    expect(canFillTemplate(PLAIN, {})).toBe(true);
  });

  it('a detailed template needs items, a region and an address', () => {
    expect(canFillTemplate(DETAILED, full)).toBe(true);
    expect(canFillTemplate(DETAILED, { ...full, lineItems: [] })).toBe(false);
    expect(canFillTemplate(DETAILED, { ...full, lineItems: null })).toBe(false);
    expect(canFillTemplate(DETAILED, { ...full, shippingRegion: ' ' })).toBe(
      false,
    );
    expect(canFillTemplate(DETAILED, { ...full, shippingAddress: null })).toBe(
      false,
    );
  });

  it('asks only for what the template shows', () => {
    const itemsOnly: TemplateVariable[] = [{ key: 'items', name: 'items' }];
    expect(canFillTemplate(itemsOnly, { lineItems: [lunchBox('Blue')] })).toBe(
      true,
    );
  });
});
