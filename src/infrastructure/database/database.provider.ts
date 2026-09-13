import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from './schema';
import * as relationDefinitions from './relations';

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
const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;

/**
 * On the session pooler (5432 on *.pooler.supabase.com) every client
 * connection holds a server slot until it closes, and the project allows only
 * `pool_size` of them (15 on the smallest plan). postgres.js otherwise keeps
 * idle connections open forever, so a dev restart, a test run or a second
 * instance can take the remaining slots and every request fails with
 * EMAXCONNSESSION. Cap the pool and release idle connections.
 */
export function readPoolMax(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX;
}

export const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const databaseUrl = configService.get<string>('DATABASE_URL');

    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not defined in environment variables');
    }

    const pooled = usesTransactionPooler(databaseUrl);
    const poolMax = readPoolMax(configService.get<string>('DATABASE_POOL_MAX'));
    const client = postgres(databaseUrl, {
      prepare: !pooled,
      max: poolMax,
      idle_timeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
    });
    new Logger('DatabaseProvider').log(
      JSON.stringify({
        app: 'backend',
        module: 'DatabaseProvider',
        action: 'database-client-init',
        outcome: 'success',
        transactionPooler: pooled,
        preparedStatements: !pooled,
        poolMax,
      }),
    );
    const db = drizzle(client, { schema });

    return db;
  },
};

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
