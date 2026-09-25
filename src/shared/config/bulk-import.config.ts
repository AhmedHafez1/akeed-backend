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
  /**
   * The pilot allow-list (US-04.6-10): while it has entries, only these
   * organizations see bulk import even with the switch on. Empty means every
   * Standalone organization, which is general availability.
   */
  pilotOrgIds: readonly string[];
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
  /** Rows whose order date is older than this are excluded, not confirmed. */
  maxOrderAgeDays: number;
  /** Hours a committed batch may wait before its start deadline passes. */
  startWindowHours: number;
  /**
   * First messages released per minute per organization, across all of its
   * releasing batches. Protects the shared sender's quality rating; 20 is an
   * internal pilot default, not a Meta-published threshold.
   */
  releasePerMinute: number;
  /** Signs start quotes so a start can prove what the merchant was shown. */
  quoteSecret: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Shortest accepted quote-signing secret (256 bits of hex). */
export const BULK_IMPORT_QUOTE_SECRET_MIN_LENGTH = 32;

interface IntegerSetting {
  key: string;
  field: Exclude<
    keyof BulkImportConfig,
    'enabled' | 'pilotOrgIds' | 'quoteSecret'
  >;
  fallback: number;
  min: number;
  max: number;
}

const INTEGER_SETTINGS: readonly IntegerSetting[] = [
  {
    key: 'BULK_IMPORT_MAX_ROWS',
    field: 'maxRows',
    // A file is a day's orders, checked and sent from one modal (product
    // decision, 2026-09): larger batches belong to the order API.
    fallback: 100,
    min: 1,
    max: 100,
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
  {
    key: 'BULK_IMPORT_MAX_ORDER_AGE_DAYS',
    field: 'maxOrderAgeDays',
    fallback: 7,
    min: 1,
    max: 90,
  },
  {
    key: 'BULK_IMPORT_START_WINDOW_HOURS',
    field: 'startWindowHours',
    fallback: 72,
    min: 1,
    max: 720,
  },
  {
    key: 'BULK_IMPORT_RELEASE_PER_MINUTE',
    field: 'releasePerMinute',
    fallback: 20,
    min: 1,
    max: 120,
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

  const pilotOrgIds = [
    ...new Set(
      read('BULK_IMPORT_PILOT_ORG_IDS')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // A typo would silently shut a pilot merchant out, so it fails at boot.
  if (pilotOrgIds.some((id) => !UUID_PATTERN.test(id)))
    errors.push(
      'BULK_IMPORT_PILOT_ORG_IDS must be a comma-separated list of organization UUIDs.',
    );

  const parsed: BulkImportConfig = {
    enabled: flag === 'true',
    pilotOrgIds,
    maxRows: 0,
    maxColumns: 0,
    maxOpenDrafts: 0,
    maxFileBytes: 0,
    maxUncompressedBytes: 0,
    parseTimeoutMs: 0,
    maxOrderAgeDays: 0,
    startWindowHours: 0,
    releasePerMinute: 0,
    quoteSecret: read('BULK_IMPORT_QUOTE_SECRET'),
  };
  // Only the start endpoint signs, but a switched-on import that cannot sign
  // a quote would fail on the merchant's first click, so it fails at boot.
  if (
    (parsed.enabled || parsed.quoteSecret) &&
    parsed.quoteSecret.length < BULK_IMPORT_QUOTE_SECRET_MIN_LENGTH
  )
    errors.push(
      `BULK_IMPORT_QUOTE_SECRET must be at least ${BULK_IMPORT_QUOTE_SECRET_MIN_LENGTH} characters when bulk import is enabled.`,
    );
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

/**
 * Whether bulk import is on for one organization: the switch, narrowed by
 * the pilot allow-list while it has entries. Every flag check that depends on
 * who is asking goes through this, so the pilot can't leak through one path.
 */
export function isBulkImportEnabledForOrg(
  bulkImport: Pick<BulkImportConfig, 'enabled' | 'pilotOrgIds'>,
  orgId: string | null | undefined,
): boolean {
  if (!bulkImport.enabled) return false;
  if (bulkImport.pilotOrgIds.length === 0) return true;
  return !!orgId && bulkImport.pilotOrgIds.includes(orgId.toLowerCase());
}
