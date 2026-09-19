import { StandaloneOrderEligibilityStrategy } from '../../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
} from '../../../shared/config/bulk-import.config';
import { PhoneService } from '../../../shared/services/phone.service';
import { OrderEligibilityService } from '../../verification-core/order-eligibility.service';
import type { ImportColumnMapping } from '../mapping/mapping-rules';
import { RowValidationService } from './row-validation.service';

const NOW = new Date('2026-09-19T10:00:00Z');
const columns: ImportColumnMapping = {
  phone: 'Phone',
  customerName: ['Name'],
  amount: 'Total',
  orderReference: 'Order',
  currency: null,
  paymentMethod: 'Payment',
  orderDate: 'Date',
  city: null,
  address: null,
  notes: null,
};
const source = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'standalone',
  timezone: 'Africa/Cairo',
  assumeCodWhenPaymentMissing: false,
} as never;

function storedRow(
  rowNumber: number,
  cells: Record<string, string>,
  includeOverride = false,
) {
  return {
    rowNumber,
    raw: {
      Phone: '01012345678',
      Name: 'Ahmed',
      Total: '750',
      Order: `#${rowNumber}`,
      Payment: 'COD',
      Date: '2026-09-18',
      ...cells,
    },
    issues: [],
    includeOverride,
  };
}

function setup(options: { country?: string } = {}) {
  const repository = {
    findBatchForValidation: jest.fn().mockResolvedValue({
      status: 'draft',
      expiresAt: '2026-09-20T00:00:00.000Z',
      integrationId: 'int-1',
      mapping: { confirmed: true, columns },
      options: {
        country: options.country ?? 'EG',
        defaultCurrency: 'EGP',
        dateFormat: 'auto',
        paymentValueMap: {},
      },
    }),
    listRowsForValidation: jest.fn(),
    findOrdersByExternalIds: jest.fn().mockResolvedValue([]),
    findRecentOrdersByPhones: jest.fn().mockResolvedValue([]),
    findRecentOrdersByOrderNumbers: jest.fn().mockResolvedValue([]),
    writeValidation: jest.fn().mockResolvedValue('saved'),
  };
  const config = {
    get: (key: string) =>
      key === BULK_IMPORT_CONFIG ? parseBulkImportConfig({}) : undefined,
  };
  const service = new RowValidationService(
    repository as never,
    new PhoneService(),
    new OrderEligibilityService([new StandaloneOrderEligibilityStrategy()]),
    config as never,
  );
  const written = () =>
    (
      repository.writeValidation.mock.calls.at(-1) as [
        {
          rows: {
            rowNumber: number;
            outcome: string;
            includable: boolean;
            issues: { code: string }[];
            normalized: { customerPhone?: string };
          }[];
        },
      ]
    )[0];
  return { repository, service, written };
}

