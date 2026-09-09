import { validateEnv } from './env-validation';
import { parseStandaloneCreditBillingConfig } from './standalone-credit-billing.config';

const enabledTest = {
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'https://payments.akeed.net',
  PAYMOB_SECRET_KEY: 'sk_test_synthetic-value',
  PAYMOB_PUBLIC_KEY: 'pk_test_synthetic-value',
  PAYMOB_HMAC_SECRET: 'synthetic-hmac-secret',
  PAYMOB_CARD_INTEGRATION_ID: '900719925474099312345',
  PAYMOB_WALLET_INTEGRATION_ID: '900719925474099312346',
  PAYMOB_CALLBACK_URL: 'https://api.akeed.net/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'https://app.akeed.net/billing/return',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '3600',
};
const enabledLive = {
  ...enabledTest,
  PAYMOB_MODE: 'live',
  PAYMOB_SECRET_KEY: 'sk_live_synthetic-value',
  PAYMOB_PUBLIC_KEY: 'pk_live_synthetic-value',
};

describe('Standalone credit configuration', () => {
  it('defaults to disabled with the approved economics and no provider config', () => {
    expect(parseStandaloneCreditBillingConfig({})).toEqual({
      enabled: false,
      priceMinor: 200,
      freeGrant: 30,
      purchaseMin: 100,
      purchaseMax: 5000,
      purchaseStep: 50,
      lowBalanceThreshold: 10,
    });
    expect(
      parseStandaloneCreditBillingConfig({ PAYMOB_MODE: 'invalid' }).enabled,
    ).toBe(false);
  });

  it('exposes validated typed configuration through startup validation', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused/db',
      ...enabledTest,
    });
    expect(result.standaloneCreditBilling).toMatchObject({
      enabled: true,
      paymob: {
        mode: 'test',
        cardIntegrationId: enabledTest.PAYMOB_CARD_INTEGRATION_ID,
        checkoutExpirationSeconds: 3600,
      },
    });
  });

  it('accepts syntactically safe live configuration without claiming provider ownership', () => {
    expect(parseStandaloneCreditBillingConfig(enabledLive).enabled).toBe(true);
  });

  it.each(['1', 'yes', 'TRUE', '', true])(
    'rejects malformed flag %s',
    (flag) => {
      expect(() =>
        parseStandaloneCreditBillingConfig({
          STANDALONE_CREDIT_BILLING_ENABLED: flag,
        }),
      ).toThrow('STANDALONE_CREDIT_BILLING_ENABLED');
    },
  );

  it.each(Object.keys(enabledTest).filter((key) => key.startsWith('PAYMOB_')))(
    'requires %s in enabled mode',
    (key) => {
      expect(() =>
        parseStandaloneCreditBillingConfig({
          ...enabledTest,
          [key]: undefined,
        }),
      ).toThrow(key);
    },
  );

  it.each([
    ['STANDALONE_CREDIT_PRICE_MINOR', '1.5'],
    ['STANDALONE_FREE_GRANT', '0'],
    ['STANDALONE_PURCHASE_MIN', '101'],
    ['STANDALONE_PURCHASE_MAX', '50'],
    ['STANDALONE_PURCHASE_STEP', '0'],
    ['STANDALONE_LOW_BALANCE_THRESHOLD', '-1'],
    ['STANDALONE_CREDIT_PRICE_MINOR', '2147483647'],
    ['PAYMOB_CHECKOUT_EXPIRATION_SECONDS', '1e3'],
    ['PAYMOB_MODE', 'production'],
    ['PAYMOB_SECRET_KEY', 'your-secret-here'],
    ['PAYMOB_HMAC_SECRET', 'placeholder'],
    ['PAYMOB_WALLET_INTEGRATION_ID', enabledTest.PAYMOB_CARD_INTEGRATION_ID],
  ])('rejects inconsistent %s', (key, value) => {
    expect(() =>
      parseStandaloneCreditBillingConfig({ ...enabledTest, [key]: value }),
    ).toThrow();
  });

  it.each([
    'http://api.akeed.net',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://api.internal',
    'https://example.com',
    'https://api.invalid',
    'https://sandbox.akeed.net',
    'https://user:password@api.akeed.net',
    'https://127.0.0.1.nip.io',
  ])('rejects unsafe live callback origin %s', (origin) => {
    expect(() =>
      parseStandaloneCreditBillingConfig({
        ...enabledLive,
        PAYMOB_CALLBACK_URL: `${origin}/api/webhooks/payments/paymob`,
      }),
    ).toThrow('PAYMOB_CALLBACK_URL');
  });

  it('rejects detectable credential mode mismatch without printing credentials', () => {
    expect(() =>
      parseStandaloneCreditBillingConfig({
        ...enabledLive,
        PAYMOB_SECRET_KEY: enabledTest.PAYMOB_SECRET_KEY,
      }),
    ).toThrow('PAYMOB_SECRET_KEY conflicts');
    try {
      parseStandaloneCreditBillingConfig({
        ...enabledLive,
        PAYMOB_SECRET_KEY: enabledTest.PAYMOB_SECRET_KEY,
      });
    } catch (error) {
      expect(String(error)).not.toContain(enabledTest.PAYMOB_SECRET_KEY);
    }
  });
});
