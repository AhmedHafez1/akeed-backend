import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ImportFileParser, parseInWorker } from './import-file-parser';
import { ImportFileError } from './import-file.error';

const FIXTURES = resolve(__dirname, '../../../../test/fixtures/order-imports');
const LIMITS = {
  maxRows: 5_000,
  maxColumns: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  parseTimeoutMs: 20_000,
};

function fixture(file: string): Buffer {
  return readFileSync(join(FIXTURES, file));
}

describe('parseInWorker', () => {
  jest.setTimeout(30_000);

  it('returns the same grid as the in-process parser', async () => {
    const parsed = await parseInWorker(fixture('arabic-excel.xlsx'), LIMITS);
    expect(parsed.sheetName).toBe('الطلبات');
    expect(parsed.grid.rows).toHaveLength(2);
  });

  it('carries file refusals back with their code and reason', async () => {
    await expect(
      parseInWorker(fixture('protected.xlsx'), LIMITS),
    ).rejects.toEqual(
      new ImportFileError('IMPORT_FILE_PROTECTED', 'encrypted_package'),
    );
    await expect(
      parseInWorker(fixture('zip-bomb.xlsx'), LIMITS),
    ).rejects.toMatchObject({
      code: 'IMPORT_FILE_UNREADABLE',
      reason: 'uncompressed_limit',
    });
  });

  it('terminates a parse that exceeds its time budget', async () => {
    await expect(
      parseInWorker(fixture('rows-5000.csv'), { ...LIMITS, parseTimeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: 'IMPORT_FILE_UNREADABLE',
      reason: 'parse_timeout',
    });
  });

  it('queues parses beyond the concurrency cap and finishes them all', async () => {
    const parser = new ImportFileParser();
    const results = await Promise.all(
      [
        'semicolon.csv',
        'formulas.xlsx',
        'windows-1256.csv',
        'merged-cells.xlsx',
      ].map((file) => parser.parse(fixture(file), LIMITS)),
    );
    expect(results.map((result) => result.format)).toEqual([
      'csv',
      'xlsx',
      'csv',
      'xlsx',
    ]);
  });
});
