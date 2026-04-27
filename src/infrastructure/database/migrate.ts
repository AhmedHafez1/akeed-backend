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
