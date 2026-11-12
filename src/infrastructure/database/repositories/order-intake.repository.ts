import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  intakeBucketStart,
  normalizeIntakePaymentMethod,
  normalizeIntakeSkipReason,
  ORDER_INTAKE_MAX_PAYMENT_METHODS,
  ORDER_INTAKE_OTHER_PAYMENT_METHOD,
  type OrderIntakeRecord,
} from '../../../shared/commerce/order-intake.policy';

export interface OrderIntakeRetentionResult {
  orders: number;
  buckets: number;
  truncated: boolean;
}

/**
 * Per-store order.create counts. A store order is counted once, however many
 * times it is delivered: the ledger row is inserted first, and the hourly
 * counts move only when that insert added a row. Both run in one transaction,
 * so a retry after a failure counts the order exactly once too.
 */
@Injectable()
export class OrderIntakeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Answers whether the order was new and counted. */
  async record(input: OrderIntakeRecord): Promise<boolean> {
    const receivedAt = input.receivedAt.toISOString();
    const bucket = intakeBucketStart(input.receivedAt).toISOString();
    const reason =
      input.outcome === 'skipped' && input.skipReason
        ? normalizeIntakeSkipReason(input.skipReason)
        : null;
    const method = normalizeIntakePaymentMethod(input.paymentMethod);
    const eligible = input.outcome === 'eligible' ? 1 : 0;
    const skipped = input.outcome === 'skipped' ? 1 : 0;
    const reasons = reason ? { [reason]: 1 } : {};

    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO integration_order_intake_orders
          (integration_id, external_order_id, received_at, outcome, skip_reason)
        VALUES (${input.integrationId}, ${input.externalOrderId}, ${receivedAt}::timestamptz, ${input.outcome}, ${reason})
        ON CONFLICT (integration_id, external_order_id) DO NOTHING
        RETURNING 1 AS inserted`);
      if (inserted.length === 0) return false;

      // A name already seen this hour keeps its own key; past the cap, new
      // names count as "other" so one bucket stays small.
      const methodKey = sql`(CASE
        WHEN jsonb_exists(t.payment_methods, ${method}::text)
          OR (SELECT count(*) FROM jsonb_object_keys(t.payment_methods)) < ${ORDER_INTAKE_MAX_PAYMENT_METHODS}
        THEN ${method}::text ELSE ${ORDER_INTAKE_OTHER_PAYMENT_METHOD}::text END)`;
      await tx.execute(sql`
        INSERT INTO integration_order_intake AS t
          (integration_id, bucket_start, received, eligible, skipped, skipped_by_reason, payment_methods)
        VALUES (
          ${input.integrationId}, ${bucket}::timestamptz, 1, ${eligible}, ${skipped},
          ${JSON.stringify(reasons)}::jsonb, jsonb_build_object(${method}::text, 1))
        ON CONFLICT (integration_id, bucket_start) DO UPDATE SET
          received = t.received + 1,
          eligible = t.eligible + EXCLUDED.eligible,
          skipped = t.skipped + EXCLUDED.skipped,
          skipped_by_reason = (CASE WHEN ${reason}::text IS NULL THEN t.skipped_by_reason
            ELSE jsonb_set(t.skipped_by_reason, ARRAY[${reason}::text],
              to_jsonb(COALESCE((t.skipped_by_reason ->> ${reason}::text)::int, 0) + 1)) END),
          payment_methods = jsonb_set(t.payment_methods, ARRAY[${methodKey}],
            to_jsonb(COALESCE((t.payment_methods ->> ${methodKey})::int, 0) + 1)),
          updated_at = now()`);
      return true;
    });
  }

  /** Deletes ledger rows and hourly counts older than `cutoff`, in batches. */
  async deleteOlderThan(
    cutoff: Date,
    options: { batchSize?: number; maxPasses?: number } = {},
  ): Promise<OrderIntakeRetentionResult> {
    const batchSize = options.batchSize ?? 1_000;
    const maxPasses = options.maxPasses ?? 100;
    const before = cutoff.toISOString();
    const result: OrderIntakeRetentionResult = {
      orders: 0,
      buckets: 0,
      truncated: false,
    };
    const drain = async (batch: () => Promise<number>) => {
      let total = 0;
      for (let pass = 0; pass < maxPasses; pass++) {
        const affected = await batch();
        total += affected;
        if (affected < batchSize) return total;
      }
      result.truncated = true;
      return total;
    };

    result.orders = await drain(async () => {
      const rows = await this.db.execute(sql`
        DELETE FROM integration_order_intake_orders o
        WHERE (o.integration_id, o.external_order_id) IN (
          SELECT c.integration_id, c.external_order_id
          FROM integration_order_intake_orders c
          WHERE c.received_at < ${before}::timestamptz
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED)
        RETURNING 1`);
      return rows.length;
    });
    result.buckets = await drain(async () => {
      const rows = await this.db.execute(sql`
        DELETE FROM integration_order_intake b
        WHERE (b.integration_id, b.bucket_start) IN (
          SELECT c.integration_id, c.bucket_start
          FROM integration_order_intake c
          WHERE c.bucket_start < ${before}::timestamptz
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED)
        RETURNING 1`);
      return rows.length;
    });
    return result;
  }
}
