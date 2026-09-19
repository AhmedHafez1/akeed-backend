import {
  classifyPaymentValue,
  countValues,
  MAX_LISTED_PAYMENT_VALUES,
  normalizePaymentValue,
  summarizePaymentValues,
} from './payment-value-classifier';

describe('classifyPaymentValue (US-04.6-03 AC6)', () => {
  it.each([
    'COD',
    'cod',
    'Cash',
    'CASH',
    'Cash on Delivery',
    'cash-on-delivery',
    'Cash on Delivery (COD)',
    'كاش',
    'نقدي',
    'عند الاستلام',
    'عند الإستلام',
    'الدفع عند الاستلام',
    'كاش عند الاستلام',
    'Collect',
    'Pay on delivery',
  ])('"%s" is cod', (value) => {
    expect(classifyPaymentValue(value)).toBe('cod');
  });

  it.each([
    'Paid',
    'PAID',
    'مدفوع',
    'Visa',
    'Credit Card',
    'card',
    'InstaPay',
    'instapay',
    'Wallet',
    'Vodafone Cash',
    'vodafone-cash',
    'Fawry',
    'Prepaid',
  ])('"%s" is not_cod', (value) => {
    expect(classifyPaymentValue(value)).toBe('not_cod');
  });

  it.each([
    'غير مدفوع',
    'unpaid',
    'Not paid',
    'non cod',
    'pending',
    'Shopify Payments',
    'bank transfer',
    '',
    '   ',
  ])('"%s" is unknown, for the merchant to decide', (value) => {
    expect(classifyPaymentValue(value)).toBe('unknown');
  });
});

describe('summarizePaymentValues (AC5, AC6)', () => {
  it('lists distinct values by count with their classification, counting blanks apart', () => {
    const summary = summarizePaymentValues(
      countValues(['COD', 'Paid', 'cod', 'COD', '', ' ', 'InstaPay', 'Other']),
    );
    expect(summary).toEqual({
      values: [
        {
          value: 'COD',
          normalizedValue: 'cod',
          count: 3,
          classification: 'cod',
          autoClassification: 'cod',
          source: 'auto',
        },
        expect.objectContaining({
          normalizedValue: 'instapay',
          classification: 'not_cod',
        }) as object,
        expect.objectContaining({
          normalizedValue: 'other',
          classification: 'unknown',
        }) as object,
        expect.objectContaining({
          normalizedValue: 'paid',
          classification: 'not_cod',
        }) as object,
      ],
      blankCount: 2,
      distinctCount: 4,
      truncated: false,
    });
  });

  it('merges Arabic spelling variants into one value', () => {
    const summary = summarizePaymentValues(
      countValues(['عند الاستلام', 'عند الإستلام', 'عند الاستلام']),
    );
    expect(summary.values).toEqual([
      expect.objectContaining({
        value: 'عند الاستلام',
        count: 3,
        classification: 'cod',
      }),
    ]);
  });

  it('applies saved or merchant choices over the automatic one', () => {
    const summary = summarizePaymentValues(countValues(['Other', 'Paid']), {
      map: { other: 'cod', paid: 'cod' },
      source: 'saved',
    });
    expect(summary.values).toEqual([
      expect.objectContaining({
        normalizedValue: 'other',
        classification: 'cod',
        autoClassification: 'unknown',
        source: 'saved',
      }),
      expect.objectContaining({
        normalizedValue: 'paid',
        classification: 'cod',
        autoClassification: 'not_cod',
        source: 'saved',
      }),
    ]);
  });

  it('ignores inherited keys in the choices', () => {
    const summary = summarizePaymentValues(countValues(['constructor']), {
      map: {},
    });
    expect(summary.values[0]).toMatchObject({
      classification: 'unknown',
      source: 'auto',
    });
  });

  it('lists at most 50 values and says there are more', () => {
    const values = Array.from(
      { length: MAX_LISTED_PAYMENT_VALUES + 5 },
      (_, index) => `method ${index}`,
    );
    const summary = summarizePaymentValues(countValues(values));
    expect(summary.values).toHaveLength(MAX_LISTED_PAYMENT_VALUES);
    expect(summary.distinctCount).toBe(MAX_LISTED_PAYMENT_VALUES + 5);
    expect(summary.truncated).toBe(true);
  });

  it('normalizes values the same way row validation will look them up', () => {
    expect(normalizePaymentValue('  Cash_On-Delivery ')).toBe(
      'cash on delivery',
    );
    expect(normalizePaymentValue('مدفوعة')).toBe('مدفوعه');
  });
});
