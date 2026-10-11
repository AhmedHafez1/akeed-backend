import { ORDER_LINE_ITEMS_MAX } from '../interfaces/order.interface';
import { toOrderLineItems } from './order-line-items';

describe('toOrderLineItems', () => {
  it('keeps a name, a whole quantity, a decimal price and the options', () => {
    expect(
      toOrderLineItems([
        {
          name: '  Lunch\n Box ',
          quantity: 2,
          unitPrice: 180,
          options: [
            { name: 'color', value: 'Blue' },
            { value: 'L' },
            { name: 'empty', value: '' },
          ],
        },
        { name: 'Bottle', quantity: '3', unitPrice: '19.50' },
      ]),
    ).toEqual([
      {
        name: 'Lunch Box',
        quantity: 2,
        unitPrice: '180',
        options: [{ name: 'color', value: 'Blue' }, { value: 'L' }],
      },
      { name: 'Bottle', quantity: 3, unitPrice: '19.50', options: [] },
    ]);
  });

  it('drops a line without a name', () => {
    expect(
      toOrderLineItems([
        { name: '', quantity: 1, unitPrice: '1' },
        { name: null, quantity: 1, unitPrice: '1' },
        { name: { nested: true }, quantity: 1, unitPrice: '1' },
      ]),
    ).toEqual([]);
  });

  it.each([0, -1, 1.5, 'many', null, undefined])(
    'reads the quantity %p as one',
    (quantity) => {
      expect(
        toOrderLineItems([{ name: 'A', quantity, unitPrice: '1' }])[0].quantity,
      ).toBe(1);
    },
  );

  it.each([-5, Number.NaN, 'free', '1,5', null, undefined, {}])(
    'keeps no price for %p',
    (unitPrice) => {
      expect(
        toOrderLineItems([{ name: 'A', quantity: 1, unitPrice }])[0].unitPrice,
      ).toBeNull();
    },
  );

  it('keeps only the first lines of a very long order', () => {
    const lines = toOrderLineItems(
      Array.from({ length: ORDER_LINE_ITEMS_MAX + 20 }, (_, index) => ({
        name: `Item ${index}`,
        quantity: 1,
        unitPrice: '1',
      })),
    );
    expect(lines).toHaveLength(ORDER_LINE_ITEMS_MAX);
  });
});
