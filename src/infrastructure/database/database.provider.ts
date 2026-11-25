import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from './schema';
import * as relationDefinitions from './relations';
import { instrumentPostgresClient } from './query-instrumentation';
import { boundPostgresClient } from './query-deadline';
import {
  DATABASE_RESILIENCE_DEFAULTS,
  readDatabaseResilienceConfig,
  type DatabaseResilienceConfig,
} from '../../shared/config/database-resilience.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  currentRequestContext,
  noteConnection,
  noteConnectionClosed,
} from '../../shared/request-context/request-context';
import {
  DATABASE_POOL_CONTROL,
  DatabasePoolControl,
} from './database-pool-control';
import { pingWithFreshClient } from './pool-health';
import { createSwappableClient } from './swappable-client';

const schema = { ...tables, ...relationDefinitions };

export const DRIZZLE = Symbol('DRIZZLE');

/**
 * Supabase's Supavisor pooler listens on 6543 in *transaction* mode: a server
 * backend is only borrowed for the length of one transaction. postgres.js
 * defaults to `prepare: true`, which names its prepared statements and reuses
 * them across statements, and those names do not survive that hand-off.
 *
 * The failure is not an error. Under concurrency the driver still resolves and
 * still hands back `RETURNING` values, while Postgres rolls the transaction
 * back — measured at 86% silent loss with 8 concurrent transactions, and 0%
 * with `prepare: false`. That is how manual orders were reported created, with
 * a real order id, and never existed in the database.
 *
 * Detected rather than hardcoded so a direct 5432 connection keeps prepared
 * statements, which is where they are both safe and worth having.
 */
export function usesTransactionPooler(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.port === '6543' || url.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}

const DEFAULT_POOL_MAX = 10;
/**
 * On the session pooler (5432 on *.pooler.supabase.com) every client
 * connection holds a server slot until it closes, and the project allows only
 * `pool_size` of them (15 on the smallest plan). postgres.js otherwise keeps
 * idle connections open forever, so a dev restart, a test run or a second
 * instance can take the remaining slots and every request fails with
 * EMAXCONNSESSION. Cap the pool and release idle connections quickly there.
 */
// Keep the production defaults until the boot probe and request counters
// establish the cost of reopening connections. Transaction-pool deployments
// can then opt in to a longer idle timeout without raising the pool maximum.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPoolMax(value: string | undefined): number {
  return readPositiveInteger(value, DEFAULT_POOL_MAX);
}

export interface PoolOptions {
  transactionPooler: boolean;
  prepare: boolean;
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  max_lifetime: number;
}

/**
 * `connect_timeout` bounds opening a connection. `max_lifetime` replaces a
 * connection after a fixed age instead of the driver's random 30 to 60
 * minutes. Neither can free a connection whose statement never returns: the
 * driver retires a connection only once its statement settles. The statement
 * and transaction deadlines (`boundPostgresClient`) and the pool watchdog
 * cover that case.
 */
export function buildPoolOptions(
  databaseUrl: string,
  env: {
    DATABASE_POOL_MAX?: string;
    DATABASE_IDLE_TIMEOUT_SECONDS?: string;
  },
  resilience: Pick<
    DatabaseResilienceConfig,
    'connectTimeoutSeconds' | 'maxLifetimeSeconds'
  > = DATABASE_RESILIENCE_DEFAULTS,
): PoolOptions {
  const transactionPooler = usesTransactionPooler(databaseUrl);
  return {
    transactionPooler,
    prepare: !transactionPooler,
    max: readPoolMax(env.DATABASE_POOL_MAX),
    idle_timeout: readPositiveInteger(
      env.DATABASE_IDLE_TIMEOUT_SECONDS,
      DEFAULT_IDLE_TIMEOUT_SECONDS,
    ),
    connect_timeout: resilience.connectTimeoutSeconds,
    max_lifetime: resilience.maxLifetimeSeconds,
  };
}

/**
 * Seconds a replaced client keeps serving what already runs on it. A whole
 * transaction may take `transactionTimeoutMs`, so a healthy one finishes;
 * a stuck socket is destroyed at the end of it.
 */
