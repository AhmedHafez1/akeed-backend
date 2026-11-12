/**
 * One-off backfill of admin order intake (`integration_order_intake` and its
 * dedupe ledger) from the order.create events still in `webhook_events`.
 *
 * Finished events older than 48 hours that never linked an order are deleted
 * by the retention job, so older skipped orders are gone: the backfill counts
 * what is left (everything from the last 48 hours, and linked, eligible orders
 * from before that), from at most 90 days back.
 *
 *   completed  -> eligible
 *   skipped    -> skipped, with the event's skip code
 *
 * Events without a trusted store (no store, an identity mismatch) are left
 * out, as live counting leaves them out. Each store order counts once, oldest
 * delivery first, through the same ledger the live path writes, so re-running
 * `--apply`, or running it after live counting started, never counts twice.
 *
 * Run with `npm run backfill:order-intake` (dry run: a read-only transaction
 * that prints per-store totals) and `npm run backfill:order-intake -- --apply`.
 * Reads DATABASE_URL from `.env`, or `.env.<NODE_ENV>`. Optional
 * `--batch-size N`. Output holds counts, store ids, skip codes and
 * payment-method names, never customer data.
 */
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import type { DrizzleDB } from '../src/infrastructure/database/database.provider';
import { OrderIntakeRepository } from '../src/infrastructure/database/repositories/order-intake.repository';
import { EasyOrdersOrderNormalizer } from '../src/infrastructure/spokes/easyorders/easyorders-order.normalizer';
import { ShopifyOrderNormalizer } from '../src/infrastructure/spokes/shopify/services/shopify-order.normalizer';
import { WooCommerceOrderNormalizer } from '../src/infrastructure/spokes/woocommerce/woocommerce-order.normalizer';
import type { WebhookOrderIntakeIdentity } from '../src/modules/webhook-queue/interfaces/webhook-normalizer.interface';
import { StandaloneManualOrderNormalizer } from '../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import { WebhookJobType } from '../src/modules/webhook-queue/webhook-queue.constants';
import {
  intakeOrderId,
  normalizeIntakePaymentMethod,
  normalizeIntakeSkipReason,
  ORDER_INTAKE_RETENTION_MS,
  type OrderIntakeRecord,
} from '../src/shared/commerce/order-intake.policy';

type BackfillDb = PostgresJsDatabase<typeof schema>;

export interface IntakeEventRow {
  [key: string]: unknown;
  id: string;
  integration_id: string | null;
  platform: string;
  idempotency_key: string;
  status: string;
  last_error: string | null;
  raw_payload: Record<string, unknown> | null;
  received_at: string | Date;
}

/** Skips recorded before the store was known; live counting skips them too. */
const UNTRUSTED_SKIPS = new Set([
  'store_not_connected',
  'missing_source_identity',
  'source_identity_mismatch',
]);

/**
 * `describeIntake` reads the payload only, so the normalizers run here
 * without their dependencies.
 */
const DESCRIBERS: Record<
  string,
  (raw: Record<string, unknown>) => WebhookOrderIntakeIdentity
> = {
  shopify: (raw) => new ShopifyOrderNormalizer({} as never).describeIntake(raw),
  easyorders: (raw) =>
    new EasyOrdersOrderNormalizer(
      ...([{}, {}, {}, {}, {}] as never as ConstructorParameters<
        typeof EasyOrdersOrderNormalizer
      >),
    ).describeIntake(raw),
  woocommerce: (raw) =>
    new WooCommerceOrderNormalizer({} as never, {} as never).describeIntake(
      raw,
    ),
  standalone: (raw) =>
    new StandaloneManualOrderNormalizer().describeIntake(raw),
};

/** The intake record for one finished order.create event, or null. */
export function toIntakeRecord(row: IntakeEventRow): OrderIntakeRecord | null {
  if (!row.integration_id) return null;
  if (row.status !== 'completed' && row.status !== 'skipped') return null;
  const skipReason = row.status === 'skipped' ? (row.last_error ?? '') : null;
  if (skipReason !== null && UNTRUSTED_SKIPS.has(skipReason)) return null;
  const describe = Object.hasOwn(DESCRIBERS, row.platform)
    ? DESCRIBERS[row.platform]
    : undefined;
  const identity = describe && row.raw_payload ? describe(row.raw_payload) : {};
  const receivedAt = new Date(row.received_at);
  if (Number.isNaN(receivedAt.getTime())) return null;
  return {
    integrationId: row.integration_id,
    externalOrderId:
      intakeOrderId(identity.externalOrderId) ??
      `event:${row.idempotency_key || row.id}`,
    receivedAt,
    outcome: row.status === 'completed' ? 'eligible' : 'skipped',
    skipReason: skipReason === null ? null : skipReason || 'unknown',
    paymentMethod: identity.paymentMethod,
  };
}

