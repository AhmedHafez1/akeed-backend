import { parseCsvGrid } from './csv-grid.parser';
import { sniffImportFile } from './file-sniffer';
import type { ParsedImportFile } from './grid.types';
import { normalizeGrid } from './header-normalizer';
import { createDeadline } from './import-file.error';
import { decodeImportText } from './text-decoder';
import { parseXlsxGrid } from './xlsx-grid.parser';

export interface ImportParseLimits {
  maxRows: number;
  maxColumns: number;
  maxUncompressedBytes: number;
  parseTimeoutMs: number;
}

/**
 * Reads an uploaded file exactly once: sniff the bytes, guard the package
 * size, decode, parse the first visible sheet or the CSV, then apply the
 * header rules. Throws `ImportFileError` for every file-level refusal, and
 * never touches I/O, so every quirk is testable from bytes alone.
 */
export function parseImportFile(
  bytes: Buffer,
  limits: ImportParseLimits,
  now: () => number = Date.now,
): ParsedImportFile {
  const checkDeadline = createDeadline(limits.parseTimeoutMs, now);
  const readLimits = { maxNonEmptyRows: limits.maxRows + 1, checkDeadline };
  const sniffed = sniffImportFile(
    bytes,
    limits.maxUncompressedBytes,
    checkDeadline,
  );

  if (sniffed.kind === 'xlsx') {
    const sheet = parseXlsxGrid(bytes, readLimits);
    return {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: sheet.sheetName,
      ignoredSheets: sheet.ignoredSheets,
      grid: normalizeGrid(sheet.rows, limits),
    };
  }

  const { text, encoding } = decodeImportText(bytes);
  checkDeadline();
  const csv = parseCsvGrid(text, readLimits);
  return {
    format: 'csv',
    encoding,
    delimiter: csv.delimiter,
    sheetName: null,
    ignoredSheets: [],
    grid: normalizeGrid(csv.rows, limits),
  };
}
