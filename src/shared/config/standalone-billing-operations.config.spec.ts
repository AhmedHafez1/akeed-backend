import {
  isStandaloneBillingOperator,
  parseStandaloneBillingOperationsConfig,
} from './standalone-billing-operations.config';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

describe('parseStandaloneBillingOperationsConfig', () => {
  it('ships disabled with nobody allowed to write', () => {
    const config = parseStandaloneBillingOperationsConfig({});
    expect(config.enabled).toBe(false);
    expect(isStandaloneBillingOperator(config, OPERATOR)).toBe(false);
  });

  it('allows only named operators once enabled', () => {
    const config = parseStandaloneBillingOperationsConfig({
      STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
      STANDALONE_BILLING_OPERATOR_IDS: ` ${OPERATOR.toUpperCase()} ,`,
    });
    expect(isStandaloneBillingOperator(config, OPERATOR)).toBe(true);
    expect(
      isStandaloneBillingOperator(
        config,
        '0f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a',
      ),
    ).toBe(false);
  });

  it('keeps a named operator out while the switch is off', () => {
    const config = parseStandaloneBillingOperationsConfig({
      STANDALONE_BILLING_OPERATOR_IDS: OPERATOR,
    });
    expect(isStandaloneBillingOperator(config, OPERATOR)).toBe(false);
  });

  it('refuses to boot enabled with an empty allowlist', () => {
    expect(() =>
      parseStandaloneBillingOperationsConfig({
        STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
      }),
    ).toThrow(/must name at least one staff user/);
  });

  it.each(['staff@example.com', `${OPERATOR},not-a-uuid`])(
    'refuses an allowlist entry that is not a staff user id: %s',
    (value) => {
      expect(() =>
        parseStandaloneBillingOperationsConfig({
          STANDALONE_BILLING_OPERATOR_IDS: value,
        }),
      ).toThrow(/comma-separated list of staff user UUIDs/);
    },
  );

  it('refuses an ambiguous switch value', () => {
    expect(() =>
      parseStandaloneBillingOperationsConfig({
        STANDALONE_BILLING_OPERATIONS_ENABLED: 'yes',
      }),
    ).toThrow(/must be true or false/);
  });
});
