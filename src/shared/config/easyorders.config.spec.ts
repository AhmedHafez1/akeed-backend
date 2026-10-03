import {
  EASYORDERS_CONFIG,
  isEasyOrdersPilotOrganization,
  isSourceConnectEnabled,
  parseEasyOrdersConfig,
  readEasyOrdersConfig,
} from './easyorders.config';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const ENABLED = {
  NODE_ENV: 'production',
  EASYORDERS_CONNECT_ENABLED: 'true',
  EASYORDERS_PUBLIC_API_BASE_URL: 'https://api.akeed.test/',
  EASYORDERS_APP_BASE_URL: 'https://app.akeed.test',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
};

describe('EasyOrders configuration', () => {
  it('switches ingestion on separately from connect', () => {
    expect(
      parseEasyOrdersConfig({
        EASYORDERS_INGESTION_ENABLED: 'true',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
      }),
    ).toMatchObject({ enabled: false, ingestionEnabled: true });
    expect(
      parseEasyOrdersConfig({
        ...ENABLED,
        EASYORDERS_INGESTION_ENABLED: 'true',
      }),
    ).toMatchObject({ enabled: true, ingestionEnabled: true });
  });

  it.each([
    [{ EASYORDERS_INGESTION_ENABLED: 'on' }, /must be true or false/],
    [
      { EASYORDERS_INGESTION_ENABLED: 'true' },
      /SHOPIFY_TOKEN_ENCRYPTION_KEY is required when EasyOrders ingestion/,
    ],
  ])('fails boot on an unusable ingestion switch %#', (env, message) => {
    expect(() => parseEasyOrdersConfig(env)).toThrow(message);
  });

  it('is off and needs nothing by default', () => {
    expect(parseEasyOrdersConfig({})).toEqual({
      enabled: false,
      ingestionEnabled: false,
      pilotOrgIds: [],
      publicApiBaseUrl: '',
      appBaseUrl: '',
    });
  });

  it('reads the switch, the allow-list and the base URLs without a trailing slash', () => {
    expect(
      parseEasyOrdersConfig({
        ...ENABLED,
        EASYORDERS_PILOT_ORG_IDS: ` ${ORG_A.toUpperCase()}, ${ORG_B},${ORG_A} `,
      }),
    ).toEqual({
      enabled: true,
      ingestionEnabled: false,
      pilotOrgIds: [ORG_A, ORG_B],
      publicApiBaseUrl: 'https://api.akeed.test',
      appBaseUrl: 'https://app.akeed.test',
    });
  });

  it.each([
    ['EASYORDERS_CONNECT_ENABLED', 'yes', /must be true or false/],
    ['EASYORDERS_PILOT_ORG_IDS', 'not-a-uuid', /organization UUIDs/],
    ['EASYORDERS_PUBLIC_API_BASE_URL', '', /EASYORDERS_PUBLIC_API_BASE_URL/],
    [
      'EASYORDERS_PUBLIC_API_BASE_URL',
      'http://api.akeed.test',
      /must be an https URL/,
    ],
    [
      'EASYORDERS_PUBLIC_API_BASE_URL',
      'https://api.akeed.test/?x=1',
      /without a query/,
    ],
    ['EASYORDERS_APP_BASE_URL', 'app.akeed.test', /EASYORDERS_APP_BASE_URL/],
    ['SHOPIFY_TOKEN_ENCRYPTION_KEY', ' ', /SHOPIFY_TOKEN_ENCRYPTION_KEY/],
  ])('fails boot when %s is "%s"', (key, value, message) => {
    expect(() => parseEasyOrdersConfig({ ...ENABLED, [key]: value })).toThrow(
      message,
    );
  });

  it('allows a plain http tunnel in development only', () => {
    expect(
      parseEasyOrdersConfig({
        ...ENABLED,
        NODE_ENV: 'development',
        EASYORDERS_PUBLIC_API_BASE_URL: 'http://localhost:3000',
      }).publicApiBaseUrl,
    ).toBe('http://localhost:3000');
  });

  it('connects nobody while the allow-list is empty, and only listed organizations otherwise', () => {
    const open = parseEasyOrdersConfig(ENABLED);
    const pilot = parseEasyOrdersConfig({
      ...ENABLED,
      EASYORDERS_PILOT_ORG_IDS: ORG_A,
    });
    const off = parseEasyOrdersConfig({ EASYORDERS_PILOT_ORG_IDS: ORG_A });

    expect(isEasyOrdersPilotOrganization(open, ORG_A)).toBe(false);
    expect(isEasyOrdersPilotOrganization(pilot, ORG_A.toUpperCase())).toBe(
      true,
    );
    expect(isEasyOrdersPilotOrganization(pilot, ORG_B)).toBe(false);
    expect(isEasyOrdersPilotOrganization(off, ORG_A)).toBe(false);
  });

  it('is read back from the validated configuration', () => {
    const parsed = parseEasyOrdersConfig(ENABLED);
    const config = {
      get: <T>(key: string) =>
        (key === EASYORDERS_CONFIG ? parsed : undefined) as T | undefined,
    };

    expect(readEasyOrdersConfig(config)).toBe(parsed);
    expect(isSourceConnectEnabled(config)).toBe(true);
    expect(isSourceConnectEnabled({ get: () => undefined })).toBe(false);
    expect(() => readEasyOrdersConfig({ get: () => undefined })).toThrow(
      'EasyOrders configuration was not validated',
    );
  });
});
