import {
  applyExistingOrderMatches,
  applyInFileDedupe,
  type BatchRow,
  type ExistingOrderMatch,
} from './batch-dedupe';
import { outcomeOf, type RowIssue } from './issue-codes';
import type { NormalizedImportOrder } from './row-validator';

function row(
  rowNumber: number,
  normalized: Partial<NormalizedImportOrder>,
  dedupeKey: string | null,
  issues: RowIssue[] = [],
): BatchRow {
  return {
    rowNumber,
    normalized: { paymentMethod: 'cash on delivery', ...normalized },
    issues,
    dedupeKey,
    collapsedInto: null,
  };
}

const order = {
  customerPhone: '+201012345678',
  customerName: 'Ahmed',
  totalPrice: '750.00',
  orderNumber: '#1001',
};

describe('in-file dedupe, L2 (AC9)', () => {
  it('collapses a Shopify 3-line-item order into its lowest row', () => {
    const rows = [
      row(2, order, 'ref:1001'),
      // Shopify leaves customer and totals blank on later line items.
      row(3, { orderNumber: '#1001' }, 'ref:1001', [
        { code: 'PHONE_MISSING', field: 'phone' },
        { code: 'NAME_MISSING', field: 'customerName' },
        { code: 'AMOUNT_MISSING', field: 'amount' },
      ]),
      row(4, order, 'ref:1001'),
    ];
    applyInFileDedupe(rows);
    expect(rows.map((r) => [r.collapsedInto, outcomeOf(r.issues)])).toEqual([
      [null, 'ready'],
      [2, 'duplicate'],
      [2, 'duplicate'],
    ]);
    expect(rows[1].issues).toEqual([
      { code: 'DUPLICATE_IN_FILE', params: { rowNumber: 2 } },
    ]);
  });

  it('makes every row invalid when a reference has two phones', () => {
    const rows = [
      row(2, order, 'ref:1001'),
      row(3, { ...order, customerPhone: '+201112345678' }, 'ref:1001'),
      row(4, order, 'ref:1001'),
    ];
    applyInFileDedupe(rows);
    for (const r of rows) {
      expect(r.issues).toContainEqual({
        code: 'ORDER_REF_CONFLICT_IN_FILE',
        field: 'orderReference',
      });
      expect(outcomeOf(r.issues)).toBe('invalid');
      expect(r.collapsedInto).toBeNull();
    }
  });

  it('makes every row invalid when a reference has two amounts', () => {
    const rows = [
      row(2, order, 'ref:1001'),
      row(3, { ...order, totalPrice: '751.00' }, 'ref:1001'),
    ];
    applyInFileDedupe(rows);
    expect(rows.map((r) => outcomeOf(r.issues))).toEqual([
      'invalid',
      'invalid',
    ]);
  });

  it('collapses reference-less rows identical in phone, name, amount and date', () => {
    const noRef = { ...order, orderNumber: undefined, orderDate: '2026-09-18' };
    const rows = [
      row(2, noRef, null),
      row(3, noRef, null),
      row(4, { ...noRef, orderDate: '2026-09-17' }, null),
      row(5, { ...noRef, customerName: 'Mona' }, null),
    ];
    applyInFileDedupe(rows);
    expect(rows.map((r) => r.collapsedInto)).toEqual([null, 2, null, null]);
  });

  it('keeps unrelated rows untouched', () => {
    const rows = [
      row(2, order, 'ref:1001'),
      row(3, { ...order, orderNumber: '#1002' }, 'ref:1002'),
    ];
    applyInFileDedupe(rows);
    expect(rows.every((r) => r.issues.length === 0)).toBe(true);
  });
});

describe('existing orders, L1 and L3 (AC10, AC11)', () => {
  const existing = (
    overrides: Partial<ExistingOrderMatch>,
  ): ExistingOrderMatch => ({
    id: 'order-1',
    externalOrderId: 'ref:9999',
    orderNumber: '#9999',
    customerPhone: '+201099999999',
    totalPrice: '1.00',
    createdDate: '2026-09-18',
    createdAt: '2026-09-18T08:00:00.000Z',
    ...overrides,
  });

  it('marks an already imported reference as a duplicate with its order id', () => {
    const rows = [row(2, order, 'ref:1001')];
    applyExistingOrderMatches(rows, {
      byExternalId: [existing({ id: 'order-7', externalOrderId: 'ref:1001' })],
      recentByPhone: [],
      recentByOrderNumber: [],
    });
    expect(rows[0].issues).toEqual([
      {
        code: 'ALREADY_IMPORTED',
        field: 'orderReference',
        params: { orderId: 'order-7' },
      },
    ]);
    expect(outcomeOf(rows[0].issues)).toBe('duplicate');
  });

  it('holds back the same phone and amount as a possible duplicate', () => {
    const rows = [row(2, { ...order, orderNumber: undefined }, null)];
    applyExistingOrderMatches(rows, {
      byExternalId: [],
      recentByPhone: [
        existing({
          id: 'order-2',
          orderNumber: '#55',
          customerPhone: order.customerPhone,
          totalPrice: '750.00',
        }),
        // Same phone, other amount: not a match.
        existing({ customerPhone: order.customerPhone, totalPrice: '20.00' }),
      ],
      recentByOrderNumber: [],
    });
    expect(rows[0].issues).toEqual([
      {
        code: 'POSSIBLE_DUPLICATE',
        params: {
          orderNumber: '#55',
          date: '2026-09-18',
          match: 'phone_amount',
        },
      },
    ]);
    expect(outcomeOf(rows[0].issues)).toBe('excluded');
    expect(outcomeOf(rows[0].issues, true)).toBe('ready');
  });

  it('matches an order number case-insensitively', () => {
    const rows = [row(2, { ...order, orderNumber: 'ord-7' }, 'ref:ord-7')];
    applyExistingOrderMatches(rows, {
      byExternalId: [],
      recentByPhone: [],
      recentByOrderNumber: [existing({ orderNumber: 'ORD-7' })],
    });
    expect(rows[0].issues).toEqual([
      {
        code: 'POSSIBLE_DUPLICATE',
        params: {
          orderNumber: 'ORD-7',
          date: '2026-09-18',
          match: 'order_number',
        },
      },
    ]);
  });

  it('reports one order matched both ways once', () => {
    const same = existing({
      customerPhone: order.customerPhone,
      totalPrice: '750',
      orderNumber: '#1001',
    });
    const rows = [row(2, order, 'ref:1001')];
    applyExistingOrderMatches(rows, {
      byExternalId: [],
      recentByPhone: [same],
      recentByOrderNumber: [same],
    });
    expect(rows[0].issues).toHaveLength(1);
  });

  it('only looks at rows that are still ready', () => {
    const invalid = row(2, order, 'ref:1001', [
      { code: 'CURRENCY_UNSUPPORTED', field: 'currency' },
    ]);
    applyExistingOrderMatches([invalid], {
      byExternalId: [existing({ externalOrderId: 'ref:1001' })],
      recentByPhone: [],
      recentByOrderNumber: [],
    });
    expect(invalid.issues).toHaveLength(1);
  });
});
