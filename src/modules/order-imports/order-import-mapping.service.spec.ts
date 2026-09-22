import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { SaveOrderImportMappingDto } from './dto/order-import-mapping.dto';
import { MAPPING_DICTIONARY_VERSION } from './mapping/alias-dictionary';
import { headerSignature } from './mapping/header-key';
import {
  defaultImportOptions,
  OrderImportMappingService,
} from './order-import-mapping.service';

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};
const source = {
  id: 'int-1',
  orgId: 'org-1',
  countryCode: 'sa',
  shippingCurrency: 'sar',
} as never;
const HEADERS = ['Phone', 'Name', 'Total', 'Payment', 'Date', 'Notes'];
const HOUR = 3_600_000;

function httpError(error: unknown) {
  const http = error as {
    getStatus(): number;
    getResponse(): Record<string, unknown>;
  };
  return { status: http.getStatus(), body: http.getResponse() };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return httpError(error);
  }
  throw new Error('expected a refusal');
}

function body(
  overrides: {
    mapping?: Partial<SaveOrderImportMappingDto['mapping']>;
    options?: Partial<SaveOrderImportMappingDto['options']>;
  } = {},
): SaveOrderImportMappingDto {
  return {
    mapping: {
      phone: 'Phone',
      customerName: ['Name'],
      amount: 'Total',
      ...overrides.mapping,
    },
    options: {
      country: 'EG',
      defaultCurrency: 'EGP',
      dateFormat: 'auto',
      ...overrides.options,
    },
  } as SaveOrderImportMappingDto;
}

