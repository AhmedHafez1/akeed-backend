import { parseBulkImportConfig } from './bulk-import.config';

describe('parseBulkImportConfig', () => {
  it('ships disabled with the story limits', () => {
    expect(parseBulkImportConfig({})).toEqual({
      enabled: false,
      maxRows: 5_000,
      maxColumns: 100,
      maxOpenDrafts: 3,
      maxFileBytes: 5 * 1024 * 1024,
      maxUncompressedBytes: 50 * 1024 * 1024,
      parseTimeoutMs: 20_000,
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
      }),
    ).toEqual({
      enabled: true,
      maxRows: 100,
      maxColumns: 20,
      maxOpenDrafts: 5,
      maxFileBytes: 2048,
      maxUncompressedBytes: 2097152,
      parseTimeoutMs: 5000,
    });
  });

  it.each([
    ['STANDALONE_BULK_IMPORT_ENABLED', 'yes'],
    ['BULK_IMPORT_MAX_ROWS', '5001'],
    ['BULK_IMPORT_MAX_ROWS', '0'],
    ['BULK_IMPORT_MAX_COLUMNS', '1.5'],
    ['BULK_IMPORT_MAX_FILE_BYTES', String(5 * 1024 * 1024 + 1)],
    ['BULK_IMPORT_MAX_UNCOMPRESSED_BYTES', 'lots'],
    ['BULK_IMPORT_PARSE_TIMEOUT_MS', '60000'],
  ])('refuses to boot with %s=%s', (key, value) => {
    expect(() => parseBulkImportConfig({ [key]: value })).toThrow(key);
  });
});
