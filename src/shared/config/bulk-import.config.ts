export const BULK_IMPORT_CONFIG = 'bulkImport';

/**
 * Standalone bulk order import (E04.6).
 *
 * The switch hides every order-import route. The limits bound what one upload
 * can cost: the file is held in memory, inflated and parsed in the request, so
 * each ceiling below is also a hard maximum an operator cannot raise past.
 */
export interface BulkImportConfig {
  enabled: boolean;
  /** Non-empty data rows accepted from one file. */
  maxRows: number;
  /** Columns accepted from one file. */
  maxColumns: number;
  /** Open (unexpired) drafts one organization may hold. */
  maxOpenDrafts: number;
  /** Upload size; enforced by the multipart limiter while streaming. */
  maxFileBytes: number;
  /** Total inflated size of an XLSX package (zip-bomb guard). */
  maxUncompressedBytes: number;
  /** Wall-clock budget for sniffing, decoding and parsing one file. */
  parseTimeoutMs: number;
}

interface IntegerSetting {
  key: string;
  field: Exclude<keyof BulkImportConfig, 'enabled'>;
  fallback: number;
  min: number;
  max: number;
}

const INTEGER_SETTINGS: readonly IntegerSetting[] = [
  {
    key: 'BULK_IMPORT_MAX_ROWS',
    field: 'maxRows',
    fallback: 5_000,
    min: 1,
    max: 5_000,
  },
  {
    key: 'BULK_IMPORT_MAX_COLUMNS',
    field: 'maxColumns',
    fallback: 100,
    min: 1,
    max: 100,
  },
  {
    key: 'BULK_IMPORT_MAX_OPEN_DRAFTS',
    field: 'maxOpenDrafts',
    fallback: 3,
    min: 1,
    max: 20,
  },
  {
    key: 'BULK_IMPORT_MAX_FILE_BYTES',
    field: 'maxFileBytes',
    fallback: 5 * 1024 * 1024,
    min: 1_024,
    max: 5 * 1024 * 1024,
  },
  {
    key: 'BULK_IMPORT_MAX_UNCOMPRESSED_BYTES',
    field: 'maxUncompressedBytes',
    fallback: 50 * 1024 * 1024,
    min: 1024 * 1024,
    max: 50 * 1024 * 1024,
  },
  {
    key: 'BULK_IMPORT_PARSE_TIMEOUT_MS',
    field: 'parseTimeoutMs',
    fallback: 20_000,
    min: 1_000,
    max: 20_000,
  },
];

export function parseBulkImportConfig(
  config: Record<string, unknown>,
): BulkImportConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const flag = read('STANDALONE_BULK_IMPORT_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    errors.push('STANDALONE_BULK_IMPORT_ENABLED must be true or false.');

  const parsed: BulkImportConfig = {
    enabled: flag === 'true',
    maxRows: 0,
    maxColumns: 0,
    maxOpenDrafts: 0,
    maxFileBytes: 0,
    maxUncompressedBytes: 0,
    parseTimeoutMs: 0,
  };
  for (const setting of INTEGER_SETTINGS) {
    const raw = read(setting.key);
    const value = raw ? Number(raw) : setting.fallback;
    if (
      !Number.isInteger(value) ||
      value < setting.min ||
      value > setting.max
    ) {
      errors.push(
        `${setting.key} must be an integer from ${setting.min} to ${setting.max}.`,
      );
      continue;
    }
    parsed[setting.field] = value;
  }
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return parsed;
}

/**
 * Reads the object `validateEnv` already parsed at startup, so runtime code
 * never re-derives limits from raw environment strings.
 */
export function readBulkImportConfig(config: {
  get<T>(key: string): T | undefined;
}): BulkImportConfig {
  const bulkImport = config.get<BulkImportConfig>(BULK_IMPORT_CONFIG);
  if (!bulkImport)
    throw new Error('Bulk import configuration was not validated');
  return bulkImport;
}
