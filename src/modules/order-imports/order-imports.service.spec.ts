import { read, utils } from 'xlsx';
import { OrderImportDraftLimitError } from '../../infrastructure/database/repositories/order-imports.repository';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
} from '../../shared/config/bulk-import.config';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { MAPPING_DICTIONARY_VERSION } from './mapping/alias-dictionary';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportsService } from './order-imports.service';
import { RowValidationService } from './validation/row-validation.service';
import { ImportFileError } from './parsers/import-file.error';
import { parseImportFile } from './parsers/parse-import-file';

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};
const source = { id: 'int-1', orgId: 'org-1' } as never;
const draft = {
  batchId: 'batch-old',
  fileName: 'old.csv',
  rowCount: 3,
  createdAt: '2026-09-19T08:00:00.000Z',
  expiresAt: '2026-09-20T08:00:00.000Z',
};

function file(text: string, originalname = 'orders.csv') {
  const buffer = Buffer.from(text, 'utf8');
  return { buffer, size: buffer.length, originalname };
}

function httpError(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
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

describe('OrderImportsService', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === BULK_IMPORT_CONFIG
        ? parseBulkImportConfig({
            STANDALONE_BULK_IMPORT_ENABLED: 'true',
            BULK_IMPORT_QUOTE_SECRET: 'test-quote-secret-0123456789abcdef',
          })
        : undefined,
    ),
  };
  const repository = {
    listOpenDrafts: jest.fn(),
    createDraftWithRows: jest.fn(),
    discardDraft: jest.fn(),
    findMappingProfile: jest.fn(),
  };
  // The in-process parser: the worker wrapper has its own spec.
  const parser = {
    parse: jest.fn(
      (bytes: Buffer, limits: Parameters<typeof parseImportFile>[1]) =>
        Promise.resolve(parseImportFile(bytes, limits)),
    ),
  };
  const service = new OrderImportsService(
    repository as never,
    parser as never,
    config as never,
    new OrderImportMappingService(
      repository as never,
      // Upload only suggests a mapping; it never validates rows.
      { validateBatch: jest.fn() } as unknown as RowValidationService,
    ),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findMappingProfile.mockResolvedValue(null);
    repository.listOpenDrafts.mockResolvedValue([]);
    repository.createDraftWithRows.mockResolvedValue({
      batchId: 'batch-1',
      shortCode: 'ABC123',
      createdAt: '2026-09-19T09:00:00.000Z',
      duplicateFileOf: null,
    });
  });

  describe('upload', () => {
    it('refuses a missing file', async () => {
      await expect(
        failure(service.upload(owner, source, undefined)),
      ).resolves.toMatchObject({
        status: 400,
        body: { code: 'IMPORT_FILE_REQUIRED' },
      });
      expect(repository.listOpenDrafts).not.toHaveBeenCalled();
    });

    it('persists the parsed rows and answers the AC8 shape', async () => {
      const csv =
        'order_id,name,phone\r\n' +
        Array.from(
          { length: 7 },
          (_, index) => `A-${index},Name ${index},0100${index}`,
        ).join('\r\n');
      const response = await service.upload(
        owner,
        source,
        file(csv, '../C:\\x\\orders.csv'),
      );

      expect(response).toMatchObject({
        batchId: 'batch-1',
        status: 'draft',
        fileName: 'orders.csv',
        format: 'csv',
        encoding: 'utf-8',
        delimiter: ',',
        sheetName: null,
        ignoredSheets: [],
        headers: ['order_id', 'name', 'phone'],
        rowCount: 7,
        sampleRows: Array.from({ length: 5 }, (_, index) => ({
          rowNumber: index + 2,
          raw: {
            order_id: `A-${index}`,
            name: `Name ${index}`,
            phone: `0100${index}`,
          },
          issues: [],
        })),
        // US-04.6-03: detected mapping and the store's default options.
        mappingDictionaryVersion: MAPPING_DICTIONARY_VERSION,
        mappingProfileApplied: false,
        options: {
          country: 'EG',
          defaultCurrency: 'USD',
          dateFormat: 'auto',
          paymentValueMap: {},
        },
        paymentValues: null,
        dateFormat: null,
      });
      expect(response).not.toHaveProperty('duplicateFileOf');
      expect(
        Object.fromEntries(
          response.suggestions.fields.map((field) => [
            field.field,
            field.columns,
          ]),
        ),
      ).toMatchObject({
        phone: ['phone'],
        customerName: ['name'],
        orderReference: ['order_id'],
        amount: [],
      });
      expect(response.suggestions.unmappedColumns).toEqual([]);
      const [batch, rows, options] = repository.createDraftWithRows.mock
        .calls[0] as [
        Record<string, unknown>,
        unknown[],
        Record<string, unknown>,
      ];
      expect(batch).toMatchObject({
        orgId: 'org-1',
        integrationId: 'int-1',
        createdBy: 'user-1',
        fileName: 'orders.csv',
        fileFormat: 'csv',
        encoding: 'utf-8',
        delimiter: ',',
        headers: ['order_id', 'name', 'phone'],
        fileSize: Buffer.byteLength(csv),
        mapping: {
          dictionaryVersion: MAPPING_DICTIONARY_VERSION,
          confirmed: false,
          columns: { phone: 'phone', customerName: ['name'], amount: null },
          sources: { phone: 'auto', amount: 'none' },
        },
        options: { country: 'EG', defaultCurrency: 'USD' },
        mappingProfileId: null,
      });
      expect(batch.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((batch.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(
        24 * 3_600_000 - 60_000,
      );
      expect(rows).toHaveLength(7);
      expect(options).toMatchObject({ maxOpenDrafts: 3 });
    });

    it('reports a same-file upload as a warning, not an error', async () => {
      repository.createDraftWithRows.mockResolvedValue({
        batchId: 'batch-2',
        shortCode: 'XYZ789',
        createdAt: '2026-09-19T09:00:01.000Z',
        duplicateFileOf: {
          batchId: 'batch-1',
          createdAt: '2026-09-19T09:00:00.000Z',
          status: 'draft',
        },
      });
      const response = await service.upload(owner, source, file('a,b\n1,2'));
      expect(response.duplicateFileOf).toEqual({
        batchId: 'batch-1',
        createdAt: '2026-09-19T09:00:00.000Z',
        status: 'draft',
      });
    });

    it('refuses a fourth open draft before parsing and lists the open ones', async () => {
      repository.listOpenDrafts.mockResolvedValue([draft, draft, draft]);
      await expect(
        failure(service.upload(owner, source, file('a,b\n1,2'))),
      ).resolves.toEqual({
        status: 409,
        body: expect.objectContaining({
          code: 'IMPORT_TOO_MANY_DRAFTS',
          drafts: [draft, draft, draft],
        }) as unknown,
      });
      expect(parser.parse).not.toHaveBeenCalled();
      expect(repository.createDraftWithRows).not.toHaveBeenCalled();
    });

    it('answers the draft cap when a concurrent upload won the last slot', async () => {
      repository.createDraftWithRows.mockRejectedValue(
        new OrderImportDraftLimitError([draft, draft, draft]),
      );
      await expect(
        failure(service.upload(owner, source, file('a,b\n1,2'))),
      ).resolves.toMatchObject({
        status: 409,
        body: { code: 'IMPORT_TOO_MANY_DRAFTS' },
      });
    });

    it.each([
      ['a header-only file', 'a,b\r\n', 422, 'IMPORT_FILE_EMPTY'],
      ['a renamed PDF', '%PDF-1.4\n%%EOF', 422, 'IMPORT_FILE_UNREADABLE'],
    ])('persists nothing for %s', async (_label, text, status, code) => {
      await expect(
        failure(service.upload(owner, source, file(text))),
      ).resolves.toMatchObject({
        status,
        body: { statusCode: status, code },
      });
      expect(repository.createDraftWithRows).not.toHaveBeenCalled();
    });

    it.each([
      ['IMPORT_FILE_TYPE_UNSUPPORTED', 415],
      ['IMPORT_FILE_PROTECTED', 422],
      ['IMPORT_ROW_LIMIT_EXCEEDED', 422],
      ['IMPORT_COLUMN_LIMIT_EXCEEDED', 422],
    ] as const)('maps %s to %i', async (code, status) => {
      parser.parse.mockRejectedValueOnce(
        new ImportFileError(code, 'row_limit'),
      );
      await expect(
        failure(service.upload(owner, source, file('a\n1'))),
      ).resolves.toMatchObject({
        status,
        body: { code },
      });
    });

    it('answers unreadable, without library detail, when the parser crashes', async () => {
      parser.parse.mockRejectedValueOnce(
        new Error('internal SheetJS detail with cell text'),
      );
      const refusal = await failure(
        service.upload(owner, source, file('a\n1')),
      );
      expect(refusal).toMatchObject({
        status: 422,
        body: { code: 'IMPORT_FILE_UNREADABLE' },
      });
      expect(JSON.stringify(refusal.body)).not.toContain('SheetJS');
    });
  });

  describe('discard', () => {
    it('discards a draft', async () => {
      repository.discardDraft.mockResolvedValue({ outcome: 'discarded' });
      await expect(service.discard(owner, 'batch-1')).resolves.toBeUndefined();
      expect(repository.discardDraft).toHaveBeenCalledWith('org-1', 'batch-1');
    });

    it('answers 404 for another organization or an unknown batch', async () => {
      repository.discardDraft.mockResolvedValue({ outcome: 'not_found' });
      await expect(
        failure(service.discard(owner, 'batch-x')),
      ).resolves.toMatchObject({
        status: 404,
        body: { code: 'IMPORT_BATCH_NOT_FOUND' },
      });
    });

    it('refuses to discard a batch that is past draft', async () => {
      repository.discardDraft.mockResolvedValue({
        outcome: 'state_conflict',
        status: 'awaiting_start',
      });
      await expect(
        failure(service.discard(owner, 'batch-1')),
      ).resolves.toMatchObject({
        status: 409,
        body: { code: 'IMPORT_BATCH_STATE_CONFLICT', status: 'awaiting_start' },
      });
    });
  });

  describe('template', () => {
    const englishHeaders = [
      'order_id',
      'customer_name',
      'phone',
      'amount',
      'currency',
      'payment_method',
      'order_date',
      'city',
      'address',
      'notes',
    ];

    it('writes a UTF-8 BOM CSV with the canonical headers and two Egyptian rows', () => {
      const template = service.template('csv', 'en');
      expect(template.fileName).toBe('akeed-orders-template-en.csv');
      expect(template.body.subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
      const lines = template.body.toString('utf8').slice(1).split('\r\n');
      expect(lines[0]).toBe(englishHeaders.join(','));
      expect(lines.filter(Boolean)).toHaveLength(3);
      expect(lines[1]).toContain('01001234567');
      expect(lines[1]).toContain('EGP');
    });

    it('labels headers in Arabic and parses back through the import reader', () => {
      for (const format of ['csv', 'xlsx'] as const) {
        const template = service.template(format, 'ar');
        const parsed = parseImportFile(template.body, {
          maxRows: 5_000,
          maxColumns: 100,
          maxUncompressedBytes: 50 * 1024 * 1024,
          parseTimeoutMs: 20_000,
        });
        expect(parsed.format).toBe(format);
        expect(parsed.grid.headers[0]).toBe('رقم الطلب');
        expect(parsed.grid.headers).toHaveLength(10);
        expect(parsed.grid.rows).toHaveLength(2);
        // The phone keeps its leading zero in both formats.
        expect(parsed.grid.rows[0].cells[2]).toBe('01001234567');
      }
    });

    it('marks the Arabic workbook right-to-left', () => {
      const book = read(service.template('xlsx', 'ar').body, {
        type: 'buffer',
      });
      expect(book.SheetNames).toEqual(['الطلبات']);
      expect(book.Workbook?.Views?.[0]?.RTL).toBe(true);
      expect(utils.sheet_to_json(book.Sheets['الطلبات'])).toHaveLength(2);
    });

    it('defaults to an English CSV and refuses unknown values', () => {
      expect(service.template(undefined, undefined).fileName).toBe(
        'akeed-orders-template-en.csv',
      );
      let refusal: ReturnType<typeof httpError> | undefined;
      try {
        service.template('pdf', 'fr');
      } catch (error) {
        refusal = httpError(error);
      }
      expect(refusal).toMatchObject({
        status: 400,
        body: {
          code: 'IMPORT_VALIDATION_FAILED',
          fieldErrors: {
            format: 'format must be csv or xlsx.',
            locale: 'locale must be ar or en.',
          },
        },
      });
    });
  });
});