export function drainTimeoutSeconds(
  resilience: Pick<DatabaseResilienceConfig, 'transactionTimeoutMs'>,
): number {
  return Math.max(1, Math.ceil(resilience.transactionTimeoutMs / 1000));
}

function readDatabaseUrl(configService: ConfigService): string {
  const databaseUrl = configService.get<string>('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }
  return databaseUrl;
}

export const databasePoolProvider: Provider = {
  provide: DATABASE_POOL_CONTROL,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const resilience = readDatabaseResilienceConfig(configService);
    // Resolved when the first client is created, so a module whose database
    // handle is replaced never needs DATABASE_URL. Boot validation requires it.
    let settings:
      | { databaseUrl: string; pool: Omit<PoolOptions, 'transactionPooler'> }
      | undefined;
    const connection = () => {
      if (settings) return settings;
      const databaseUrl = readDatabaseUrl(configService);
      const { transactionPooler, ...pool } = buildPoolOptions(
        databaseUrl,
        {
          DATABASE_POOL_MAX: configService.get<string>('DATABASE_POOL_MAX'),
          DATABASE_IDLE_TIMEOUT_SECONDS: configService.get<string>(
            'DATABASE_IDLE_TIMEOUT_SECONDS',
          ),
        },
        resilience,
      );
      new Logger('DatabaseProvider').log(
        JSON.stringify({
          app: 'backend',
          module: 'DatabaseProvider',
          action: 'database-client-init',
          outcome: 'success',
          transactionPooler,
          preparedStatements: pool.prepare,
          poolMax: pool.max,
          idleTimeoutSeconds: pool.idle_timeout,
          connectTimeoutSeconds: pool.connect_timeout,
          maxLifetimeSeconds: pool.max_lifetime,
          queryTimeoutMs: resilience.queryTimeoutMs,
          transactionTimeoutMs: resilience.transactionTimeoutMs,
          poolRecycle: resilience.recycleEnabled,
        }),
      );
      settings = { databaseUrl, pool };
      return settings;
    };
    // postgres.js numbers connections 1..max per client, so a replacement
    // client's connections are told apart by its generation.
    const swappable = createSwappableClient((generation) => {
      const { databaseUrl, pool } = connection();
      return postgres(databaseUrl, {
        ...pool,
        // The first statement after each socket close observes a new generation.
        debug: (connectionId: number) =>
          noteConnection(`${generation}:${connectionId}`),
        onclose: (connectionId: number) =>
          noteConnectionClosed(`${generation}:${connectionId}`),
      });
    });
    return new DatabasePoolControl(swappable, {
      enabled: resilience.recycleEnabled,
      cooldownMs: resilience.recycleCooldownMs,
      drainTimeoutSeconds: drainTimeoutSeconds(resilience),
      deadlineThreshold: resilience.recycleDeadlines,
      deadlineWindowMs: resilience.recycleWindowMs,
      pingFresh: () =>
        pingWithFreshClient(connection().databaseUrl, resilience.pingTimeoutMs),
      logger: new Logger(DatabasePoolControl.name),
    });
  },
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [ConfigService, DATABASE_POOL_CONTROL],
  useFactory: (
    configService: ConfigService,
    control: DatabasePoolControl<postgres.Sql>,
  ) => {
    const resilience = readDatabaseResilienceConfig(configService);
    const logger = new Logger('DatabaseProvider');
    const bounded = boundPostgresClient(control.client, {
      queryTimeoutMs: resilience.queryTimeoutMs,
      transactionTimeoutMs: resilience.transactionTimeoutMs,
      // A plain read outside a transaction is retried once, after a stuck
      // pool has been replaced, instead of failing the request.
      retryReads: true,
      onTimeout: (scope, timeoutMs, { caller, retry }) => {
        const requestId = currentRequestContext()?.requestId;
        logger.warn(
          buildBackendLog('DatabaseProvider', {
            action: 'database-deadline',
            outcome: retry ? 'retry' : 'failure',
            reason: 'timeout',
            scope,
            timeoutMs,
            ...(caller ? { caller } : {}),
            ...(requestId ? { requestId } : {}),
          }),
        );
        return control.noteDeadline();
      },
    });
    const db = drizzle(instrumentPostgresClient(bounded), { schema });

    return db;
  },
};

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
