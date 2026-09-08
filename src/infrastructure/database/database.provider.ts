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

export const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const databaseUrl = configService.get<string>('DATABASE_URL');

    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not defined in environment variables');
    }

    const pooled = usesTransactionPooler(databaseUrl);
    const client = postgres(databaseUrl, { prepare: !pooled });
    new Logger('DatabaseProvider').log(
      JSON.stringify({
        app: 'backend',
        module: 'DatabaseProvider',
        action: 'database-client-init',
        outcome: 'success',
        transactionPooler: pooled,
        preparedStatements: !pooled,
      }),
    );
    const db = drizzle(client, { schema });

    return db;
  },
};

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
