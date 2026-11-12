import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { GDPR_WEBHOOK_JOB_TYPES } from './store-data-deletion.repository';

/**
 * How long a finished webhook row is kept. Shopify retries a delivery for up
 * to 48 hours, so inside this window the row is still the idempotency record
 * that answers a resend as a duplicate. After it, an order-linked row is the
 * only one any reader still needs (merchant retry and lifecycle projection).
 */
export const WEBHOOK_EVENT_RETENTION_MS = 48 * 60 * 60 * 1000;

export const WEBHOOK_RETENTION_CATEGORIES = [
  'unlinked_finished',
  'no_store',
  'before_uninstall',
] as const;

export type WebhookRetentionCategory =
  (typeof WEBHOOK_RETENTION_CATEGORIES)[number];

/** Rows whose payload is cleared but which stay, see `wooCommerceMarker`. */
export const WEBHOOK_SCRUB_CATEGORY = 'woocommerce_marker_scrub';

export interface WebhookRetentionCategoryCount {
  category: WebhookRetentionCategory | typeof WEBHOOK_SCRUB_CATEGORY;
  rows: number;
  payloadBytes: number;
}

export interface WebhookRetentionStoreCount extends WebhookRetentionCategoryCount {
  integrationId: string | null;
  platform: string;
  storeDomain: string;
}

export interface WebhookRetentionSummary {
  categories: WebhookRetentionCategoryCount[];
  stores: WebhookRetentionStoreCount[];
}

export interface WebhookRetentionResult {
  deleted: Record<WebhookRetentionCategory, number>;
  scrubbed: number;
  passes: number;
  /** True when a category still had rows after `maxPasses`. */
  truncated: boolean;
}

const gdprJobTypes = sql.join(
  GDPR_WEBHOOK_JOB_TYPES.map((type) => sql`${type}`),
  sql`, `,
);

/**
 * The retention rules, in one place for the recurring job and the one-off
 * backlog script. `w` is the `webhook_events` alias; `cutoff` and `now` are
 * bound parameters so a test or a dry run can fix the clock.
 */
export class WebhookRetentionRules {
  constructor(
    private readonly now: Date,
    private readonly retentionMs = WEBHOOK_EVENT_RETENTION_MS,
  ) {}

  private get cutoff(): SQL {
    return sql`${new Date(this.now.getTime() - this.retentionMs).toISOString()}::timestamptz`;
  }

  private get nowParam(): SQL {
    return sql`${this.now.toISOString()}::timestamptz`;
  }

  private receivedAt(alias: string): SQL {
    return sql`COALESCE(${sql.raw(alias)}.received_at, ${sql.raw(alias)}.created_at)`;
  }

  /**
   * WooCommerce's first delivery for an order is stored under the fixed key
   * `order.create:<integration>:<order>`. `WooCommerceWebhookService.holdOf`
   * reads its status and last_error, at any age, to route later deliveries
   * for that order as updates. Deleting it would let an old order start a
   * verification, so it is kept and only its payload is cleared.
   */
  wooCommerceMarker(alias: string): SQL {
    const w = sql.raw(alias);
    return sql`(${w}.platform = 'woocommerce'
      AND ${w}.integration_id IS NOT NULL
      AND ${w}.idempotency_key LIKE 'order.create:' || ${w}.integration_id::text || ':%')`;
  }

  /** Request rows of Shopify GDPR webhooks (ids only), kept as the record. */
  private gdprRequest(alias: string): SQL {
    return sql`${sql.raw(alias)}.job_type IN (${gdprJobTypes})`;
  }

  /** A store's latest uninstall, from its lifecycle history. */
  private lastUninstalledAt(alias: string): SQL {
    return sql`(SELECT max(l.uninstalled_at) FROM admin_store_lifecycles l
      WHERE l.integration_id = ${sql.raw(alias)}.integration_id)`;
  }

  predicate(category: WebhookRetentionCategory, alias = 'w'): SQL {
    const w = sql.raw(alias);
    switch (category) {
      // Finished, never linked to an order, past the resend window, and not
      // waiting on anything: nothing reads it again.
      case 'unlinked_finished':
        return sql`(${w}.order_id IS NULL
          AND ${w}.integration_id IS NOT NULL
          AND ${w}.status IN ('completed', 'skipped', 'failed')
          AND ${w}.hold_state <> 'held'
          AND ${w}.dispatch_required = false
          AND ${this.receivedAt(alias)} < ${this.cutoff}
          AND NOT ${this.gdprRequest(alias)}
          AND NOT ${this.wooCommerceMarker(alias)})`;
      // No store ever matched it, so it can never be processed (pending
      // included) and no store-scoped reader can see it.
      case 'no_store':
        return sql`(${w}.integration_id IS NULL
          AND ${this.receivedAt(alias)} < ${this.cutoff})`;
      // Received before the store's last uninstall; that uninstall already
      // deleted the orders these rows belonged to. A row a worker holds a
      // live processing lease on is left for the next run.
      case 'before_uninstall':
        return sql`(${w}.integration_id IS NOT NULL
          AND ${this.receivedAt(alias)} < ${this.lastUninstalledAt(alias)}
          AND NOT (${w}.status = 'processing'
            AND ${w}.processing_lease_until IS NOT NULL
            AND ${w}.processing_lease_until > ${this.nowParam})
          AND NOT ${this.gdprRequest(alias)}
          AND NOT ${this.wooCommerceMarker(alias)})`;
    }
  }

