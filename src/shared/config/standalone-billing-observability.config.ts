export const STANDALONE_BILLING_OBSERVABILITY_CONFIG =
  'standaloneBillingObservability';

export interface StandaloneBillingObservabilityConfig {
  scheduledInquiryEnabled: boolean;
  reportOnly: boolean;
  cron: string;
  timezone: string;
  batchSize: number;
  lookbackDays: number;
  stalePendingMinutes: number;
  backlogAlertCount: number;
  backlogAlertAgeMinutes: number;
  paymobSlowMs: number;
  paymobErrorRatePercent: number;
  paymobErrorRateMinAttempts: number;
}

const INTEGER_DEFAULTS = {
  STANDALONE_BILLING_RECONCILIATION_BATCH_SIZE: 50,
  STANDALONE_BILLING_RECONCILIATION_LOOKBACK_DAYS: 7,
  STANDALONE_BILLING_STALE_PENDING_MINUTES: 30,
  STANDALONE_BILLING_BACKLOG_ALERT_COUNT: 25,
  STANDALONE_BILLING_BACKLOG_ALERT_AGE_MINUTES: 120,
  STANDALONE_BILLING_PAYMOB_SLOW_MS: 5000,
  STANDALONE_BILLING_PAYMOB_ERROR_RATE_PERCENT: 20,
  STANDALONE_BILLING_PAYMOB_ERROR_RATE_MIN_ATTEMPTS: 5,
} as const;

export function parseStandaloneBillingObservabilityConfig(
  source: Record<string, unknown>,
): StandaloneBillingObservabilityConfig {
  const errors: string[] = [];
  const read = (key: string): string =>
    typeof source[key] === 'string' ? source[key].trim() : '';
  const bool = (key: string, fallback: boolean): boolean => {
    const value = read(key);
    if (!value) return fallback;
    if (value !== 'true' && value !== 'false') {
      errors.push(`${key} must be true or false.`);
      return fallback;
    }
    return value === 'true';
  };
  const integer = (
    key: keyof typeof INTEGER_DEFAULTS,
    maximum = 2_147_483_647,
  ): number => {
    const value = read(key);
    if (!value && source[key] === undefined) return INTEGER_DEFAULTS[key];
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > maximum
    ) {
      errors.push(`${key} must be an integer between 1 and ${maximum}.`);
      return INTEGER_DEFAULTS[key];
    }
    return parsed;
  };

  const cron = read('STANDALONE_BILLING_RECONCILIATION_CRON') || '30 2 * * *';
  if (cron.split(/\s+/).length !== 5)
    errors.push(
      'STANDALONE_BILLING_RECONCILIATION_CRON must be a five-field cron expression.',
    );
  const timezone =
    read('STANDALONE_BILLING_RECONCILIATION_TIMEZONE') || 'Africa/Cairo';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    errors.push(
      'STANDALONE_BILLING_RECONCILIATION_TIMEZONE must be a valid IANA timezone.',
    );
  }

  const config: StandaloneBillingObservabilityConfig = {
    scheduledInquiryEnabled: bool(
      'STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED',
      false,
    ),
    reportOnly: bool('STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY', true),
    cron,
    timezone,
    batchSize: integer('STANDALONE_BILLING_RECONCILIATION_BATCH_SIZE', 100),
    lookbackDays: integer(
      'STANDALONE_BILLING_RECONCILIATION_LOOKBACK_DAYS',
      365,
    ),
    stalePendingMinutes: integer(
      'STANDALONE_BILLING_STALE_PENDING_MINUTES',
      1440,
    ),
    backlogAlertCount: integer(
      'STANDALONE_BILLING_BACKLOG_ALERT_COUNT',
      100_000,
    ),
    backlogAlertAgeMinutes: integer(
      'STANDALONE_BILLING_BACKLOG_ALERT_AGE_MINUTES',
      525_600,
    ),
    paymobSlowMs: integer('STANDALONE_BILLING_PAYMOB_SLOW_MS', 300_000),
    paymobErrorRatePercent: integer(
      'STANDALONE_BILLING_PAYMOB_ERROR_RATE_PERCENT',
      100,
    ),
    paymobErrorRateMinAttempts: integer(
      'STANDALONE_BILLING_PAYMOB_ERROR_RATE_MIN_ATTEMPTS',
      10_000,
    ),
  };
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return config;
}

export function readStandaloneBillingObservabilityConfig(config: {
  get<T>(key: string): T | undefined;
}): StandaloneBillingObservabilityConfig {
  const value = config.get<StandaloneBillingObservabilityConfig>(
    STANDALONE_BILLING_OBSERVABILITY_CONFIG,
  );
  if (!value)
    throw new Error(
      'Standalone billing observability configuration was not validated',
    );
  return value;
}
