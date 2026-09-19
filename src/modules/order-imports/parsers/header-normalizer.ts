import {
  FIELD_TOO_LONG,
  isBlankRow,
  type Grid,
  type GridRow,
} from './grid.types';
import { ImportFileError } from './import-file.error';

export const MAX_CELL_LENGTH = 1_000;

export interface GridShapeLimits {
  /** Non-empty data rows, header excluded. */
  maxRows: number;
  maxColumns: number;
}

/** Cuts at `max` UTF-16 units without leaving half of a surrogate pair. */
function truncate(value: string, max: number): string {
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function lastFilledIndex(cells: readonly string[]): number {
  for (let index = cells.length - 1; index >= 0; index--) {
    if (cells[index] !== '') return index;
  }
  return -1;
}

function uniqueHeaders(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix++)
      candidate = `${name} (${suffix})`;
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Turns the rows a format parser read into the batch grid (AC7):
 * - the first non-empty row is the header; headers are trimmed and
 *   NFC-normalized, a blank header becomes `Column N` (N is the spreadsheet
 *   column) and repeats get ` (2)`, ` (3)` suffixes;
 * - blank rows are dropped and not counted, cells are trimmed, and a value
 *   over 1,000 characters is cut and flagged `FIELD_TOO_LONG`;
 * - cells beyond the header keep their data under `Column N`, missing cells
 *   are empty, and a column with neither a header nor any value (a trailing
 *   delimiter on every line, say) is left out.
 */
export function normalizeGrid(
  rows: readonly GridRow[],
  limits: GridShapeLimits,
): Grid {
  const trimmed = rows
    .map((row) => ({ ...row, cells: row.cells.map((cell) => cell.trim()) }))
    .filter((row) => !isBlankRow(row.cells));
  const [headerRow, ...dataRows] = trimmed;
  if (!headerRow) throw new ImportFileError('IMPORT_FILE_EMPTY', 'no_header');
  if (dataRows.length === 0)
    throw new ImportFileError('IMPORT_FILE_EMPTY', 'no_data_rows');
  if (dataRows.length > limits.maxRows)
    throw new ImportFileError('IMPORT_ROW_LIMIT_EXCEEDED', 'row_limit');

  const width = Math.max(
    ...trimmed.map((row) => lastFilledIndex(row.cells) + 1),
  );
  const used = new Array<boolean>(width).fill(false);
  for (const row of trimmed) {
    row.cells.forEach((cell, index) => {
      if (cell !== '') used[index] = true;
    });
  }
  const columns = used.flatMap((isUsed, index) => (isUsed ? [index] : []));
  if (columns.length > limits.maxColumns)
    throw new ImportFileError('IMPORT_COLUMN_LIMIT_EXCEEDED', 'column_limit');

  const headers = uniqueHeaders(
    columns.map((column) => {
      const name = truncate(
        (headerRow.cells[column] ?? '').normalize('NFC'),
        MAX_CELL_LENGTH,
      );
      return name === '' ? `Column ${column + 1}` : name;
    }),
  );

  return {
    headers,
    rows: dataRows.map((row) => {
      const issues = [...row.issues];
      const cells = columns.map((column, position) => {
        const value = row.cells[column] ?? '';
        if (value.length <= MAX_CELL_LENGTH) return value;
        issues.push({ code: FIELD_TOO_LONG, field: headers[position] });
        return truncate(value, MAX_CELL_LENGTH);
      });
      return { rowNumber: row.rowNumber, cells, issues };
    }),
  };
}