describe('OrderImportMappingService', () => {
  const repository = {
    findMappingProfile: jest.fn(),
    findBatchForMapping: jest.fn(),
    columnValueCounts: jest.fn(),
    saveMapping: jest.fn(),
    readCounts: jest.fn(),
  };
  const rowValidation = { validateBatch: jest.fn() };
  const service = new OrderImportMappingService(
    repository as never,
    rowValidation as never,
  );
  const draft = (overrides: Record<string, unknown> = {}) => ({
    status: 'draft',
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    headers: HEADERS,
    mapping: null,
    ...overrides,
  });
  const valuesByColumn: Record<string, { value: string; count: number }[]> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(valuesByColumn)) delete valuesByColumn[key];
    repository.findBatchForMapping.mockResolvedValue(draft());
    repository.columnValueCounts.mockImplementation(
      (_org: string, _batch: string, column: string) =>
        Promise.resolve(valuesByColumn[column] ?? []),
    );
    repository.saveMapping.mockResolvedValue({
      outcome: 'saved',
      mappingProfileId: 'profile-1',
    });
    repository.readCounts.mockResolvedValue({ ready: 0 });
    rowValidation.validateBatch.mockResolvedValue(undefined);
    repository.findMappingProfile.mockResolvedValue(null);
  });

  describe('save: mapping validation', () => {
    it.each([
      ['phone', { phone: null }],
      ['amount', { amount: undefined }],
      ['customerName', { customerName: [] }],
    ])('requires %s', async (field, mapping) => {
      const refusal = await failure(
        service.save(owner, source, 'batch-1', body({ mapping })),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: { [field]: expect.any(String) as string },
      });
      expect(repository.saveMapping).not.toHaveBeenCalled();
      expect(rowValidation.validateBatch).not.toHaveBeenCalled();
    });

    it('refuses one column for two fields', async () => {
      const refusal = await failure(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { notes: 'Phone' } }),
        ),
      );
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: { notes: expect.stringContaining('phone') as string },
      });
    });

    it('refuses the same column twice in the name', async () => {
      const refusal = await failure(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { customerName: ['Name', 'Name'] } }),
        ),
      );
      expect(refusal.body).toMatchObject({
        fieldErrors: { customerName: expect.any(String) as string },
      });
    });

    it('refuses a column that is not in the file', async () => {
      const refusal = await failure(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { city: 'City' } }),
        ),
      );
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: { city: expect.any(String) as string },
      });
    });

    it('requires a date format when every date is ambiguous', async () => {
      valuesByColumn.Date = [
        { value: '05/06/2026', count: 3 },
        { value: '01/02/2026', count: 1 },
      ];
      const refusal = await failure(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { orderDate: 'Date' } }),
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: { 'options.dateFormat': expect.any(String) as string },
        dateFormat: { column: 'Date', ambiguous: true },
      });

      await expect(
        service.save(
          owner,
          source,
          'batch-1',
          body({
            mapping: { orderDate: 'Date' },
            options: { dateFormat: 'DMY' },
          }),
        ),
      ).resolves.toMatchObject({ options: { dateFormat: 'DMY' } });
    });

    it('does not ask for a date format when a value settles it', async () => {
      valuesByColumn.Date = [
        { value: '05/06/2026', count: 3 },
        { value: '25/06/2026', count: 1 },
      ];
      await expect(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { orderDate: 'Date' } }),
        ),
      ).resolves.toMatchObject({
        dateFormat: { ambiguous: false, detectedFormat: 'DMY' },
      });
    });

    it('requires a choice for every unknown payment value and lists them', async () => {
      valuesByColumn.Payment = [
        { value: 'COD', count: 5 },
        { value: 'Bank transfer', count: 2 },
        { value: '', count: 1 },
      ];
      const refusal = await failure(
        service.save(
          owner,
          source,
          'batch-1',
          body({ mapping: { paymentMethod: 'Payment' } }),
        ),
      );
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: {
          'options.paymentValueMap': expect.any(String) as string,
        },
        paymentValues: {
          column: 'Payment',
          blankCount: 1,
          values: [
            { normalizedValue: 'cod', classification: 'cod' },
            { normalizedValue: 'bank transfer', classification: 'unknown' },
          ],
        },
      });

      const saved = await service.save(
        owner,
        source,
        'batch-1',
        body({
          mapping: { paymentMethod: 'Payment' },
          // Keys are normalized, and a choice for an unseen value is dropped.
          options: {
            paymentValueMap: { 'Bank Transfer': 'not_cod', ghost: 'cod' },
          },
        }),
      );
      expect(saved.options.paymentValueMap).toEqual({
        'bank transfer': 'not_cod',
      });
      expect(saved.paymentValues?.values[1]).toMatchObject({
        classification: 'not_cod',
        source: 'merchant',
      });
    });

    it('treats كاش, عند الاستلام, Paid, مدفوع and InstaPay as known', async () => {
      valuesByColumn.Payment = [
        'كاش',
        'عند الاستلام',
        'Paid',
        'مدفوع',
        'InstaPay',
        '',
      ].map((value) => ({ value, count: 1 }));
      const saved = await service.save(
        owner,
        source,
        'batch-1',
        body({ mapping: { paymentMethod: 'Payment' } }),
      );
      expect(
        Object.fromEntries(
          saved.paymentValues!.values.map((entry) => [
            entry.value,
            entry.classification,
          ]),
        ),
      ).toEqual({
        كاش: 'cod',
        'عند الاستلام': 'cod',
        Paid: 'not_cod',
        مدفوع: 'not_cod',
        InstaPay: 'not_cod',
      });
    });
  });

  describe('save: batch state', () => {
    it('answers 404 for a batch of another organization', async () => {
      repository.findBatchForMapping.mockResolvedValue(null);
      const refusal = await failure(
        service.save(owner, source, 'batch-1', body()),
      );
      expect(refusal.status).toBe(404);
      expect(refusal.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
      expect(repository.findBatchForMapping).toHaveBeenCalledWith(
        'org-1',
        'batch-1',
      );
    });

    it.each(['committing', 'awaiting_start', 'releasing', 'completed'])(
      'refuses a %s batch with IMPORT_BATCH_STATE_CONFLICT',
      async (status) => {
        repository.findBatchForMapping.mockResolvedValue(draft({ status }));
        const refusal = await failure(
          service.save(owner, source, 'batch-1', body()),
        );
        expect(refusal.status).toBe(409);
        expect(refusal.body).toMatchObject({
          code: 'IMPORT_BATCH_STATE_CONFLICT',
          status,
        });
        expect(repository.saveMapping).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'a draft past its expiry',
        draft({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      ],
      ['an expired batch', draft({ status: 'expired' })],
    ])('refuses %s with IMPORT_BATCH_EXPIRED', async (_label, batch) => {
      repository.findBatchForMapping.mockResolvedValue(batch);
      const refusal = await failure(
        service.save(owner, source, 'batch-1', body()),
      );
      expect(refusal.status).toBe(410);
      expect(refusal.body).toMatchObject({ code: 'IMPORT_BATCH_EXPIRED' });
    });

    it('answers the new state when a commit wins the race', async () => {
      repository.saveMapping.mockResolvedValue({ outcome: 'not_draft' });
      repository.findBatchForMapping
        .mockResolvedValueOnce(draft())
        .mockResolvedValueOnce(draft({ status: 'committing' }));
      const refusal = await failure(
        service.save(owner, source, 'batch-1', body()),
      );
      expect(refusal.body).toMatchObject({
        code: 'IMPORT_BATCH_STATE_CONFLICT',
        status: 'committing',
      });
      expect(rowValidation.validateBatch).not.toHaveBeenCalled();
    });
  });

  describe('save: persistence', () => {
    it('stores the mapping, remembers the profile, then re-validates', async () => {
      const response = await service.save(
        owner,
        source,
        'batch-1',
        body({ mapping: { notes: 'Notes' } }),
      );

      expect(repository.saveMapping).toHaveBeenCalledWith({
        orgId: 'org-1',
        batchId: 'batch-1',
        userId: 'user-1',
        headerSignature: headerSignature(HEADERS),
        mapping: {
          dictionaryVersion: MAPPING_DICTIONARY_VERSION,
          confirmed: true,
          columns: expect.objectContaining({
            phone: 'Phone',
            customerName: ['Name'],
            notes: 'Notes',
            city: null,
          }) as object,
          sources: expect.objectContaining({
            phone: 'merchant',
            city: 'none',
          }) as object,
        },
        options: {
          country: 'EG',
          defaultCurrency: 'EGP',
          dateFormat: 'auto',
          paymentValueMap: {},
        },
        profile: {
          mapping: {
            dictionaryVersion: MAPPING_DICTIONARY_VERSION,
            columns: expect.objectContaining({ phone: 'Phone' }) as object,
          },
          options: expect.objectContaining({ country: 'EG' }) as object,
        },
        now: expect.any(Date) as Date,
      });
      expect(rowValidation.validateBatch).toHaveBeenCalledWith(
        { orgId: 'org-1', source },
        'batch-1',
      );
      expect(repository.saveMapping.mock.invocationCallOrder[0]).toBeLessThan(
        rowValidation.validateBatch.mock.invocationCallOrder[0],
      );
      expect(response).toMatchObject({
        batchId: 'batch-1',
        status: 'draft',
        mappingProfileId: 'profile-1',
        unmappedColumns: ['Payment', 'Date'],
        counts: { ready: 0 },
      });
    });

    it('keeps the detected or saved origin of untouched fields, and is stable on re-save', async () => {
      repository.findBatchForMapping.mockResolvedValue(
        draft({
          mapping: {
            dictionaryVersion: 1,
            confirmed: false,
            columns: {
              phone: 'Phone',
              customerName: ['Name'],
              amount: 'Total',
              notes: null,
            },
            sources: {
              phone: 'auto',
              customerName: 'saved',
              amount: 'auto',
              notes: 'none',
            },
          },
        }),
      );
      const first = await service.save(
        owner,
        source,
        'batch-1',
        body({ mapping: { amount: 'Notes' } }),
      );
      expect(first.sources).toMatchObject({
        phone: 'auto',
        customerName: 'saved',
        amount: 'merchant',
        notes: 'none',
      });

      const stored = (
        repository.saveMapping.mock.calls[0] as [{ mapping: unknown }]
      )[0].mapping;
      repository.findBatchForMapping.mockResolvedValue(
        draft({ mapping: stored }),
      );
      const second = await service.save(
        owner,
        source,
        'batch-1',
        body({ mapping: { amount: 'Notes' } }),
      );
      expect(second).toEqual(first);
    });
  });

  describe('suggest (upload)', () => {
    const rows = [
      { cells: ['010', 'Ahmed', '100', 'COD', '05/06/2026', ''] },
      { cells: ['011', 'Sara', '200', 'Other', '01/02/2026', ''] },
    ];

    it("defaults to the store's country and shipping currency", async () => {
      const suggestion = await service.suggest('org-1', source, HEADERS, rows);
      expect(suggestion.options).toEqual({
        country: 'SA',
        defaultCurrency: 'SAR',
        dateFormat: 'auto',
        paymentValueMap: {},
      });
      expect(suggestion.response).toMatchObject({
        mappingProfileApplied: false,
        headerSignature: headerSignature(HEADERS),
        paymentValues: {
          column: 'Payment',
          values: [
            { normalizedValue: 'cod', classification: 'cod' },
            { normalizedValue: 'other', classification: 'unknown' },
          ],
        },
        dateFormat: { column: 'Date', ambiguous: true },
      });
      expect(suggestion.mapping).toMatchObject({
        confirmed: false,
        columns: { phone: 'Phone', customerName: ['Name'], amount: 'Total' },
      });
      expect(suggestion.mappingProfileId).toBeNull();
      expect(repository.findMappingProfile).toHaveBeenCalledWith(
        'org-1',
        headerSignature(HEADERS),
      );
    });

    it.each([
      [{ countryCode: null, shippingCurrency: 'USD' }, 'EG', 'USD'],
      [{ countryCode: 'Egypt', shippingCurrency: 'XYZ' }, 'EG', 'USD'],
      [{ countryCode: 'ae', shippingCurrency: ' aed ' }, 'AE', 'AED'],
    ])('falls back per option: %j', (store, country, currency) => {
      expect(defaultImportOptions(store as never)).toMatchObject({
        country,
        defaultCurrency: currency,
      });
    });

    it('auto-applies a saved profile for the same headers', async () => {
      repository.findMappingProfile.mockResolvedValue({
        id: 'profile-9',
        mapping: {
          dictionaryVersion: 1,
          columns: {
            phone: 'Phone',
            customerName: ['Name'],
            amount: 'Total',
            notes: 'Notes',
            orderDate: null,
          },
        },
        options: {
          country: 'AE',
          defaultCurrency: 'AED',
          dateFormat: 'DMY',
          paymentValueMap: { other: 'cod', gone: 'not_cod' },
        },
      });
      const suggestion = await service.suggest('org-1', source, HEADERS, rows);
      const fields = Object.fromEntries(
        suggestion.response.suggestions.fields.map((field) => [
          field.field,
          field,
        ]),
      );
      expect(fields.notes).toMatchObject({
        columns: ['Notes'],
        source: 'saved',
      });
      expect(fields.orderDate).toMatchObject({ columns: [], source: 'saved' });
      expect(fields.paymentMethod).toMatchObject({
        columns: ['Payment'],
        source: 'auto',
      });
      expect(suggestion.options).toEqual({
        country: 'AE',
        defaultCurrency: 'AED',
        dateFormat: 'DMY',
        paymentValueMap: { other: 'cod' },
      });
      expect(suggestion.response.paymentValues?.values[1]).toMatchObject({
        normalizedValue: 'other',
        classification: 'cod',
        source: 'saved',
      });
      expect(suggestion.response.mappingProfileApplied).toBe(true);
      expect(suggestion.mappingProfileId).toBe('profile-9');
      expect(suggestion.mapping.sources.notes).toBe('saved');
    });

    it('applies a profile partially when a saved header is missing', async () => {
      repository.findMappingProfile.mockResolvedValue({
        id: 'profile-9',
        mapping: {
          columns: { phone: 'WhatsApp', customerName: ['Name'] },
        },
        options: { country: 'lowercase-bad', defaultCurrency: 'XYZ' },
      });
      const suggestion = await service.suggest('org-1', source, HEADERS, rows);
      const fields = Object.fromEntries(
        suggestion.response.suggestions.fields.map((field) => [
          field.field,
          field,
        ]),
      );
      expect(fields.phone).toMatchObject({
        columns: ['Phone'],
        source: 'auto',
      });
      expect(fields.customerName).toMatchObject({
        columns: ['Name'],
        source: 'saved',
      });
      // Invalid saved options fall back to the store's defaults.
      expect(suggestion.options).toMatchObject({
        country: 'SA',
        defaultCurrency: 'SAR',
      });
    });
  });
});
