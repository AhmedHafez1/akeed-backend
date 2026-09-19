import { utils, write } from 'xlsx';
import { parseImportFile } from './parse-import-file';

const LIMITS = {
  maxRows: 5_000,
  maxColumns: 100,
  maxUncompressedBytes: 50 * 1024 * 1024,
  parseTimeoutMs: 20_000,
};

function table(rows: number, columns: number): string[][] {
  return [
    Array.from({ length: columns }, (_, column) => `column_${column + 1}`),
    ...Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) =>
        column === 1
          ? `0100${String(row).padStart(7, '0')}`
          : `r${row}c${column}`,
      ),
    ),
  ];
}

function csv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((row) => row.join(',')).join('\r\n'), 'utf8');
}

function xlsx(rows: string[][]): Buffer {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), 'Orders');
  return write(book, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Buffer;
}

function timed(bytes: Buffer): number {
  // One warm-up run so the measurement is the parse, not module loading/JIT.
  parseImportFile(bytes, LIMITS);
  const started = process.hrtime.bigint();
  const parsed = parseImportFile(bytes, LIMITS);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  expect(parsed.grid.rows).toHaveLength(5_000);
  return elapsed;
}

/**
 * Story budget: 5,000 × 20 in under 1 s. 5,000 × 100 is measured to decide
 * whether parsing must move off the request's event loop (recorded in the
 * story evidence).
 */
describe('parse timing', () => {
  const report: Record<string, string> = {};
  afterAll(() => {
    console.info(`order-import parse timing (ms): ${JSON.stringify(report)}`);
  });

  it('parses a 5,000 × 20 CSV in under 1 s', () => {
    const ms = timed(csv(table(5_000, 20)));
    report['csv 5000x20'] = ms.toFixed(1);
    expect(ms).toBeLessThan(1_000);
  });

  it('parses a 5,000 × 20 XLSX in under 1 s', () => {
    const ms = timed(xlsx(table(5_000, 20)));
    report['xlsx 5000x20'] = ms.toFixed(1);
    expect(ms).toBeLessThan(1_000);
  });

  it('measures 5,000 × 100 for CSV and XLSX', () => {
    report['csv 5000x100'] = timed(csv(table(5_000, 100))).toFixed(1);
    report['xlsx 5000x100'] = timed(xlsx(table(5_000, 100))).toFixed(1);
  });
});
