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
    expect(parsed.grid.rows).toHaveLength(8);
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
      parseInWorker(fixture('5000-rows.csv'), { ...LIMITS, parseTimeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: 'IMPORT_FILE_UNREADABLE',
      reason: 'parse_timeout',
    });
  });

  /**
   * US-04.6-09: a 5 MB line with no delimiter, or one quote never closed,
   * is the input most likely to make a parser crawl. Under the real 20 s cap
   * it settles, as a grid or a file refusal, and never hangs; under a spent
   * budget the worker is terminated with IMPORT_FILE_UNREADABLE.
   */
  describe('pathological input', () => {
    const FIVE_MB = 5 * 1024 * 1024;
    const inputs: [string, Buffer][] = [
      ['one 5 MB line without a delimiter', Buffer.alloc(FIVE_MB, 0x61)],
      [
        'a quote opened on line one and never closed',
        Buffer.concat([
          Buffer.from('order_id,name\r\n"A-1,'),
          Buffer.alloc(FIVE_MB - 20, 0x61),
        ]),
      ],
    ];

    it.each(inputs)(
      'settles within the 20 s cap for %s',
      async (_label, bytes) => {
        const startedAt = Date.now();
        const outcome = await parseInWorker(bytes, LIMITS).then(
          (parsed) => ({ parsed }),
          (error: unknown) => ({ error }),
        );
        expect(Date.now() - startedAt).toBeLessThan(
          LIMITS.parseTimeoutMs + 1_000,
        );
        if ('error' in outcome)
          expect(outcome.error).toBeInstanceOf(ImportFileError);
        else expect(outcome.parsed.format).toBe('csv');
      },
    );

    it.each(inputs)(
      'is terminated with IMPORT_FILE_UNREADABLE once the budget is spent, for %s',
      async (_label, bytes) => {
        const startedAt = Date.now();
        await expect(
          parseInWorker(bytes, { ...LIMITS, parseTimeoutMs: 25 }),
        ).rejects.toMatchObject({
          code: 'IMPORT_FILE_UNREADABLE',
          reason: 'parse_timeout',
        });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      },
    );
  });

  it('queues parses beyond the concurrency cap and finishes them all', async () => {
    const parser = new ImportFileParser();
    const results = await Promise.all(
      [
        'semicolon-eu.csv',
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
