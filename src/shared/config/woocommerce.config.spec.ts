import { EASYORDERS_CONFIG, isSourceConnectEnabled } from './easyorders.config';
import {
  isWooCommercePilotOrganization,
  parseWooCommerceConfig,
  readWooCommerceConfig,
  WOOCOMMERCE_CONFIG,
} from './woocommerce.config';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const ENABLED = {
  NODE_ENV: 'production',
  WOOCOMMERCE_CONNECT_ENABLED: 'true',
  WOOCOMMERCE_PUBLIC_API_BASE_URL: 'https://api.akeed.test/',
  WOOCOMMERCE_APP_BASE_URL: 'https://app.akeed.test',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
};

describe('WooCommerce configuration', () => {
  it('ships dark by default and needs nothing else', () => {
    expect(parseWooCommerceConfig({})).toEqual({
      enabled: false,
      ingestionEnabled: false,
      pilotOrgIds: [],
      publicApiBaseUrl: '',
      appBaseUrl: '',
    });
  });

  it('normalizes the allow-list and the base URLs', () => {
    expect(
      parseWooCommerceConfig({
        ...ENABLED,
        WOOCOMMERCE_PILOT_ORG_IDS: ` ${ORG_A.toUpperCase()}, ${ORG_B},${ORG_A} `,
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
    ['WOOCOMMERCE_CONNECT_ENABLED', 'yes', /must be true or false/],
    [
      'WOOCOMMERCE_INGESTION_ENABLED',
      '1',
      /WOOCOMMERCE_INGESTION_ENABLED must be true or false/,
    ],
    ['WOOCOMMERCE_PILOT_ORG_IDS', 'not-a-uuid', /organization UUIDs/],
    ['WOOCOMMERCE_PUBLIC_API_BASE_URL', '', /WOOCOMMERCE_PUBLIC_API_BASE_URL/],
    [
      'WOOCOMMERCE_PUBLIC_API_BASE_URL',
      'http://api.akeed.test',
      /must be an https URL/,
    ],
    [
      'WOOCOMMERCE_PUBLIC_API_BASE_URL',
      'https://api.akeed.test/?x=1',
      /without a query or fragment/,
    ],
    ['WOOCOMMERCE_APP_BASE_URL', 'app.akeed.test', /WOOCOMMERCE_APP_BASE_URL/],
    [
      'SHOPIFY_TOKEN_ENCRYPTION_KEY',
      '',
      /SHOPIFY_TOKEN_ENCRYPTION_KEY is required when WooCommerce is enabled/,
    ],
  ])('fails startup on a bad %s (%s)', (key, value, message) => {
    expect(() => parseWooCommerceConfig({ ...ENABLED, [key]: value })).toThrow(
      message,
    );
  });

  it('switches ingestion on apart from connect, and needs the encryption key for it', () => {
    expect(
      parseWooCommerceConfig({
        WOOCOMMERCE_INGESTION_ENABLED: 'true',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      }),
    ).toMatchObject({ enabled: false, ingestionEnabled: true });
    expect(
      parseWooCommerceConfig({
        ...ENABLED,
        WOOCOMMERCE_INGESTION_ENABLED: 'true',
      }),
    ).toMatchObject({ enabled: true, ingestionEnabled: true });
    expect(() =>
      parseWooCommerceConfig({ WOOCOMMERCE_INGESTION_ENABLED: 'true' }),
    ).toThrow(
      /SHOPIFY_TOKEN_ENCRYPTION_KEY is required when WooCommerce ingestion is enabled/,
    );
  });

  it('allows plain HTTP base URLs in development only', () => {
    expect(
      parseWooCommerceConfig({
        ...ENABLED,
        NODE_ENV: 'development',
        WOOCOMMERCE_PUBLIC_API_BASE_URL: 'http://localhost:3000',
      }).publicApiBaseUrl,
    ).toBe('http://localhost:3000');
  });

  it('admits only listed organizations, and nobody while the switch is off', () => {
    const open = parseWooCommerceConfig(ENABLED);
    const pilot = parseWooCommerceConfig({
      ...ENABLED,
      WOOCOMMERCE_PILOT_ORG_IDS: ORG_A,
    });
    const off = parseWooCommerceConfig({ WOOCOMMERCE_PILOT_ORG_IDS: ORG_A });

    expect(isWooCommercePilotOrganization(open, ORG_A)).toBe(false);
    expect(isWooCommercePilotOrganization(pilot, ORG_A.toUpperCase())).toBe(
      true,
    );
    expect(isWooCommercePilotOrganization(pilot, ORG_B)).toBe(false);
    expect(isWooCommercePilotOrganization(off, ORG_A)).toBe(false);
  });

  it('is read from the validated config object', () => {
    const parsed = parseWooCommerceConfig(ENABLED);
    const config = {
      get: <T>(key: string) =>
        (key === WOOCOMMERCE_CONFIG ? parsed : undefined) as T | undefined,
    };

    expect(readWooCommerceConfig(config)).toBe(parsed);
    expect(() => readWooCommerceConfig({ get: () => undefined })).toThrow(
      'WooCommerce configuration was not validated',
    );
  });
});

describe('source-connect switch', () => {
  const config = (switches: { easyOrders: boolean; wooCommerce: boolean }) => ({
    get: <T>(key: string) =>
      (key === EASYORDERS_CONFIG
        ? { enabled: switches.easyOrders }
        : key === WOOCOMMERCE_CONFIG
          ? { enabled: switches.wooCommerce }
          : undefined) as T | undefined,
  });

  it.each([
    [{ easyOrders: true, wooCommerce: false }, true],
    [{ easyOrders: false, wooCommerce: true }, true],
    [{ easyOrders: true, wooCommerce: true }, true],
    [{ easyOrders: false, wooCommerce: false }, false],
  ])('for %j a source-less signup is allowed: %s', (switches, allowed) => {
    expect(isSourceConnectEnabled(config(switches))).toBe(allowed);
  });
});
