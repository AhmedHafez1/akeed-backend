import type { ImportField } from './alias-dictionary';
import { matchColumns, type FieldSuggestion } from './column-matcher';

function byField(fields: FieldSuggestion[]) {
  return Object.fromEntries(
    fields.map((suggestion) => [suggestion.field, suggestion]),
  ) as Record<ImportField, FieldSuggestion>;
}

function match(headers: string[], rows: string[][] = []) {
  const result = matchColumns(headers, rows);
  return { ...result, fields: byField(result.fields) };
}

/** Shopify's "Export orders" CSV header row. */
const SHOPIFY_HEADERS = [
  'Name',
  'Email',
  'Financial Status',
  'Paid at',
  'Fulfillment Status',
  'Fulfilled at',
  'Accepts Marketing',
  'Currency',
  'Subtotal',
  'Shipping',
  'Taxes',
  'Total',
  'Discount Code',
  'Discount Amount',
  'Shipping Method',
  'Created at',
  'Lineitem quantity',
  'Lineitem name',
  'Lineitem price',
  'Lineitem sku',
  'Billing Name',
  'Billing Street',
  'Billing Address1',
  'Billing Address2',
  'Billing City',
  'Billing Zip',
  'Billing Country',
  'Billing Phone',
  'Shipping Name',
  'Shipping Street',
  'Shipping Address1',
  'Shipping Address2',
  'Shipping City',
  'Shipping Zip',
  'Shipping Country',
  'Shipping Phone',
  'Notes',
  'Note Attributes',
  'Payment Method',
  'Payment Reference',
  'Refunded Amount',
  'Vendor',
  'Id',
  'Tags',
  'Phone',
];

function shopifyRow(values: Partial<Record<string, string>>): string[] {
  return SHOPIFY_HEADERS.map((header) => values[header] ?? '');
}

