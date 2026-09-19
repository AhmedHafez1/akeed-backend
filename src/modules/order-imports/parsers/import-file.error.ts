/**
 * File-level reasons an upload is refused. Parsers throw these as plain domain
 * errors; the service maps them to HTTP responses, so the parsers stay free of
 * Nest and can be unit-tested on bytes alone.
 */
export type ImportFileErrorCode =
  | 'IMPORT_FILE_TYPE_UNSUPPORTED'
  | 'IMPORT_FILE_PROTECTED'
  | 'IMPORT_FILE_UNREADABLE'
  | 'IMPORT_FILE_EMPTY'
  | 'IMPORT_ROW_LIMIT_EXCEEDED'
  | 'IMPORT_COLUMN_LIMIT_EXCEEDED';

/** Why a file was unreadable, for logs and tests; never shown to merchants. */
export type ImportFileErrorReason =
  | 'macro_workbook'
  | 'binary_workbook'
  | 'legacy_xls'
  | 'encrypted_package'
  | 'ole2_unknown'
  | 'zip_without_workbook'
  | 'zip_corrupt'
  | 'uncompressed_limit'
  | 'binary_content'
  | 'workbook_corrupt'
  | 'no_visible_sheet'
  | 'parse_timeout'
  | 'parse_resources'
  | 'no_header'
  | 'no_data_rows'
  | 'row_limit'
  | 'column_limit';

export class ImportFileError extends Error {
  constructor(
    readonly code: ImportFileErrorCode,
    readonly reason: ImportFileErrorReason,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'ImportFileError';
  }
}

/** A deadline check that throws once `budgetMs` has elapsed since creation. */
export function createDeadline(
  budgetMs: number,
  now: () => number = Date.now,
): () => void {
  const expiresAt = now() + budgetMs;
  return () => {
    if (now() > expiresAt)
      throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'parse_timeout');
  };
}
