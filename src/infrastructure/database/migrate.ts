import * as dotenv from 'dotenv';
import * as path from 'path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }

  console.log(`[Migrate] Applying pending migrations (env: ${envFile})...`);

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
  });

  console.log('[Migrate] All migrations applied successfully.');
  await sql.end();
}

runMigrations().catch((err) => {
  console.error('[Migrate] Migration failed:', err);
  process.exit(1);
});