describe('matchColumns (US-04.6-03 AC1–AC3)', () => {
  it('maps a Shopify export', () => {
    const { fields } = match(SHOPIFY_HEADERS, [
      shopifyRow({ Name: '#1001', 'Billing Name': 'Ahmed Ali' }),
      shopifyRow({ Name: '#1002', 'Billing Name': 'Sara Omar' }),
    ]);
    expect(
      Object.fromEntries(
        Object.values(fields).map((field) => [field.field, field.columns]),
      ),
    ).toEqual({
      phone: ['Shipping Phone'],
      customerName: ['Shipping Name'],
      amount: ['Total'],
      orderReference: ['Name'],
      currency: ['Currency'],
      paymentMethod: ['Payment Method'],
      orderDate: ['Created at'],
      city: ['Shipping City'],
      address: ['Shipping Street'],
      notes: ['Notes'],
    });
    expect(fields.address.alternatives).toEqual([
      'Shipping Address1',
      'Billing Street',
      'Billing Address1',
    ]);
    expect(fields.phone).toMatchObject({
      confidence: 'exact',
      alternatives: ['Phone', 'Billing Phone'],
    });
    expect(fields.customerName.alternatives).toEqual(['Billing Name']);
    expect(fields.paymentMethod.alternatives).toEqual(['Financial Status']);
  });

  describe('phone priority: Shipping Phone > Phone > Billing Phone', () => {
    it.each([
      [
        ['Billing Phone', 'Phone', 'Shipping Phone'],
        'Shipping Phone',
        ['Phone', 'Billing Phone'],
      ],
      [['Billing Phone', 'Phone'], 'Phone', ['Billing Phone']],
      [['Billing Phone'], 'Billing Phone', []],
      [
        ['Billing Phone', 'Mobile', 'WhatsApp'],
        'Mobile',
        ['WhatsApp', 'Billing Phone'],
      ],
    ])('%j → %s', (headers, chosen, alternatives) => {
      expect(match(headers).fields.phone).toMatchObject({
        columns: [chosen],
        confidence: 'exact',
        alternatives,
      });
    });
  });

  describe('the ambiguous "Name" column (AC3)', () => {
    it('is the order reference when its values are #-prefixed', () => {
      const { fields } = match(
        ['Name', 'Phone', 'Total'],
        [
          ['#1001', '010', '5'],
          ['#1002', '011', '6'],
        ],
      );
      expect(fields.orderReference.columns).toEqual(['Name']);
      expect(fields.customerName.columns).toEqual([]);
    });

    it('is the order reference when its values are mostly numbers', () => {
      const { fields } = match(
        ['Name', 'Phone'],
        [['1001'], ['1002'], ['Ahmed']].map(([name]) => [name, '010']),
      );
      expect(fields.orderReference.columns).toEqual(['Name']);
    });

    it('counts Arabic-Indic numbers as numbers', () => {
      const { fields } = match(['Name'], [['١٠٠١'], ['١٠٠٢']]);
      expect(fields.orderReference.columns).toEqual(['Name']);
    });

    it('is the customer name when no other name column exists and values are names', () => {
      const { fields } = match(
        ['Name', 'Phone', 'Order ID'],
        [
          ['Ahmed Ali', '010', 'A-1'],
          ['#VIP Sara', '011', 'A-2'],
          ['Omar', '012', 'A-3'],
        ],
      );
      expect(fields.customerName).toMatchObject({
        columns: ['Name'],
        confidence: 'exact',
      });
      expect(fields.orderReference.columns).toEqual(['Order ID']);
    });

    it('is the order reference whenever another customer-name column exists', () => {
      const { fields } = match(
        ['Name', 'Billing Name', 'Phone'],
        [['Ahmed Ali', 'Ahmed Ali', '010']],
      );
      expect(fields.customerName.columns).toEqual(['Billing Name']);
      expect(fields.orderReference.columns).toEqual(['Name']);
    });

    it('is the order reference when a first/last name pair exists', () => {
      const { fields } = match(
        ['Name', 'First Name', 'Last Name'],
        [['Ahmed Ali', 'Ahmed', 'Ali']],
      );
      expect(fields.customerName.columns).toEqual(['First Name', 'Last Name']);
      expect(fields.orderReference.columns).toEqual(['Name']);
    });

    it('is only an alternative when a real reference column exists', () => {
      const { fields, unmappedColumns } = match(
        ['Name', 'Order Number', 'Customer'],
        [['#1001', '1001', 'Ahmed']],
      );
      expect(fields.orderReference).toMatchObject({
        columns: ['Order Number'],
        alternatives: ['Name'],
      });
      expect(unmappedColumns).toEqual(['Name']);
    });
  });

  it('prefers a full-name column to a first/last pair', () => {
    const { fields, unmappedColumns } = match([
      'First Name',
      'Last Name',
      'Customer Name',
    ]);
    expect(fields.customerName.columns).toEqual(['Customer Name']);
    expect(unmappedColumns).toContain('First Name');
  });

  it('uses a partial match when exactly one column contains an alias', () => {
    const { fields } = match(['Customer Mobile No', 'Order Value', 'Receiver']);
    expect(fields.phone).toMatchObject({
      columns: ['Customer Mobile No'],
      confidence: 'partial',
    });
  });

  it('leaves the field empty and lists every partial candidate when several match', () => {
    const { fields } = match(['Home Phone', 'Work Phone', 'Customer Name']);
    expect(fields.phone).toMatchObject({
      columns: [],
      confidence: 'none',
      source: 'none',
      alternatives: ['Home Phone', 'Work Phone'],
    });
  });

  it('prefers an exact column over partial ones', () => {
    const { fields } = match(['Subtotal', 'Total', 'Lineitem price']);
    expect(fields.amount).toMatchObject({
      columns: ['Total'],
      confidence: 'exact',
    });
  });

  it('suggests only the first of two columns both named Phone', () => {
    const { fields, unmappedColumns } = match(['Phone', 'Phone (2)', 'Name']);
    expect(fields.phone).toMatchObject({
      columns: ['Phone'],
      confidence: 'exact',
      alternatives: ['Phone (2)'],
    });
    expect(unmappedColumns).toContain('Phone (2)');
  });

  it('keeps a genuine "(2)" header as it is', () => {
    const { fields } = match(['Notes (2)']);
    expect(fields.notes).toMatchObject({ confidence: 'partial' });
  });

  it('matches nothing to a header of only "#"', () => {
    const { fields, unmappedColumns } = match(['#', 'Phone']);
    expect(
      Object.values(fields).flatMap((field) => [
        ...field.columns,
        ...field.alternatives,
      ]),
    ).not.toContain('#');
    expect(unmappedColumns).toEqual(['#']);
  });

  it('matches mixed Arabic and English headers', () => {
    const { fields } = match([
      'رقم الطلب',
      'Customer Name',
      'رقم الموبايل',
      'الإجمالي',
      'Payment',
      'تاريخ الطلب',
      'المحافظة',
      'العنوان',
      'ملاحظات',
    ]);
    expect(
      Object.fromEntries(
        Object.values(fields).map((field) => [field.field, field.columns]),
      ),
    ).toEqual({
      phone: ['رقم الموبايل'],
      customerName: ['Customer Name'],
      amount: ['الإجمالي'],
      orderReference: ['رقم الطلب'],
      currency: [],
      paymentMethod: ['Payment'],
      orderDate: ['تاريخ الطلب'],
      city: ['المحافظة'],
      address: ['العنوان'],
      notes: ['ملاحظات'],
    });
  });

  it('does not treat a split country code and number as a phone', () => {
    const { fields, unmappedColumns } = match(['Country code', 'Number']);
    expect(fields.phone.columns).toEqual([]);
    expect(unmappedColumns).toEqual(['Country code', 'Number']);
  });

  it('never suggests one column for two fields', () => {
    const { fields } = match([
      'Customer Phone',
      'Customer Name',
      'Customer Address',
    ]);
    const used = Object.values(fields).flatMap((field) => field.columns);
    expect(new Set(used).size).toBe(used.length);
    expect(fields.phone.columns).toEqual(['Customer Phone']);
    expect(fields.customerName.columns).toEqual(['Customer Name']);
    expect(fields.address.columns).toEqual(['Customer Address']);
  });

  it('marks the required fields and lists unmapped columns in file order', () => {
    const result = matchColumns(['SKU', 'Phone', 'Color'], []);
    expect(
      result.fields.filter((field) => field.required).map((f) => f.field),
    ).toEqual(['phone', 'customerName', 'amount']);
    expect(result.unmappedColumns).toEqual(['SKU', 'Color']);
  });
});
