import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ImportManifest } from '../../../scripts/order-import-fixtures/build-fixtures';
import { StandaloneOrderEligibilityStrategy } from '../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
} from '../../shared/config/bulk-import.config';
import { PhoneService } from '../../shared/services/phone.service';
import { OrderEligibilityService } from '../verification-core/order-eligibility.service';
import { IMPORT_FIELDS } from './mapping/alias-dictionary';
import { matchColumns } from './mapping/column-matcher';
import { detectDateAmbiguity } from './mapping/date-ambiguity';
import {
  mappingFromSuggestions,
  type ImportColumnMapping,
} from './mapping/mapping-rules';
import {
  classifyPaymentValue,
  normalizePaymentValue,
} from './mapping/payment-value-classifier';
import { ImportFileError } from './parsers/import-file.error';
import { parseImportFile } from './parsers/parse-import-file';
import { RowValidationService } from './validation/row-validation.service';

const FIXTURES = resolve(__dirname, '../../../test/fixtures/order-imports');
const LIMITS = {
  maxRows: 5_000,
  maxColumns: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  parseTimeoutMs: 20_000,
};
/** Rows the upload shows the column matcher (order-import-mapping.service). */
const MATCHER_SAMPLE_ROWS = 20;

/** The US-04.6-10 AC1 pack, in the story's order. */
const AC1_FILES = [
  'arabic-excel.xlsx',
  'unicode-text-utf16le.csv',
  'windows-1256.csv',
  'semicolon-eu.csv',
  'utf8-bom-multiline-quotes.csv',
  'shopify-orders-export.csv',
  'no-reference.csv',
  'mixed-payments.csv',
  'old-and-future-dates.xlsx',
  '5000-rows.csv',
  '5001-rows.csv',
  '101-columns.csv',
  'zip-bomb.xlsx',
  'protected.xlsx',
  'macro.xlsm',
  'legacy.xls',
  'pdf-renamed.csv',
  'formula-injection.csv',
  'scientific-phones.xlsx',
];

interface WrittenRow {
  rowNumber: number;
  outcome: string;
  issues: { code: string }[];
  collapsedInto: number | null;
  normalized: Record<string, unknown>;
}