  /** WooCommerce markers past the same rules, whose payload is not yet cleared. */
  scrubPredicate(alias = 'w'): SQL {
    const w = sql.raw(alias);
    return sql`(${this.wooCommerceMarker(alias)}
      AND ${w}.raw_payload <> '{}'::jsonb
      AND (
        (${w}.order_id IS NULL
          AND ${w}.status IN ('completed', 'skipped', 'failed')
          AND ${w}.hold_state <> 'held'
          AND ${w}.dispatch_required = false
          AND ${this.receivedAt(alias)} < ${this.cutoff})
        OR ${this.receivedAt(alias)} < ${this.lastUninstalledAt(alias)}))`;
  }
}

/**
 * Removes `webhook_events` rows no reader needs any more, in bounded batches.
 * Logs and results hold counts only.
 */
@Injectable()
export class WebhookEventsRetentionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Read-only: rows and payload bytes per category and per store. */
  async summarize(now = new Date()): Promise<WebhookRetentionSummary> {
    const rules = new WebhookRetentionRules(now);
    const parts: SQL[] = [
      ...WEBHOOK_RETENTION_CATEGORIES.map(
        (category) =>
          sql`SELECT ${category}::text AS category, w.integration_id, w.platform, w.store_domain,
              count(*)::int AS rows, COALESCE(sum(pg_column_size(w.raw_payload)), 0)::bigint AS payload_bytes
            FROM webhook_events w WHERE ${rules.predicate(category)}
            GROUP BY w.integration_id, w.platform, w.store_domain`,
      ),
      sql`SELECT ${WEBHOOK_SCRUB_CATEGORY}::text, w.integration_id, w.platform, w.store_domain,
            count(*)::int, COALESCE(sum(pg_column_size(w.raw_payload)), 0)::bigint
          FROM webhook_events w WHERE ${rules.scrubPredicate()}
          GROUP BY w.integration_id, w.platform, w.store_domain`,
    ];
    const rows = (await this.db.execute(
      sql`${sql.join(parts, sql` UNION ALL `)} ORDER BY 1, 5 DESC`,
    )) as unknown as Array<{
      category: WebhookRetentionCategoryCount['category'];
      integration_id: string | null;
      platform: string;
      store_domain: string;
      rows: number;
      payload_bytes: string | number;
    }>;

    const stores: WebhookRetentionStoreCount[] = rows.map((row) => ({
      category: row.category,
      integrationId: row.integration_id,
      platform: row.platform,
      storeDomain: row.store_domain,
      rows: Number(row.rows),
      payloadBytes: Number(row.payload_bytes),
    }));
    const categories = [
      ...WEBHOOK_RETENTION_CATEGORIES,
      WEBHOOK_SCRUB_CATEGORY,
    ].map((category) => {
      const matching = stores.filter((store) => store.category === category);
      return {
        category,
        rows: matching.reduce((sum, store) => sum + store.rows, 0),
        payloadBytes: matching.reduce(
          (sum, store) => sum + store.payloadBytes,
          0,
        ),
      } as WebhookRetentionCategoryCount;
    });
    return { categories, stores };
  }

  /**
   * One bounded batch. The predicate is checked again on the outer statement,
   * so a row that changed after it was picked is left alone, and SKIP LOCKED
   * keeps the job off rows a worker holds.
   */
  async deleteBatch(
    category: WebhookRetentionCategory,
    limit: number,
    now = new Date(),
  ): Promise<number> {
    const rules = new WebhookRetentionRules(now);
    const rows = await this.db.execute(sql`
      DELETE FROM webhook_events w
      WHERE w.id IN (
        SELECT c.id FROM webhook_events c
        WHERE ${rules.predicate(category, 'c')}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
        AND ${rules.predicate(category, 'w')}
      RETURNING w.id`);
    return rows.length;
  }

  async scrubBatch(limit: number, now = new Date()): Promise<number> {
    const rules = new WebhookRetentionRules(now);
    const rows = await this.db.execute(sql`
      UPDATE webhook_events w SET raw_payload = '{}'::jsonb, updated_at = now()
      WHERE w.id IN (
        SELECT c.id FROM webhook_events c
        WHERE ${rules.scrubPredicate('c')}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
        AND ${rules.scrubPredicate('w')}
      RETURNING w.id`);
    return rows.length;
  }

  /** Every category until a short batch, at most `maxPasses` batches each. */
  async run(
    options: { now?: Date; batchSize?: number; maxPasses?: number } = {},
  ): Promise<WebhookRetentionResult> {
    const now = options.now ?? new Date();
    const batchSize = options.batchSize ?? 1_000;
    const maxPasses = options.maxPasses ?? 100;
    const result: WebhookRetentionResult = {
      deleted: { unlinked_finished: 0, no_store: 0, before_uninstall: 0 },
      scrubbed: 0,
      passes: 0,
      truncated: false,
    };

    const drain = async (batch: () => Promise<number>): Promise<number> => {
      let total = 0;
      for (let pass = 0; pass < maxPasses; pass++) {
        const affected = await batch();
        result.passes++;
        total += affected;
        if (affected < batchSize) return total;
      }
      result.truncated = true;
      return total;
    };

    result.scrubbed = await drain(() => this.scrubBatch(batchSize, now));
    for (const category of WEBHOOK_RETENTION_CATEGORIES)
      result.deleted[category] = await drain(() =>
        this.deleteBatch(category, batchSize, now),
      );
    return result;
  }
}
