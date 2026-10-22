/**
 * Fills orders.customer_country for orders stored before migration 0072.
 *
 * The country comes from the stored E.164 phone (`phoneRegion`), the same rule
 * ingest uses. Only NULL rows are touched, so it is safe to re-run and never
 * overwrites a value written at ingest. Orders whose phone gives no country
 * (redacted, non-geographic) stay NULL.
 *
 * Run with `npm run backfill:order-customer-country` (reads DATABASE_URL from
 * `.env`, or `.env.<NODE_ENV>`). Add `--dry-run` to count without writing.
 */
import dotenv from 'dotenv';
import postgres from 'postgres';
import { phoneRegion } from '../src/shared/services/phone.service';

const BATCH_SIZE = 1000;

export interface CustomerCountryBackfillResult {
  scanned: number;
  updated: number;
  unresolved: number;
}

export async function backfillOrderCustomerCountry(
  sql: postgres.Sql,
  options: { dryRun?: boolean; batchSize?: number } = {},
): Promise<CustomerCountryBackfillResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const result: CustomerCountryBackfillResult = {
    scanned: 0,
    updated: 0,
    unresolved: 0,
  };
  let afterId: string | null = null;

  for (;;) {
    const rows: Array<{ id: string; customer_phone: string }> = await sql`
      SELECT id::text AS id, customer_phone
      FROM orders
      WHERE customer_country IS NULL
        AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
      ORDER BY id
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    result.scanned += rows.length;

    const resolved: Array<[string, string]> = [];
    for (const row of rows) {
      const country = phoneRegion(row.customer_phone);
      if (country) resolved.push([row.id, country]);
      else result.unresolved += 1;
    }
    if (resolved.length === 0 || options.dryRun) {
      result.updated += options.dryRun ? resolved.length : 0;
      continue;
    }

    const updated = await sql`
      UPDATE orders AS o
      SET customer_country = v.country
      FROM (VALUES ${sql(resolved)}) AS v (id, country)
      WHERE o.id = v.id::uuid AND o.customer_country IS NULL
    `;
    result.updated += updated.count;
  }

  return result;
}

async function main(): Promise<void> {
  dotenv.config({
    path: process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env',
    quiet: true,
  });
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const dryRun = process.argv.includes('--dry-run');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const result = await backfillOrderCustomerCountry(sql, { dryRun });
    console.log(
      `[backfill-order-customer-country] ${dryRun ? 'dry run: ' : ''}` +
        `scanned=${result.scanned} updated=${result.updated} ` +
        `unresolved=${result.unresolved}`,
    );
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[backfill-order-customer-country] failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
