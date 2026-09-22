import {
  isBulkImportEnabledForOrg,
  parseBulkImportConfig,
} from './bulk-import.config';

describe('parseBulkImportConfig', () => {
  it('ships disabled with the story limits', () => {
    expect(parseBulkImportConfig({})).toEqual({
      enabled: false,
      pilotOrgIds: [],
      maxRows: 5_000,
      maxColumns: 100,
      maxOpenDrafts: 3,
      maxFileBytes: 5 * 1024 * 1024,
      maxUncompressedBytes: 50 * 1024 * 1024,
      parseTimeoutMs: 20_000,
      maxOrderAgeDays: 7,
      startWindowHours: 72,
      releasePerMinute: 20,
      quoteSecret: '',
    });
  });

  it('reads the switch and lowered limits', () => {
    expect(
      parseBulkImportConfig({
        STANDALONE_BULK_IMPORT_ENABLED: ' true ',
        BULK_IMPORT_MAX_ROWS: '100',
        BULK_IMPORT_MAX_COLUMNS: '20',
        BULK_IMPORT_MAX_OPEN_DRAFTS: '5',
        BULK_IMPORT_MAX_FILE_BYTES: '2048',
        BULK_IMPORT_MAX_UNCOMPRESSED_BYTES: '2097152',
        BULK_IMPORT_PARSE_TIMEOUT_MS: '5000',
        BULK_IMPORT_MAX_ORDER_AGE_DAYS: '14',
        BULK_IMPORT_START_WINDOW_HOURS: '24',
        BULK_IMPORT_RELEASE_PER_MINUTE: '60',
        BULK_IMPORT_QUOTE_SECRET: ' qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq ',
      }),
    ).toEqual({
      enabled: true,
      pilotOrgIds: [],
      maxRows: 100,
      maxColumns: 20,
      maxOpenDrafts: 5,
      maxFileBytes: 2048,
      maxUncompressedBytes: 2097152,
      parseTimeoutMs: 5000,
      maxOrderAgeDays: 14,
      startWindowHours: 24,
      releasePerMinute: 60,
      quoteSecret: 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    });
  });

  it.each([
    ['STANDALONE_BULK_IMPORT_ENABLED', 'yes'],
    ['BULK_IMPORT_MAX_ROWS', '5001'],
    ['BULK_IMPORT_START_WINDOW_HOURS', '0'],
    ['BULK_IMPORT_START_WINDOW_HOURS', '721'],
    ['BULK_IMPORT_MAX_ROWS', '0'],
    ['BULK_IMPORT_MAX_COLUMNS', '1.5'],
    ['BULK_IMPORT_MAX_FILE_BYTES', String(5 * 1024 * 1024 + 1)],
    ['BULK_IMPORT_MAX_UNCOMPRESSED_BYTES', 'lots'],
    ['BULK_IMPORT_PARSE_TIMEOUT_MS', '60000'],
    ['BULK_IMPORT_MAX_ORDER_AGE_DAYS', '0'],
    ['BULK_IMPORT_MAX_ORDER_AGE_DAYS', '91'],
    ['BULK_IMPORT_RELEASE_PER_MINUTE', '0'],
    ['BULK_IMPORT_RELEASE_PER_MINUTE', '121'],
    ['BULK_IMPORT_QUOTE_SECRET', 'too-short'],
    ['BULK_IMPORT_PILOT_ORG_IDS', 'acme-store'],
    ['BULK_IMPORT_PILOT_ORG_IDS', '0a0a0a0a-0000-4000-8000-00000000000a,42'],
  ])('refuses to boot with %s=%s', (key, value) => {
    expect(() => parseBulkImportConfig({ [key]: value })).toThrow(key);
  });

  it('refuses to enable import without a quote-signing secret', () => {
    expect(() =>
      parseBulkImportConfig({ STANDALONE_BULK_IMPORT_ENABLED: 'true' }),
    ).toThrow('BULK_IMPORT_QUOTE_SECRET');
  });

  it('reads the pilot allow-list: trimmed, lowercased, de-duplicated, blanks dropped', () => {
    expect(
      parseBulkImportConfig({
        BULK_IMPORT_PILOT_ORG_IDS:
          ' 0A0A0A0A-0000-4000-8000-00000000000A , ,0b0b0b0b-0000-4000-8000-00000000000b,0a0a0a0a-0000-4000-8000-00000000000a ',
      }).pilotOrgIds,
    ).toEqual([
      '0a0a0a0a-0000-4000-8000-00000000000a',
      '0b0b0b0b-0000-4000-8000-00000000000b',
    ]);
    expect(
      parseBulkImportConfig({ BULK_IMPORT_PILOT_ORG_IDS: '  ' }).pilotOrgIds,
    ).toEqual([]);
  });
});

describe('isBulkImportEnabledForOrg (US-04.6-10 pilot allow-list)', () => {
  const PILOT = '0a0a0a0a-0000-4000-8000-00000000000a';
  const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';

  it.each<[string, boolean, string[], string | null, boolean]>([
    ['off, no list', false, [], PILOT, false],
    ['off, even for a listed org', false, [PILOT], PILOT, false],
    ['on, no list: general availability', true, [], OTHER, true],
    ['on, listed org', true, [PILOT], PILOT, true],
    [
      'on, listed org in another case',
      true,
      [PILOT],
      PILOT.toUpperCase(),
      true,
    ],
    ['on, unlisted org', true, [PILOT], OTHER, false],
    ['on, list set, no organization', true, [PILOT], null, false],
  ])('%s', (_case, enabled, pilotOrgIds, orgId, want) => {
    expect(isBulkImportEnabledForOrg({ enabled, pilotOrgIds }, orgId)).toBe(
      want,
    );
  });
});
