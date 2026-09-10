import {
  parseStandaloneBillingObservabilityConfig,
  readStandaloneBillingObservabilityConfig,
  STANDALONE_BILLING_OBSERVABILITY_CONFIG,
} from './standalone-billing-observability.config';

describe('Standalone billing observability configuration', () => {
  it('uses the conservative rollout defaults', () => {
    expect(parseStandaloneBillingObservabilityConfig({})).toEqual({
      scheduledInquiryEnabled: false,
      reportOnly: true,
      cron: '30 2 * * *',
      timezone: 'Africa/Cairo',
      batchSize: 50,
      lookbackDays: 7,
      stalePendingMinutes: 30,
      backlogAlertCount: 25,
      backlogAlertAgeMinutes: 120,
      paymobSlowMs: 5000,
      paymobErrorRatePercent: 20,
      paymobErrorRateMinAttempts: 5,
    });
  });

  it.each([
    ['STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED', 'yes'],
    ['STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY', '1'],
    ['STANDALONE_BILLING_RECONCILIATION_BATCH_SIZE', '0'],
    ['STANDALONE_BILLING_PAYMOB_ERROR_RATE_PERCENT', '101'],
    ['STANDALONE_BILLING_RECONCILIATION_CRON', 'not cron'],
    ['STANDALONE_BILLING_RECONCILIATION_TIMEZONE', 'Cairo-ish'],
  ])('rejects %s=%s', (key, value) => {
    expect(() =>
      parseStandaloneBillingObservabilityConfig({ [key]: value }),
    ).toThrow(key);
  });

  it('reads only the startup-validated object', () => {
    const parsed = parseStandaloneBillingObservabilityConfig({});
    expect(
      readStandaloneBillingObservabilityConfig({
        get: <T>(key: string): T | undefined =>
          (key === STANDALONE_BILLING_OBSERVABILITY_CONFIG
            ? parsed
            : undefined) as T | undefined,
      }),
    ).toBe(parsed);
  });
});