describe('RowValidationService', () => {
  it('writes every row with its outcome, version and summary inputs', async () => {
    const { repository, service, written } = setup();
    repository.listRowsForValidation.mockResolvedValue([
      storedRow(2, {}),
      storedRow(3, { Payment: 'Paid' }),
      storedRow(4, { Phone: '' }),
    ]);
    await service.validateBatch({ orgId: 'org-1', source }, 'batch-1', NOW);

    expect(repository.findBatchForValidation).toHaveBeenCalledWith(
      'org-1',
      'batch-1',
    );
    expect(repository.writeValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        batchId: 'batch-1',
        validationVersion: 1,
        now: NOW,
      }),
    );
    expect(written().rows.map((row) => row.outcome)).toEqual([
      'ready',
      'excluded',
      'invalid',
    ]);
  });

  it('asks the database once per lookup with the ready rows only', async () => {
    const { repository, service } = setup();
    repository.listRowsForValidation.mockResolvedValue([
      storedRow(2, {}),
      storedRow(3, { Order: '#ABC' }),
      storedRow(4, { Phone: '' }),
    ]);
    await service.validateBatch({ orgId: 'org-1', source }, 'batch-1', NOW);

    const scope = { orgId: 'org-1', integrationId: 'int-1' };
    expect(repository.findOrdersByExternalIds).toHaveBeenCalledTimes(1);
    expect(repository.findOrdersByExternalIds).toHaveBeenCalledWith(scope, [
      'ref:2',
      'ref:abc',
    ]);
    expect(repository.findRecentOrdersByPhones).toHaveBeenCalledWith(
      scope,
      ['+201012345678'],
      new Date('2026-09-12T10:00:00Z'),
    );
    expect(repository.findRecentOrdersByOrderNumbers).toHaveBeenCalledWith(
      scope,
      ['#2', '#abc'],
      new Date('2026-08-20T10:00:00Z'),
    );
  });

  it('marks L1 and L3 matches and keeps an include override includable', async () => {
    const { repository, service, written } = setup();
    repository.listRowsForValidation.mockResolvedValue([
      storedRow(2, {}),
      storedRow(3, { Phone: '01112345678', Order: '' }, true),
    ]);
    repository.findOrdersByExternalIds.mockResolvedValue([
      {
        id: 'order-1',
        externalOrderId: 'ref:2',
        orderNumber: '#2',
        customerPhone: '+201012345678',
        totalPrice: '750.00',
        createdAt: '2026-09-18T20:00:00.000Z',
      },
    ]);
    repository.findRecentOrdersByPhones.mockResolvedValue([
      {
        id: 'order-2',
        externalOrderId: 'manual-1',
        orderNumber: 'M-1',
        customerPhone: '+201112345678',
        totalPrice: '750.00',
        // 23:00 UTC is the next day in Cairo.
        createdAt: '2026-09-17T23:00:00.000Z',
      },
    ]);
    await service.validateBatch({ orgId: 'org-1', source }, 'batch-1', NOW);

    const [imported, possible] = written().rows;
    expect(imported).toMatchObject({
      outcome: 'duplicate',
      issues: [{ code: 'ALREADY_IMPORTED', params: { orderId: 'order-1' } }],
    });
    expect(possible).toMatchObject({
      outcome: 'excluded',
      includable: true,
      issues: [
        {
          code: 'POSSIBLE_DUPLICATE',
          params: { orderNumber: 'M-1', date: '2026-09-18' },
        },
      ],
    });
  });

  it('gives an identical result when run twice', async () => {
    const { repository, service, written } = setup();
    repository.listRowsForValidation.mockResolvedValue([
      storedRow(2, {}),
      storedRow(3, { Order: '#2' }),
      storedRow(4, { Total: '1.250,00', Payment: '' }),
    ]);
    await service.validateBatch({ orgId: 'org-1', source }, 'batch-1', NOW);
    const first = written();
    await service.validateBatch({ orgId: 'org-1', source }, 'batch-1', NOW);
    expect(written()).toEqual(first);
  });

  it('re-normalizes from raw when the country changes', async () => {
    const egypt = setup({ country: 'EG' });
    const saudi = setup({ country: 'SA' });
    const rows = [storedRow(2, { Phone: '501234567' })];
    egypt.repository.listRowsForValidation.mockResolvedValue(rows);
    saudi.repository.listRowsForValidation.mockResolvedValue(rows);
    await egypt.service.validateBatch({ orgId: 'org-1', source }, 'b', NOW);
    await saudi.service.validateBatch({ orgId: 'org-1', source }, 'b', NOW);
    expect(egypt.written().rows[0].issues).toEqual([
      { code: 'PHONE_NOT_MOBILE', field: 'phone' },
    ]);
    expect(saudi.written().rows[0]).toMatchObject({
      outcome: 'ready',
      normalized: { customerPhone: '+966501234567' },
    });
  });

  it('refuses a batch of another source and a batch that left draft', async () => {
    const { repository, service } = setup();
    repository.findBatchForValidation.mockResolvedValueOnce({
      status: 'draft',
      integrationId: 'int-2',
      mapping: null,
      options: null,
    });
    await expect(
      service.validateBatch({ orgId: 'org-1', source }, 'b', NOW),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BATCH_STATE_CONFLICT' },
    });

    repository.findBatchForValidation.mockResolvedValueOnce(null);
    await expect(
      service.validateBatch({ orgId: 'org-1', source }, 'b', NOW),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_BATCH_NOT_FOUND' } });

    repository.listRowsForValidation.mockResolvedValue([storedRow(2, {})]);
    repository.writeValidation.mockResolvedValueOnce('not_draft');
    await expect(
      service.validateBatch({ orgId: 'org-1', source }, 'b', NOW),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BATCH_STATE_CONFLICT' },
    });
  });

  it('validates nothing until the mapping is confirmed', async () => {
    const { repository, service } = setup();
    repository.findBatchForValidation.mockResolvedValueOnce({
      status: 'draft',
      integrationId: 'int-1',
      mapping: { confirmed: false, columns },
      options: {},
    });
    await service.validateBatch({ orgId: 'org-1', source }, 'b', NOW);
    expect(repository.listRowsForValidation).not.toHaveBeenCalled();
    expect(repository.writeValidation).not.toHaveBeenCalled();
  });

  it('validates 5,000 rows in under 2 s, excluding I/O', () => {
    const { service } = setup();
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      storedRow(index + 2, {
        Phone: `010${String(10_000_000 + index).slice(-8)}`,
        Name: `Customer ${index}`,
        Total: index % 3 === 0 ? '1,250.50' : `${100 + index}`,
        // Every tenth order spans two line-item rows.
        Order: `#${index % 10 === 0 ? index + 1 : index}`,
        Payment: index % 7 === 0 ? 'Paid' : 'COD',
      }),
    );
    const run = () =>
      service.validateRows(rows, {
        orgId: 'org-1',
        integrationId: 'int-1',
        integration: { platformType: 'standalone' },
        mapping: columns,
        options: {
          country: 'EG',
          defaultCurrency: 'EGP',
          dateFormat: 'auto',
          paymentValueMap: {},
        },
        detectedDateFormat: null,
        timezone: 'Africa/Cairo',
        now: NOW,
        maxOrderAgeDays: 7,
      });
    // One warm-up run so the measurement is validation, not module
    // loading, phone metadata or JIT (as the parse timing spec does).
    run();
    const startedAt = performance.now();
    const validated = run();
    const elapsedMs = performance.now() - startedAt;
    // Recorded in the story evidence.
    console.log(`validated 5,000 rows in ${elapsedMs.toFixed(0)} ms`);
    expect(validated).toHaveLength(5_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