export function readManifest(file: string): ImportManifest {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${file}.manifest.json`), 'utf8'),
  ) as ImportManifest;
}

export function manifestMapping(manifest: ImportManifest): ImportColumnMapping {
  const mapping = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, manifest.mapping?.[field] ?? null]),
  ) as ImportColumnMapping;
  mapping.customerName = (manifest.mapping?.customerName as string[]) ?? [];
  return mapping;
}

/** The merchant's payment corrections, keyed as the batch stores them. */
export function manifestPaymentValueMap(
  manifest: ImportManifest,
): Record<string, 'cod' | 'not_cod'> {
  return Object.fromEntries(
    Object.entries(manifest.paymentValueMap ?? {}).map(([value, choice]) => [
      normalizePaymentValue(value),
      choice,
    ]),
  );
}

/**
 * Runs one parsed file through the real row validation, exactly as a saved
 * mapping does, with no existing orders for the source (L1/L3 against real
 * orders are proven by the release-gate PostgreSQL suite).
 */
async function validate(
  manifest: ImportManifest,
  rows: { rowNumber: number; raw: Record<string, string>; issues: unknown }[],
): Promise<WrittenRow[]> {
  const repository = {
    findBatchForValidation: jest.fn().mockResolvedValue({
      status: 'draft',
      integrationId: 'int-1',
      mapping: { confirmed: true, columns: manifestMapping(manifest) },
      options: {
        country: manifest.country,
        defaultCurrency: manifest.defaultCurrency,
        dateFormat: manifest.dateFormat ?? 'auto',
        paymentValueMap: manifestPaymentValueMap(manifest),
      },
    }),
    listRowsForValidation: jest.fn().mockResolvedValue(rows),
    findOrdersByExternalIds: jest.fn().mockResolvedValue([]),
    findRecentOrdersByPhones: jest.fn().mockResolvedValue([]),
    findRecentOrdersByOrderNumbers: jest.fn().mockResolvedValue([]),
    writeValidation: jest.fn().mockResolvedValue('saved'),
  };
  const service = new RowValidationService(
    repository as never,
    new PhoneService(),
    new OrderEligibilityService([new StandaloneOrderEligibilityStrategy()]),
    {
      get: (key: string) =>
        key === BULK_IMPORT_CONFIG ? parseBulkImportConfig({}) : undefined,
    } as never,
  );
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    timezone: manifest.timezone,
    assumeCodWhenPaymentMissing: manifest.assumeCodWhenPaymentMissing,
  } as never;
  await service.validateBatch(
    { orgId: 'org-1', source },
    'batch-1',
    new Date(manifest.now),
  );
  return (
    repository.writeValidation.mock.calls[0] as [{ rows: WrittenRow[] }]
  )[0].rows;
}

/**
 * US-04.6-10 AC1: every file of the fixture pack turns into the outcome its
 * hand-written manifest says: the file-level refusal, or each row's outcome,
 * issue codes and pinned normalized values, with the columns the upload
 * detects and the payment and date choices the mapping step requires.
 */
describe('order-import fixture manifests (US-04.6-10 AC1)', () => {
  const index = JSON.parse(
    readFileSync(join(FIXTURES, 'index.json'), 'utf8'),
  ) as { file: string; manifest: boolean }[];

  it('has a manifest for every file the story lists', () => {
    const withManifest = index
      .filter((entry) => entry.manifest)
      .map((entry) => entry.file);
    expect([...withManifest].sort()).toEqual([...AC1_FILES].sort());
  });

  it.each(AC1_FILES)('%s', async (file) => {
    const manifest = readManifest(file);
    const bytes = readFileSync(join(FIXTURES, file));

    if (manifest.fileError) {
      let thrown: unknown;
      try {
        parseImportFile(bytes, LIMITS);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ImportFileError);
      expect((thrown as ImportFileError).code).toBe(manifest.fileError);
      return;
    }

    const { grid } = parseImportFile(bytes, LIMITS);
    const mapping = manifestMapping(manifest);
    if (manifest.autoMapped)
      expect(
        mappingFromSuggestions(
          matchColumns(
            grid.headers,
            grid.rows.slice(0, MATCHER_SAMPLE_ROWS).map((row) => row.cells),
          ).fields,
        ),
      ).toEqual(mapping);

    const column = (name: string | null) =>
      name ? grid.rows.map((row) => row.cells[grid.headers.indexOf(name)]) : [];
    // The mapping step refuses to save until every unknown payment value is
    // classified and an ambiguous date column has a format (US-04.6-03 AC5).
    const corrections = manifestPaymentValueMap(manifest);
    const unresolved = [...new Set(column(mapping.paymentMethod))].filter(
      (value) =>
        value &&
        classifyPaymentValue(value) === 'unknown' &&
        !corrections[normalizePaymentValue(value)],
    );
    expect(unresolved).toEqual([]);
    if (detectDateAmbiguity(column(mapping.orderDate)).ambiguous)
      expect(manifest.dateFormat).not.toBe('auto');

    const written = await validate(
      manifest,
      grid.rows.map((row) => ({
        rowNumber: row.rowNumber,
        raw: Object.fromEntries(
          grid.headers.map((header, i) => [header, row.cells[i]]),
        ),
        issues: row.issues,
      })),
    );

    if (manifest.rowCounts) {
      const counts: Record<string, number> = {};
      for (const row of written)
        counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
      expect(counts).toEqual(manifest.rowCounts);
    }
    const byNumber = new Map(written.map((row) => [row.rowNumber, row]));
    if (!manifest.rowsAreSample)
      expect(written.map((row) => row.rowNumber)).toEqual(
        manifest.rows!.map((row) => row.rowNumber),
      );
    for (const want of manifest.rows ?? []) {
      const got = byNumber.get(want.rowNumber);
      expect({
        rowNumber: want.rowNumber,
        outcome: got?.outcome,
        issues: got?.issues.map((issue) => issue.code).sort(),
        collapsedInto: got?.collapsedInto ?? undefined,
      }).toEqual({
        rowNumber: want.rowNumber,
        outcome: want.outcome,
        issues: [...want.issues].sort(),
        collapsedInto: want.collapsedInto,
      });
      if (want.normalized)
        expect(got?.normalized).toMatchObject(want.normalized);
    }
  });
});
