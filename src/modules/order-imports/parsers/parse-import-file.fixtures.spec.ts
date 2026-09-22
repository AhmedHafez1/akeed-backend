import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ExpectedRow,
  FixtureExpectation,
} from '../../../../scripts/order-import-fixtures/build-fixtures';
import { ImportFileError } from './import-file.error';
import { parseImportFile, type ImportParseLimits } from './parse-import-file';

const FIXTURES = resolve(__dirname, '../../../../test/fixtures/order-imports');
// The module object every CommonJS caller, SheetJS included, reads through.
const nodeFs = jest.requireActual<typeof import('node:fs')>('node:fs');

const STORY_LIMITS: ImportParseLimits = {
  maxRows: 5_000,
  maxColumns: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  parseTimeoutMs: 20_000,
};

const index = JSON.parse(
  readFileSync(join(FIXTURES, 'index.json'), 'utf8'),
) as { file: string; description: string }[];

function expectationOf(file: string): FixtureExpectation {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${file}.expected.json`), 'utf8'),
  ) as FixtureExpectation;
}

function parse(file: string) {
  return parseImportFile(readFileSync(join(FIXTURES, file)), STORY_LIMITS);
}

/**
 * Every committed fixture parses to its hand-written expectation. Regenerate
 * with `npm run fixtures:order-imports` after changing the builder.
 */
describe('order-import fixtures', () => {
  it('covers every quirk the story and the epic catalogue name', () => {
    expect(index.map(({ file }) => file).sort()).toEqual(
      expect.arrayContaining([
        'unicode-text-utf16le.csv',
        'windows-1256.csv',
        'semicolon-eu.csv',
        'utf8-bom-multiline-quotes.csv',
        'malformed-quote.csv',
        'mixed-shape.csv',
        'hidden-first-sheet.xlsx',
        'merged-cells.xlsx',
        'formulas.xlsx',
        'serial-dates.xlsx',
        'number-phones.xlsx',
        'formatted-empty-rows.xlsx',
        'protected.xlsx',
        'macro.xlsm',
        'external-link.xlsx',
        'legacy.xls',
        'pdf-renamed.csv',
        'xlsx-renamed.csv',
        'csv-renamed.xlsx',
        'zip-bomb.xlsx',
        '5000-rows.csv',
        '5001-rows.csv',
        'cols-100.csv',
        '101-columns.csv',
        'header-only.csv',
        'blank-only.csv',
        'zero-bytes.csv',
      ]),
    );
  });

  it.each(index.map(({ file, description }) => [file, description]))(
    '%s — %s',
    (file) => {
      const expected = expectationOf(file);
      if ('error' in expected) {
        let thrown: unknown;
        try {
          parse(file);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ImportFileError);
        expect((thrown as ImportFileError).code).toBe(expected.error);
        return;
      }

      const parsed = parse(file);
      expect({
        format: parsed.format,
        encoding: parsed.encoding,
        delimiter: parsed.delimiter,
        sheetName: parsed.sheetName,
        ignoredSheets: parsed.ignoredSheets,
        headers: parsed.grid.headers,
        rowCount: parsed.grid.rows.length,
      }).toEqual({
        format: expected.format,
        encoding: expected.encoding,
        delimiter: expected.delimiter,
        sheetName: expected.sheetName,
        ignoredSheets: expected.ignoredSheets,
        headers: expected.headers,
        rowCount: expected.rowCount,
      });
      const actualRows = parsed.grid.rows.map(
        (row): ExpectedRow => ({
          rowNumber: row.rowNumber,
          cells: row.cells,
          ...(row.issues.length ? { issues: row.issues } : {}),
        }),
      );
      if (expected.rowsAreSample) {
        for (const row of expected.rows)
          expect(
            actualRows.find(({ rowNumber }) => rowNumber === row.rowNumber),
          ).toEqual(row);
      } else {
        expect(actualRows).toEqual(expected.rows);
      }
    },
  );

  /**
   * US-04.6-09: an external link is data about another file, never a path to
   * open, and an embedded object is never read. Nothing touches the disk
   * while the workbook is parsed.
   */
  it('never opens a file while reading a workbook with an external link and an embedded object', () => {
    const bytes = readFileSync(join(FIXTURES, 'external-link.xlsx'));
    const spies = (
      [
        'readFileSync',
        'openSync',
        'existsSync',
        'statSync',
        'createReadStream',
      ] as const
    ).map((name) => jest.spyOn(nodeFs, name));
    try {
      const parsed = parseImportFile(bytes, STORY_LIMITS);
      expect(parsed.grid.rows[0].cells).toEqual(['A-1', '250', '42']);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