export interface StoreIntakeTotals {
  orders: number;
  eligible: number;
  skipped: Record<string, number>;
  paymentMethods: Record<string, number>;
}

export interface BackfillReport {
  events: number;
  orders: number;
  /** Orders newly counted; 0 on a dry run. */
  counted: number;
  stores: Map<string, StoreIntakeTotals>;
}

export async function backfillOrderIntake(
  db: BackfillDb,
  options: { apply?: boolean; batchSize?: number; now?: Date } = {},
): Promise<BackfillReport> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ORDER_INTAKE_RETENTION_MS);
  const batchSize = options.batchSize ?? 500;
  const repository = new OrderIntakeRepository(db as unknown as DrizzleDB);
  const report: BackfillReport = {
    events: 0,
    orders: 0,
    counted: 0,
    stores: new Map(),
  };
  const seen = new Set<string>();

  const readBatch = async (
    reader: BackfillDb,
    cursor: { at: string; id: string } | null,
  ) =>
    Array.from(
      await reader.execute<IntakeEventRow>(sql`
        SELECT id, integration_id, platform, idempotency_key, status::text AS status,
          last_error, raw_payload, COALESCE(received_at, created_at) AS received_at
        FROM webhook_events
        WHERE job_type = ${WebhookJobType.ORDER_CREATE}
          AND status IN ('completed', 'skipped')
          AND integration_id IS NOT NULL
          AND COALESCE(received_at, created_at) >= ${since.toISOString()}::timestamptz
          ${cursor ? sql`AND (COALESCE(received_at, created_at), id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        ORDER BY COALESCE(received_at, created_at), id
        LIMIT ${batchSize}`),
    );

  const scan = async (reader: BackfillDb) => {
    let cursor: { at: string; id: string } | null = null;
    for (;;) {
      const rows = await readBatch(reader, cursor);
      if (rows.length === 0) return;
      for (const row of rows) {
        report.events++;
        const record = toIntakeRecord(row);
        if (!record) continue;
        const key = `${record.integrationId}\u0000${record.externalOrderId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report.orders++;
        tally(report, record);
        if (options.apply && (await repository.record(record)))
          report.counted++;
      }
      const last = rows[rows.length - 1];
      cursor = { at: new Date(last.received_at).toISOString(), id: last.id };
      if (rows.length < batchSize) return;
    }
  };

  if (options.apply) await scan(db);
  // The dry run cannot write: its only statements run in a read-only
  // transaction.
  else
    await db.transaction((tx) => scan(tx as unknown as BackfillDb), {
      accessMode: 'read only',
    });
  return report;
}

function tally(report: BackfillReport, record: OrderIntakeRecord): void {
  const store = report.stores.get(record.integrationId) ?? {
    orders: 0,
    eligible: 0,
    skipped: {},
    paymentMethods: {},
  };
  store.orders++;
  if (record.outcome === 'eligible') store.eligible++;
  else {
    const reason = normalizeIntakeSkipReason(record.skipReason ?? 'unknown');
    store.skipped[reason] = (store.skipped[reason] ?? 0) + 1;
  }
  const method = normalizeIntakePaymentMethod(record.paymentMethod);
  store.paymentMethods[method] = (store.paymentMethods[method] ?? 0) + 1;
  report.stores.set(record.integrationId, store);
}

const LABEL = '[backfill-order-intake]';

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

  const batchSize = Number(argValue('--batch-size') ?? 500);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000)
    throw new Error('--batch-size must be an integer from 1 to 5000');
  const apply = process.argv.includes('--apply');

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const report = await backfillOrderIntake(drizzle(client, { schema }), {
      apply,
      batchSize,
    });
    for (const [integrationId, store] of report.stores)
      console.log(
        `${LABEL} integration=${integrationId} orders=${store.orders} eligible=${store.eligible} ` +
          `skipped=${JSON.stringify(store.skipped)} paymentMethods=${JSON.stringify(store.paymentMethods)}`,
      );
    console.log(
      `${LABEL} events=${report.events} orders=${report.orders} stores=${report.stores.size}` +
        (apply
          ? ` counted=${report.counted}`
          : ' dry run (add --apply to write)'),
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
