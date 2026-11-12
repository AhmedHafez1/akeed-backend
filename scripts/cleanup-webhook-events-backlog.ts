/**
 * One-off cleanup of the `webhook_events` backlog, with the same rules as the
 * hourly retention job (`WebhookRetentionRules`):
 *
 *   unlinked_finished  finished, never linked to an order, older than 48h
 *   no_store           no store matched (integration_id IS NULL), older than 48h
 *   before_uninstall   received before the uninstall of a store still
 *                      uninstalled after the 48-hour window
 *   woocommerce_marker_scrub
 *                      WooCommerce create markers past those rules: the payload
 *                      is cleared, the row stays (later deliveries route on it)
 *
 * Shopify GDPR request rows attached to a store are never touched.
 *
 * Run with `npm run cleanup:webhook-events` (dry run: a read-only transaction
 * that prints rows and payload bytes per category and per store) and
 * `npm run cleanup:webhook-events -- --apply` (batched deletes). Reads
 * DATABASE_URL from `.env`, or `.env.<NODE_ENV>`. Optional `--batch-size N`.
 * Output holds counts, store ids and domains, never customer data. Re-running
 * `--apply` is safe: the second run finds nothing.
 */
import dotenv from 'dotenv';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import {
  WebhookEventsRetentionRepository,
  type WebhookRetentionResult,
  type WebhookRetentionSummary,
} from '../src/infrastructure/database/repositories/webhook-events-retention.repository';
import type { DrizzleDB } from '../src/infrastructure/database/database.provider';

type CleanupDb = PostgresJsDatabase<typeof schema>;

export interface CleanupOptions {
  apply?: boolean;
  batchSize?: number;
  now?: Date;
}

export interface CleanupReport {
  before: WebhookRetentionSummary;
  applied?: WebhookRetentionResult;
}

export async function cleanupWebhookEventsBacklog(
  db: CleanupDb,
  options: CleanupOptions = {},
): Promise<CleanupReport> {
  const now = options.now ?? new Date();
  // The dry run cannot write: its only statements run in a read-only
  // transaction.
  const before = await db.transaction(
    (tx) =>
      new WebhookEventsRetentionRepository(
        tx as unknown as DrizzleDB,
      ).summarize(now),
    { accessMode: 'read only' },
  );
  if (!options.apply) return { before };

  const applied = await new WebhookEventsRetentionRepository(
    db as unknown as DrizzleDB,
  ).run({ now, batchSize: options.batchSize ?? 1_000, maxPasses: 10_000 });
  return { before, applied };
}

const LABEL = '[cleanup-webhook-events-backlog]';

function printSummary(summary: WebhookRetentionSummary): void {
  for (const category of summary.categories)
    console.log(
      `${LABEL} category=${category.category} rows=${category.rows} payloadBytes=${category.payloadBytes}`,
    );
  for (const store of summary.stores)
    console.log(
      `${LABEL}   category=${store.category} integration=${store.integrationId ?? 'none'} ` +
        `platform=${store.platform} store=${store.storeDomain} rows=${store.rows} payloadBytes=${store.payloadBytes}`,
    );
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  dotenv.config({
    path: process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env',
    quiet: true,
  });
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const batchSize = Number(argValue('--batch-size') ?? 1_000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
    throw new Error('--batch-size must be an integer from 1 to 10000');
  const apply = process.argv.includes('--apply');

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const report = await cleanupWebhookEventsBacklog(
      drizzle(client, { schema }),
      { apply, batchSize },
    );
    printSummary(report.before);
    if (!report.applied) {
      console.log(`${LABEL} dry run (add --apply to delete)`);
      return;
    }
    const { deleted, scrubbed, passes, truncated } = report.applied;
    console.log(
      `${LABEL} applied: unlinked_finished=${deleted.unlinked_finished} no_store=${deleted.no_store} ` +
        `before_uninstall=${deleted.before_uninstall} woocommerce_marker_scrub=${scrubbed} ` +
        `batches=${passes} truncated=${truncated}`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `${LABEL} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
