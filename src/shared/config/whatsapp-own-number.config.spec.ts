import {
  isOwnNumberConnectAllowed,
  isOwnNumberSendingAllowed,
  parseWhatsappOwnNumberConfig,
  readWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from './whatsapp-own-number.config';

const PILOT_ORG = '0b9f6f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ORG = '5a4f3e2d-1c0b-4a9f-8e7d-6c5b4a3f2e1d';

const connectReady = {
  WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'true',
  META_EMBEDDED_SIGNUP_CONFIG_ID: '1234567890',
  META_APP_ID: '9876543210',
  WHATSAPP_CONNECT_PAGE_BASE_URL: 'https://app.example.test',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
};

describe('parseWhatsappOwnNumberConfig', () => {
  it('is off when nothing is set, and needs nothing else then', () => {
    expect(parseWhatsappOwnNumberConfig({})).toEqual({
      connectEnabled: false,
      sendingEnabled: false,
      pilotOrgIds: [],
      embeddedSignupConfigId: null,
      metaAppId: null,
      connectPageBaseUrl: null,
    });
  });

  it('keeps the switches off with signup settings present but switched off', () => {
    const config = parseWhatsappOwnNumberConfig({
      META_EMBEDDED_SIGNUP_CONFIG_ID: '1234567890',
      META_APP_ID: '9876543210',
      WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'false',
      WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'false',
    });
    expect(config.connectEnabled).toBe(false);
    expect(config.sendingEnabled).toBe(false);
    expect(config.metaAppId).toBeNull();
    expect(config.embeddedSignupConfigId).toBeNull();
  });

  it.each([
    'WHATSAPP_OWN_NUMBER_CONNECT_ENABLED',
    'WHATSAPP_OWN_NUMBER_SENDING_ENABLED',
  ])('fails boot on a %s that is not true or false', (key) => {
    expect(() =>
      parseWhatsappOwnNumberConfig({ ...connectReady, [key]: 'yes' }),
    ).toThrow(`${key} must be true or false.`);
  });

  it('turns connect on alone, with the signup settings it needs', () => {
    const config = parseWhatsappOwnNumberConfig(connectReady);
    expect(config).toMatchObject({
      connectEnabled: true,
      sendingEnabled: false,
      embeddedSignupConfigId: '1234567890',
      metaAppId: '9876543210',
      connectPageBaseUrl: 'https://app.example.test',
    });
  });

  it('turns sending on alone, without any signup setting', () => {
    const config = parseWhatsappOwnNumberConfig({
      WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
    });
    expect(config).toMatchObject({
      connectEnabled: false,
      sendingEnabled: true,
      embeddedSignupConfigId: null,
      metaAppId: null,
    });
  });

  it('names every missing connect setting', () => {
    expect(() =>
      parseWhatsappOwnNumberConfig({
        WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'true',
      }),
    ).toThrow(
      /WHATSAPP_CONNECT_PAGE_BASE_URL is required[\s\S]*META_EMBEDDED_SIGNUP_CONFIG_ID is required[\s\S]*META_APP_ID is required[\s\S]*SHOPIFY_TOKEN_ENCRYPTION_KEY is required/,
    );
  });

  it('requires the encryption key for sending', () => {
    expect(() =>
      parseWhatsappOwnNumberConfig({
        WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
      }),
    ).toThrow('SHOPIFY_TOKEN_ENCRYPTION_KEY is required');
  });

  it('rejects a signup configuration id that is not digits', () => {
    expect(() =>
      parseWhatsappOwnNumberConfig({
        ...connectReady,
        META_EMBEDDED_SIGNUP_CONFIG_ID: 'config-1',
      }),
    ).toThrow('META_EMBEDDED_SIGNUP_CONFIG_ID must be the numeric');
  });

  it.each([
    'http://app.example.test',
    'https://app.example.test/',
    'https://app.example.test/ar',
    'https://app.example.test?x=1',
    'https://user:pass@app.example.test',
    'not a url',
  ])(
    'rejects a connect page base URL that is not a bare HTTPS origin: %s',
    (value) => {
      expect(() =>
        parseWhatsappOwnNumberConfig({
          ...connectReady,
          WHATSAPP_CONNECT_PAGE_BASE_URL: value,
        }),
      ).toThrow('WHATSAPP_CONNECT_PAGE_BASE_URL must be an HTTPS origin');
    },
  );

  it('accepts plain HTTP for a local connect page only', () => {
    expect(
      parseWhatsappOwnNumberConfig({
        ...connectReady,
        WHATSAPP_CONNECT_PAGE_BASE_URL: 'http://localhost:3001',
      }).connectPageBaseUrl,
    ).toBe('http://localhost:3001');
  });

  it('normalises the pilot list and drops duplicates and blanks', () => {
    const config = parseWhatsappOwnNumberConfig({
      WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: ` ${PILOT_ORG.toUpperCase()}, ,${PILOT_ORG}`,
    });
    expect(config.pilotOrgIds).toEqual([PILOT_ORG]);
  });

  it('fails boot on a malformed pilot entry, even with the switches off', () => {
    expect(() =>
      parseWhatsappOwnNumberConfig({
        WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: `${PILOT_ORG},not-a-uuid`,
      }),
    ).toThrow('WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS must be a comma-separated');
  });
});

describe('own-number eligibility', () => {
  const bothOn = {
    ...connectReady,
    WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
  };

  it('allows nobody while a switch is off, whatever the list says', () => {
    const config = parseWhatsappOwnNumberConfig({
      WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: PILOT_ORG,
    });
    expect(isOwnNumberConnectAllowed(config, PILOT_ORG)).toBe(false);
    expect(isOwnNumberSendingAllowed(config, PILOT_ORG)).toBe(false);
  });

  it('allows every organization with an empty list and a switch on', () => {
    const config = parseWhatsappOwnNumberConfig(bothOn);
    expect(isOwnNumberConnectAllowed(config, OTHER_ORG)).toBe(true);
    expect(isOwnNumberSendingAllowed(config, OTHER_ORG)).toBe(true);
  });

  it('allows only listed organizations with a populated list', () => {
    const config = parseWhatsappOwnNumberConfig({
      ...bothOn,
      WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: PILOT_ORG,
    });
    expect(isOwnNumberConnectAllowed(config, PILOT_ORG.toUpperCase())).toBe(
      true,
    );
    expect(isOwnNumberSendingAllowed(config, PILOT_ORG)).toBe(true);
    expect(isOwnNumberConnectAllowed(config, OTHER_ORG)).toBe(false);
    expect(isOwnNumberSendingAllowed(config, OTHER_ORG)).toBe(false);
  });

  it('keeps connecting and sending independent', () => {
    const connectOnly = parseWhatsappOwnNumberConfig(connectReady);
    expect(isOwnNumberConnectAllowed(connectOnly, PILOT_ORG)).toBe(true);
    expect(isOwnNumberSendingAllowed(connectOnly, PILOT_ORG)).toBe(false);

    const sendOnly = parseWhatsappOwnNumberConfig({
      WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
    });
    expect(isOwnNumberConnectAllowed(sendOnly, PILOT_ORG)).toBe(false);
    expect(isOwnNumberSendingAllowed(sendOnly, PILOT_ORG)).toBe(true);
  });
});

describe('readWhatsappOwnNumberConfig', () => {
  it('returns what validateEnv parsed, and refuses an unvalidated config', () => {
    const parsed = parseWhatsappOwnNumberConfig({});
    expect(
      readWhatsappOwnNumberConfig({
        get: <T>(key: string) =>
          (key === WHATSAPP_OWN_NUMBER_CONFIG ? parsed : undefined) as T,
      }),
    ).toBe(parsed);
    expect(() => readWhatsappOwnNumberConfig({ get: () => undefined })).toThrow(
      'not validated',
    );
  });
});
