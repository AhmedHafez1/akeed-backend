export const DATABASE_RESILIENCE_CONFIG = 'databaseResilience';

/**
 * Client-side bounds on the runtime database pool. The Supabase transaction
 * pooler can stop answering on a connection that stays open, and postgres.js
 * waits on an open connection indefinitely, so every wait the application
 * depends on has a deadline here and a stuck pool ends the process.
 */
export interface DatabaseResilienceConfig {
  /** Seconds to open a connection, including TLS and authentication. */
  connectTimeoutSeconds: number;
  /**
   * Seconds before a connection is replaced. postgres.js closes it once its
   * current statement finishes, so this recycles healthy connections only.
   */
  maxLifetimeSeconds: number;
  /** Milliseconds an application statement may take, pool wait included. */
  queryTimeoutMs: number;
  /** Milliseconds a whole transaction may take, BEGIN to COMMIT. */
  transactionTimeoutMs: number;
  /** Milliseconds `select 1` may take in the health check and the watchdog. */
  pingTimeoutMs: number;
  watchdogEnabled: boolean;
  /** Milliseconds between watchdog checks. */
  watchdogIntervalMs: number;
  /** Consecutive missed pings before the process exits. */
  watchdogFailures: number;
}

export const DATABASE_RESILIENCE_DEFAULTS: DatabaseResilienceConfig = {
  connectTimeoutSeconds: 10,
  maxLifetimeSeconds: 900,
  queryTimeoutMs: 30_000,
  transactionTimeoutMs: 60_000,
  pingTimeoutMs: 5_000,
  watchdogEnabled: true,
  watchdogIntervalMs: 15_000,
  watchdogFailures: 4,
};

const INTEGER_VARS = {
  DATABASE_CONNECT_TIMEOUT_SECONDS: 'connectTimeoutSeconds',
  DATABASE_MAX_LIFETIME_SECONDS: 'maxLifetimeSeconds',
  DATABASE_QUERY_TIMEOUT_MS: 'queryTimeoutMs',
  DATABASE_TRANSACTION_TIMEOUT_MS: 'transactionTimeoutMs',
  DATABASE_PING_TIMEOUT_MS: 'pingTimeoutMs',
  DATABASE_POOL_WATCHDOG_INTERVAL_MS: 'watchdogIntervalMs',
  DATABASE_POOL_WATCHDOG_FAILURES: 'watchdogFailures',
} as const satisfies Record<string, keyof DatabaseResilienceConfig>;

function readText(config: Record<string, unknown>, key: string): string {
  const raw = config[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function parseDatabaseResilienceConfig(
  config: Record<string, unknown>,
): DatabaseResilienceConfig {
  const errors: string[] = [];
  const parsed: DatabaseResilienceConfig = { ...DATABASE_RESILIENCE_DEFAULTS };

  for (const [key, field] of Object.entries(INTEGER_VARS)) {
    const text = readText(config, key);
    if (!text) continue;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
      errors.push(`${key} must be a positive whole number.`);
      continue;
    }
    parsed[field] = value;
  }

  const watchdog = readText(config, 'DATABASE_POOL_WATCHDOG');
  if (watchdog && watchdog !== 'true' && watchdog !== 'false') {
    errors.push('DATABASE_POOL_WATCHDOG must be true or false.');
  }
  // Unit and contract suites build the app against disposable databases; a
  // watchdog there would only end a test run.
  parsed.watchdogEnabled =
    watchdog !== 'false' && readText(config, 'NODE_ENV') !== 'test';

  if (errors.length === 0) {
    if (parsed.transactionTimeoutMs < parsed.queryTimeoutMs) {
      errors.push(
        'DATABASE_TRANSACTION_TIMEOUT_MS must be at least DATABASE_QUERY_TIMEOUT_MS.',
      );
    }
    if (parsed.pingTimeoutMs >= parsed.watchdogIntervalMs) {
      errors.push(
        'DATABASE_PING_TIMEOUT_MS must be shorter than DATABASE_POOL_WATCHDOG_INTERVAL_MS.',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  }
  return parsed;
}

/**
 * Without the parsed entry the environment was never validated, which only
 * happens in test modules that skip `validateEnv`: bounds keep their defaults
 * and the watchdog stays off.
 */
export function readDatabaseResilienceConfig(config: {
  get<T>(key: string): T | undefined;
}): DatabaseResilienceConfig {
  return (
    config.get<DatabaseResilienceConfig>(DATABASE_RESILIENCE_CONFIG) ?? {
      ...DATABASE_RESILIENCE_DEFAULTS,
      watchdogEnabled: false,
    }
  );
}
