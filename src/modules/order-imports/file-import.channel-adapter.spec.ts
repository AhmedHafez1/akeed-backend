import { FileImportChannelAdapter } from './file-import.channel-adapter';
import type { NormalizedImportOrder } from './validation/row-validator';

const batch = { id: 'batch-1', shortCode: 'ABC123' };

const normalized = (
  overrides: Partial<NormalizedImportOrder> = {},
): NormalizedImportOrder => ({
  orderNumber: '#1001',
  customerPhone: '+201012345678',
  customerName: 'Ahmed Ali',
  totalPrice: '750.00',
  currency: 'EGP',
  paymentMethod: 'cash_on_delivery',
  ...overrides,
});

describe('FileImportChannelAdapter', () => {
  it('keys each row by its batch and row number', () => {
    const input = FileImportChannelAdapter.toAcceptManyInput(
      { rowNumber: 7, normalized: normalized(), dedupeKey: 'ref:1001' },
      batch,
    );

    // The service namespaces this to `import:batch-1:7`.
    expect(input.idempotencyKey).toBe('batch-1:7');
  });

  it('uses the merchant reference as the external identity', () => {
    // Two batches carrying the same order must collide on the
    // (integration_id, external_order_id) index rather than duplicate.
    const input = FileImportChannelAdapter.toAcceptManyInput(
      { rowNumber: 7, normalized: normalized(), dedupeKey: 'ref:1001' },
      batch,
    );

    expect(input.order.externalOrderId).toBe('ref:1001');
    expect(input.order.orderNumber).toBe('#1001');
  });

  it('falls back to a batch-scoped identity when the file has no reference', () => {
    const input = FileImportChannelAdapter.toAcceptManyInput(
      {
        rowNumber: 7,
        normalized: normalized({ orderNumber: undefined }),
        dedupeKey: null,
      },
      batch,
    );

    expect(input.order.externalOrderId).toBe('imp:batch-1:7');
    expect(input.order.orderNumber).toBe('IMP-ABC123-7');
  });

  it('keeps the reference as written even when it is not the identity', () => {
    // The merchant sees their own number; only the identity is normalized.
    const input = FileImportChannelAdapter.toAcceptManyInput(
      {
        rowNumber: 3,
        normalized: normalized({ orderNumber: '# 10 01' }),
        dedupeKey: 'ref:1001',
      },
      batch,
    );

    expect(input.order.orderNumber).toBe('# 10 01');
    expect(input.order.externalOrderId).toBe('ref:1001');
  });

  it('carries the batch and row as envelope metadata', () => {
    const input = FileImportChannelAdapter.toAcceptManyInput(
      { rowNumber: 7, normalized: normalized(), dedupeKey: 'ref:1001' },
      batch,
    );

    expect(input.envelopeExtras).toEqual({
      importBatchId: 'batch-1',
      importRowNumber: 7,
    });
  });

  it('passes on only the optional fields the row actually filled', () => {
    // An `undefined` key would still widen the canonical order, and with it
    // the submission fingerprint.
    const bare = FileImportChannelAdapter.toAcceptManyInput(
      { rowNumber: 1, normalized: normalized(), dedupeKey: null },
      batch,
    );
    expect(bare.order.extras).toEqual({});

    const full = FileImportChannelAdapter.toAcceptManyInput(
      {
        rowNumber: 1,
        normalized: normalized({
          orderDate: '2026-09-18',
          city: 'Cairo',
          address: '12 Nile St',
          notes: 'Call first',
        }),
        dedupeKey: null,
      },
      batch,
    );
    expect(full.order.extras).toEqual({
      orderDate: '2026-09-18',
      city: 'Cairo',
      address: '12 Nile St',
      notes: 'Call first',
    });
  });

  it('never invents values for fields the row left empty', () => {
    const input = FileImportChannelAdapter.toAcceptManyInput(
      {
        rowNumber: 1,
        normalized: { paymentMethod: '' },
        dedupeKey: null,
      },
      batch,
    );

    expect(input.order).toMatchObject({
      customerPhone: '',
      customerName: '',
      totalPrice: '',
      currency: '',
      paymentMethod: '',
    });
  });
});
