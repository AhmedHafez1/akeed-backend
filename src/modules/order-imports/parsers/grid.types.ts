/**
 * The uniform shape every import file becomes, whatever its format.
 *
 * `rowNumber` is the 1-based row the merchant sees in Excel (the header is row
 * 1 when it is the first line), so every later message can point at it.
 */
export interface RowIssue {
  code: string;
  field?: string;
  params?: Record<string, string | number>;
}

export interface GridRow {
  rowNumber: number;
  cells: string[];
  issues: RowIssue[];
}

export interface Grid {
  headers: string[];
  rows: GridRow[];
}

export type ImportFileFormat = 'csv' | 'xlsx';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1256';

export type CsvDelimiter = ',' | ';' | '\t';

export interface ParsedImportFile {
  format: ImportFileFormat;
  encoding: TextEncoding | null;
  delimiter: CsvDelimiter | null;
  sheetName: string | null;
  ignoredSheets: string[];
  grid: Grid;
}

/** Row issue: a cell was cut to the maximum length. */
export const FIELD_TOO_LONG = 'FIELD_TOO_LONG';
/**
 * Row issue: a CSV quote was never closed or was followed by stray text. Only
 * that row is affected; parsing resumes on the next line.
 */
export const CSV_MALFORMED_QUOTE = 'CSV_MALFORMED_QUOTE';

/**
 * What a format parser enforces while reading, so an oversized file stops
 * early. Parsers return only non-blank rows, each with its real row number.
 */
export interface GridReadLimits {
  /** Non-empty rows, header included, beyond which reading aborts. */
  maxNonEmptyRows: number;
  /** Throws once the parse budget is spent. */
  checkDeadline: () => void;
}

/** A row read from the file is blank when every cell is whitespace. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}
