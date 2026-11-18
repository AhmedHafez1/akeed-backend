import {
  DATABASE_RESILIENCE_CONFIG,
  DATABASE_RESILIENCE_DEFAULTS,
  parseDatabaseResilienceConfig,
  readDatabaseResilienceConfig,
} from './database-resilience.config';

describe('parseDatabaseResilienceConfig', () => {
  it('uses the defaults when nothing is set', () => {
    expect(parseDatabaseResilienceConfig({ NODE_ENV: 'production' })).toEqual({
      connectTimeoutSeconds: 10,
      maxLifetimeSeconds: 900,
      queryTimeoutMs: 30_000,
      transactionTimeoutMs: 60_000,
      pingTimeoutMs: 5_000,
      watchdogEnabled: true,
      watchdogIntervalMs: 15_000,
      watchdogFailures: 4,
    });
  });

  it('honours overrides', () => {
    expect(
      parseDatabaseResilienceConfig({
        DATABASE_CONNECT_TIMEOUT_SECONDS: '5',
        DATABASE_MAX_LIFETIME_SECONDS: ' 600 ',
        DATABASE_QUERY_TIMEOUT_MS: '20000',
        DATABASE_TRANSACTION_TIMEOUT_MS: '45000',
        DATABASE_PING_TIMEOUT_MS: '3000',
        DATABASE_POOL_WATCHDOG: 'false',
        DATABASE_POOL_WATCHDOG_INTERVAL_MS: '10000',
        DATABASE_POOL_WATCHDOG_FAILURES: '6',
      }),
    ).toEqual({
      connectTimeoutSeconds: 5,
      maxLifetimeSeconds: 600,
      queryTimeoutMs: 20_000,
      transactionTimeoutMs: 45_000,
      pingTimeoutMs: 3_000,
      watchdogEnabled: false,
      watchdogIntervalMs: 10_000,
      watchdogFailures: 6,
    });
  });

  it('keeps the watchdog off under tests', () => {
    expect(
      parseDatabaseResilienceConfig({
        NODE_ENV: 'test',
        DATABASE_POOL_WATCHDOG: 'true',
      }).watchdogEnabled,
    ).toBe(false);
  });

  it.each([
    ['DATABASE_QUERY_TIMEOUT_MS', '0'],
    ['DATABASE_QUERY_TIMEOUT_MS', '-5'],
    ['DATABASE_CONNECT_TIMEOUT_SECONDS', '2.5'],
    ['DATABASE_POOL_WATCHDOG_FAILURES', 'four'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => parseDatabaseResilienceConfig({ [key]: value })).toThrow(
      `${key} must be a positive whole number.`,
    );
  });

  it('rejects a watchdog flag that is not true or false', () => {
    expect(() =>
      parseDatabaseResilienceConfig({ DATABASE_POOL_WATCHDOG: 'yes' }),
    ).toThrow('DATABASE_POOL_WATCHDOG must be true or false.');
  });

  it('rejects a transaction deadline shorter than a statement deadline', () => {
    expect(() =>
      parseDatabaseResilienceConfig({
        DATABASE_QUERY_TIMEOUT_MS: '40000',
        DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
      }),
    ).toThrow('DATABASE_TRANSACTION_TIMEOUT_MS must be at least');
  });

  it('rejects a ping deadline that overlaps the next check', () => {
    expect(() =>
      parseDatabaseResilienceConfig({
        DATABASE_PING_TIMEOUT_MS: '15000',
      }),
    ).toThrow('DATABASE_PING_TIMEOUT_MS must be shorter than');
  });
});

describe('readDatabaseResilienceConfig', () => {
  it('reads the validated entry', () => {
    const parsed = { ...DATABASE_RESILIENCE_DEFAULTS, queryTimeoutMs: 1 };
    const config = {
      get: <T>(key: string) =>
        (key === DATABASE_RESILIENCE_CONFIG ? parsed : undefined) as T,
    };
    expect(readDatabaseResilienceConfig(config)).toBe(parsed);
  });

  it('keeps defaults and no watchdog when the environment was never validated', () => {
    expect(readDatabaseResilienceConfig({ get: () => undefined })).toEqual({
      ...DATABASE_RESILIENCE_DEFAULTS,
      watchdogEnabled: false,
    });
  });
});
