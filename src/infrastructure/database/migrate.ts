import * as dotenv from 'dotenv';
import * as path from 'path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const MIGRATION_LOCK_ID = 29160427;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Drizzle reports only "Failed query: <sql>" and keeps the Postgres error in
// `cause`. Surface its code and message so a failed boot names the real
// problem. `detail` and `where` are left out because they can carry row values.
function withDatabaseCause(error: unknown): unknown {
  if (!(error instanceof Error) || typeof error.cause !== 'object') {
    return error;
  }

  const cause = error.cause as { code?: unknown; message?: unknown } | null;
  if (typeof cause?.message !== 'string') {
    return error;
  }

  const code = typeof cause.code === 'string' ? `${cause.code} ` : '';
  return new Error(`${error.message}\n  cause: ${code}${cause.message}`, {
    cause: error,
  });
}

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }

  console.log(`[Migrate] Applying pending migrations (env: ${envFile})...`);

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  let lockAcquired = false;

  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    lockAcquired = true;

    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
    }).catch((error: unknown) => {
      throw withDatabaseCause(error);
    });

    console.log('[Migrate] All migrations applied successfully.');
  } finally {
    if (lockAcquired) {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
    }

    await sql.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err: unknown) => {
    console.error(`[Migrate] Migration failed: ${getErrorMessage(err)}`);
    process.exit(1);
  });
}
