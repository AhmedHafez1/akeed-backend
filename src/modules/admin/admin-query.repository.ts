import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import type { AdminHealthColumns } from './admin-health-rule.service';

export interface AdminStoreQueryRow {
  [key: string]: unknown;
  integration_id: string;
  organization_name: string;
  store_name: string | null;
  shop_domain: string;
  country_code: string | null;
  timezone: string | null;
  is_active: boolean;
  onboarding_status: string;
  plan: string | null;
  subscription_status: string | null;
  auto_confirmation_enabled: boolean;
  installed_at: string;
  uninstalled_at: string | null;
  onboarding_started_at: string | null;
  onboarding_completed_at: string | null;
  plan_selected_at: string | null;
  test_requested_at: string | null;
  test_delivered_at: string | null;
  first_eligible_order_at: string | null;
  first_message_delivered_at: string | null;
  first_customer_response_at: string | null;
  first_resolved_at: string | null;
  paid_subscription_activated_at: string | null;
  provenance: Record<string, string> | null;
  usage_used: number | string | null;
  usage_limit: number | string | null;
  last_activity_at: string | null;
  failed_24h: number | string | null;
  total_24h: number | string | null;
  failed_webhooks_1h: number | string | null;
  platform_type: string;
  org_id: string;
  has_lifecycle: boolean;
  derived_first_eligible_order_at: string | null;
  derived_first_resolved_at: string | null;
  credit_account_status: string | null;
  credit_posted_balance: number | string | null;
  credit_held_credits: number | string | null;
}

export interface AdminStoreViewRow extends AdminStoreQueryRow {
  is_credit: boolean;
  usage_limit_effective: number | string;
  usage_percent: number | string;
  credit_available: number | string;
  credit_debt: number | string;
  credit_balance_state: 'ok' | 'low' | 'zero' | 'debt' | null;
  first_eligible_order_at_effective: string | null;
  first_resolved_at_effective: string | null;
  first_eligible_estimated: boolean;
  first_resolved_estimated: boolean;
  data_quality_estimated: boolean;
  lifecycle_status: string;
  critical_signals: string[];
  attention_signals: string[];
  health_status: string;
}

export interface AdminStoreDetailQueryRow extends AdminStoreViewRow {
  owner_email: string | null;
  default_language: string;
  follow_up_enabled: boolean;
  follow_up_delay_minutes: number;
  escalation_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  send_delay_minutes: number;
  shipping_currency: string;
  last_synced_at: string | null;
  billing_activated_at: string | null;
  created_at: string | null;
}

export interface AdminStoreVerificationTotalsRow {
  [key: string]: unknown;
  status: string;
  is_test: boolean;
  count: number | string;
}

export interface AdminStoreVerificationRow {
  [key: string]: unknown;
  id: string;
  status: string;
  metadata: unknown;
  order_number: string | null;
  external_order_id: string;
  is_test: boolean;
  customer_name: string | null;
  customer_phone: string;
  total_price: string | null;
  currency: string | null;
  attempts: number | null;
  follow_up_attempts: number;
  template_name: string | null;
  language_code: string | null;
  cancellation_source: string | null;
  created_at: string;
  last_sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  confirmed_at: string | null;
  canceled_at: string | null;
  expired_at: string | null;
  no_reply_at: string | null;
  follow_up_sent_at: string | null;
  updated_at: string | null;
}

export interface AdminStoreVerificationsFilter {
  statuses?: string[];
  includeTest: boolean;
  cursor?: { createdAt: string; id: string };
  limit: number;
}

/**
 * Business inputs the derived store columns need. They come from config and
 * plan definitions, so the service supplies them.
 */
export interface AdminStoreDerivation {
  lowBalanceThreshold: number;
  planLimits: Record<string, number>;
  healthSignals: (columns: AdminHealthColumns) => {
    critical: SQL;
    attention: SQL;
  };
}

export type AdminStoreSortKey =
  | 'installed_at'
  | 'store_name'
  | 'last_activity'
  | 'usage_percent'
  | 'activation_date'
  | 'health';

export interface AdminStoreListFilter {
  search?: string;
  platform?: string;
  plan?: string;
  lifecycleStatus?: string;
  onboardingStatus?: string;
  healthStatus?: string;
  country?: string;
  installedFrom?: string;
  installedTo?: string;
  lastActivityFrom?: string;
  lastActivityTo?: string;
}

export interface AdminStoreListPage {
  sort: AdminStoreSortKey;
  direction: 'asc' | 'desc';
  limit: number;
  cursor?: { value: string; id: string };
}

export interface AdminStoreSummaryRow {
  currently_installed: number;
  onboarding: number;
  activated: number;
  inactive: number;
  uninstalled: number;
  healthy: number;
  attention_required: number;
  critical: number;
}

export type AdminStorePageRow = AdminStoreViewRow & { sort_value: string };

const SORT_EXPRESSIONS: Record<
  AdminStoreSortKey,
  { expression: SQL; cast: (value: string) => SQL }
> = {
  installed_at: {
    expression: sql`COALESCE(installed_at, '-infinity'::timestamptz)`,
    cast: (value) => sql`${value}::timestamptz`,
  },
  store_name: {
    expression: sql`(lower(COALESCE(store_name, organization_name)) COLLATE "C")`,
    cast: (value) => sql`(${value}::text COLLATE "C")`,
  },
  last_activity: {
    expression: sql`COALESCE(last_activity_at, '-infinity'::timestamptz)`,
    cast: (value) => sql`${value}::timestamptz`,
  },
  usage_percent: {
    expression: sql`usage_percent`,
    cast: (value) => sql`${value}::int`,
  },
  activation_date: {
    expression: sql`COALESCE(first_resolved_at_effective, '-infinity'::timestamptz)`,
    cast: (value) => sql`${value}::timestamptz`,
  },
  health: {
    expression: sql`(CASE health_status WHEN 'critical' THEN 2 WHEN 'attention_required' THEN 1 ELSE 0 END)`,
    cast: (value) => sql`${value}::int`,
  },
};

@Injectable()
export class AdminQueryRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findStores(
    options: { platforms?: string[] } = {},
  ): Promise<AdminStoreQueryRow[]> {
    const where =
      options.platforms && options.platforms.length > 0
        ? sql`WHERE i.platform_type IN (${sql.join(
            options.platforms.map((platform) => sql`${platform}`),
            sql`, `,
          )})`
        : sql``;
    const result = await this.db.execute<AdminStoreQueryRow>(
      this.storeQuery(sql``, where),
    );

    return Array.from(result);
  }

  /**
   * One page of the store list, filtered, sorted and keyset-paginated in SQL,
   * plus the summary counts over every row matching the filters.
   */
  async findStorePage(
    filter: AdminStoreListFilter,
    page: AdminStoreListPage,
    derivation: AdminStoreDerivation,
  ): Promise<{ summary: AdminStoreSummaryRow; rows: AdminStorePageRow[] }> {
    const sort = SORT_EXPRESSIONS[page.sort];
    const direction = page.direction === 'asc' ? sql`ASC` : sql`DESC`;
    const comparator = page.direction === 'asc' ? sql`>` : sql`<`;
    const cursor = page.cursor
      ? sql`WHERE (${sort.expression}, integration_id) ${comparator} (${sort.cast(page.cursor.value)}, ${page.cursor.id}::uuid)`
      : sql``;

    const result = await this.db.execute<
      AdminStoreSummaryRow & Partial<AdminStorePageRow>
    >(sql`
      WITH ${this.storePipeline(sql``, sql``, derivation)},
      filtered AS (
        SELECT * FROM stores WHERE ${this.listConditions(filter)}
      ),
      summary AS (
        SELECT
          COUNT(*) FILTER (WHERE lifecycle_status <> 'uninstalled')::int AS currently_installed,
          COUNT(*) FILTER (WHERE lifecycle_status = 'onboarding')::int AS onboarding,
          COUNT(*) FILTER (WHERE lifecycle_status = 'active')::int AS activated,
          COUNT(*) FILTER (WHERE lifecycle_status = 'inactive')::int AS inactive,
          COUNT(*) FILTER (WHERE lifecycle_status = 'uninstalled')::int AS uninstalled,
          COUNT(*) FILTER (WHERE health_status = 'healthy')::int AS healthy,
          COUNT(*) FILTER (WHERE health_status = 'attention_required')::int AS attention_required,
          COUNT(*) FILTER (WHERE health_status = 'critical')::int AS critical
        FROM filtered
      ),
      page AS (
        SELECT
          filtered.*,
          ${sort.expression} AS sort_key,
          (${sort.expression})::text AS sort_value
        FROM filtered
        ${cursor}
        ORDER BY ${sort.expression} ${direction}, integration_id ${direction}
        LIMIT ${page.limit}
      )
      SELECT summary.*, page.*
      FROM summary
      LEFT JOIN page ON true
      ORDER BY page.sort_key ${direction}, page.integration_id ${direction}
    `);

    const resultRows = Array.from(result);
    const first = resultRows[0];
    const summary: AdminStoreSummaryRow = {
      currently_installed: Number(first?.currently_installed ?? 0),
      onboarding: Number(first?.onboarding ?? 0),
      activated: Number(first?.activated ?? 0),
      inactive: Number(first?.inactive ?? 0),
      uninstalled: Number(first?.uninstalled ?? 0),
      healthy: Number(first?.healthy ?? 0),
      attention_required: Number(first?.attention_required ?? 0),
      critical: Number(first?.critical ?? 0),
    };
    const rows = resultRows.filter(
      (row): row is AdminStoreSummaryRow & AdminStorePageRow =>
        Boolean(row.integration_id),
    );

    return { summary, rows };
  }

  async findStoreById(
    integrationId: string,
    derivation: AdminStoreDerivation,
  ): Promise<AdminStoreDetailQueryRow | null> {
    const result = await this.db.execute<AdminStoreDetailQueryRow>(sql`
      WITH ${this.storePipeline(
        sql`,
        (
          SELECT owner_user.email
          FROM memberships membership
          INNER JOIN auth.users owner_user ON owner_user.id = membership.user_id
          WHERE membership.org_id = i.org_id AND membership.role = 'owner'
          ORDER BY membership.created_at ASC
          LIMIT 1
        ) AS owner_email,
        i.default_language::text AS default_language,
        i.follow_up_enabled,
        i.follow_up_delay_minutes,
        i.escalation_enabled,
        i.quiet_hours_enabled,
        i.quiet_hours_start,
        i.quiet_hours_end,
        i.send_delay_minutes,
        i.shipping_currency,
        i.last_synced_at,
        i.billing_activated_at,
        i.created_at`,
        sql`WHERE i.id = ${integrationId}`,
        derivation,
      )}
      SELECT * FROM stores
    `);

    return Array.from(result)[0] ?? null;
  }

  async findStoreVerificationTotals(
    integrationId: string,
  ): Promise<AdminStoreVerificationTotalsRow[]> {
    const result = await this.db.execute<AdminStoreVerificationTotalsRow>(sql`
      SELECT v.status::text AS status, ord.is_test, COUNT(*)::int AS count
      FROM orders ord
      INNER JOIN verifications v ON v.order_id = ord.id
      WHERE ord.integration_id = ${integrationId}
      GROUP BY v.status, ord.is_test
    `);

    return Array.from(result);
  }

  async findStoreVerifications(
    integrationId: string,
    filter: AdminStoreVerificationsFilter,
  ): Promise<{ rows: AdminStoreVerificationRow[]; totalCount: number }> {
    const conditions = [sql`ord.integration_id = ${integrationId}`];
    if (!filter.includeTest) conditions.push(sql`NOT ord.is_test`);
    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(
        sql`v.status::text IN (${sql.join(
          filter.statuses.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      );
    }
    const baseWhere = sql.join(conditions, sql` AND `);
    const cursorCondition = filter.cursor
      ? sql` AND (v.created_at, v.id) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`
      : sql``;

    const [rows, counts] = await Promise.all([
      this.db.execute<AdminStoreVerificationRow>(sql`
        SELECT
          v.id,
          v.status::text AS status,
          v.metadata,
          ord.order_number,
          ord.external_order_id,
          ord.is_test,
          ord.customer_name,
          ord.customer_phone,
          ord.total_price::text AS total_price,
          ord.currency,
          v.attempts,
          v.follow_up_attempts,
          v.template_name,
          v.language_code,
          v.cancellation_source,
          v.created_at,
          v.last_sent_at,
          v.delivered_at,
          v.read_at,
          v.confirmed_at,
          v.canceled_at,
          v.expired_at,
          v.no_reply_at,
          v.follow_up_sent_at,
          v.updated_at
        FROM orders ord
        INNER JOIN verifications v ON v.order_id = ord.id
        WHERE ${baseWhere}${cursorCondition}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ${filter.limit}
      `),
      this.db.execute<{ total: number | string }>(sql`
        SELECT COUNT(*)::int AS total
        FROM orders ord
        INNER JOIN verifications v ON v.order_id = ord.id
        WHERE ${baseWhere}
      `),
    ]);

    return {
      rows: Array.from(rows),
      totalCount: Number(Array.from(counts)[0]?.total ?? 0),
    };
  }

  private listConditions(filter: AdminStoreListFilter): SQL {
    const conditions: SQL[] = [sql`true`];
    const search = filter.search?.trim().toLocaleLowerCase();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      conditions.push(sql`(
        lower(COALESCE(store_name, organization_name)) LIKE ${pattern} ESCAPE '\\'
        OR lower(CASE WHEN platform_type = 'standalone' THEN NULL ELSE shop_domain END) LIKE ${pattern} ESCAPE '\\'
        OR lower(organization_name) LIKE ${pattern} ESCAPE '\\'
      )`);
    }
    if (filter.platform)
      conditions.push(sql`platform_type = ${filter.platform}`);
    if (filter.plan) conditions.push(sql`plan = ${filter.plan}`);
    if (filter.lifecycleStatus)
      conditions.push(sql`lifecycle_status = ${filter.lifecycleStatus}`);
    if (filter.onboardingStatus)
      conditions.push(sql`onboarding_status = ${filter.onboardingStatus}`);
    if (filter.healthStatus)
      conditions.push(sql`health_status = ${filter.healthStatus}`);
    if (filter.country)
      conditions.push(
        sql`upper(COALESCE(country_code, '')) = ${filter.country.toUpperCase()}`,
      );
    if (filter.installedFrom)
      conditions.push(
        sql`installed_at >= ${filter.installedFrom}::timestamptz`,
      );
    if (filter.installedTo)
      conditions.push(sql`installed_at <= ${filter.installedTo}::timestamptz`);
    if (filter.lastActivityFrom || filter.lastActivityTo)
      conditions.push(sql`last_activity_at IS NOT NULL`);
    if (filter.lastActivityFrom)
      conditions.push(
        sql`last_activity_at >= ${filter.lastActivityFrom}::timestamptz`,
      );
    if (filter.lastActivityTo)
      conditions.push(
        sql`last_activity_at <= ${filter.lastActivityTo}::timestamptz`,
      );
    return sql.join(conditions, sql` AND `);
  }

  /**
   * CTEs ending in `stores`: the raw store row, then usage, credit and
   * milestone fallbacks, then lifecycle and health. List and detail share it,
   * so a store reads the same on both pages.
   */
  private storePipeline(
    extraColumns: SQL,
    where: SQL,
    derivation: AdminStoreDerivation,
  ): SQL {
    const planLimit = sql`(CASE plan ${sql.join(
      Object.entries(derivation.planLimits).map(
        ([plan, limit]) => sql`WHEN ${plan} THEN ${limit}::int`,
      ),
      sql` `,
    )} ELSE 0 END)`;
    const available = sql`GREATEST(COALESCE(credit_posted_balance, 0) - COALESCE(credit_held_credits, 0), 0)`;
    const signals = derivation.healthSignals({
      onboardingStatus: sql`onboarding_status`,
      installedAt: sql`installed_at`,
      onboardingCompletedAt: sql`onboarding_completed_at`,
      firstEligibleOrderAt: sql`first_eligible_order_at_effective`,
      firstResolvedAt: sql`first_resolved_at_effective`,
      uninstalledAt: sql`uninstalled_at`,
      usagePercent: sql`(CASE WHEN is_credit THEN 0 ELSE usage_percent END)`,
      failed24h: sql`failed_24h`,
      total24h: sql`total_24h`,
      failedWebhooks1h: sql`failed_webhooks_1h`,
      autoEnabled: sql`auto_confirmation_enabled`,
      billingStatus: sql`(CASE WHEN is_credit THEN NULL ELSE subscription_status END)`,
      lastActivityAt: sql`last_activity_at`,
      creditBalanceState: sql`credit_balance_state`,
    });

    return sql`
      raw_stores AS (${this.storeQuery(extraColumns, where)}),
      fallback_stores AS (
        SELECT
          raw_stores.*,
          (platform_type = 'standalone' AND credit_account_status IS NOT NULL) AS is_credit,
          COALESCE(NULLIF(usage_limit, 0), ${planLimit}) AS usage_limit_effective,
          (NOT has_lifecycle AND platform_type <> 'shopify'
            AND first_eligible_order_at IS NULL
            AND derived_first_eligible_order_at IS NOT NULL) AS first_eligible_estimated,
          (NOT has_lifecycle AND platform_type <> 'shopify'
            AND first_resolved_at IS NULL
            AND derived_first_resolved_at IS NOT NULL) AS first_resolved_estimated
        FROM raw_stores
      ),
      measured_stores AS (
        SELECT
          fallback_stores.*,
          (CASE WHEN first_eligible_estimated THEN derived_first_eligible_order_at ELSE first_eligible_order_at END) AS first_eligible_order_at_effective,
          (CASE WHEN first_resolved_estimated THEN derived_first_resolved_at ELSE first_resolved_at END) AS first_resolved_at_effective,
          (CASE WHEN usage_limit_effective > 0
            THEN ROUND(usage_used::numeric * 100 / usage_limit_effective)::int
            ELSE 0 END) AS usage_percent,
          ${available} AS credit_available,
          (CASE WHEN COALESCE(credit_posted_balance, 0) < 0 THEN -credit_posted_balance ELSE 0 END) AS credit_debt,
          (CASE
            WHEN NOT is_credit THEN NULL
            WHEN COALESCE(credit_posted_balance, 0) < 0 THEN 'debt'
            WHEN ${available} = 0 THEN 'zero'
            WHEN ${available} <= ${derivation.lowBalanceThreshold}::int THEN 'low'
            ELSE 'ok' END) AS credit_balance_state
        FROM fallback_stores
      ),
      signaled_stores AS (
        SELECT
          measured_stores.*,
          (CASE
            WHEN uninstalled_at IS NOT NULL THEN 'uninstalled'
            WHEN NOT is_active THEN 'inactive'
            WHEN onboarding_status <> 'completed' THEN 'onboarding'
            WHEN first_resolved_at_effective IS NOT NULL THEN 'active'
            ELSE 'installed' END) AS lifecycle_status,
          (first_eligible_estimated OR first_resolved_estimated OR EXISTS (
            SELECT 1
            FROM jsonb_each_text(COALESCE(provenance, '{}'::jsonb)) provenance_entry
            WHERE provenance_entry.value LIKE 'estimated%'
          )) AS data_quality_estimated,
          ${signals.critical} AS critical_signals,
          ${signals.attention} AS attention_signals
        FROM measured_stores
      ),
      stores AS (
        SELECT
          signaled_stores.*,
          (CASE
            WHEN cardinality(critical_signals) > 0 THEN 'critical'
            WHEN cardinality(attention_signals) > 0 THEN 'attention_required'
            ELSE 'healthy' END) AS health_status
        FROM signaled_stores
      )
    `;
  }

  private storeQuery(extraColumns: SQL, where: SQL): SQL {
    return sql`
      SELECT
        i.id AS integration_id,
        i.org_id,
        i.platform_type,
        o.name AS organization_name,
        i.store_name,
        i.platform_store_url AS shop_domain,
        i.country_code,
        COALESCE(i.shop_timezone, i.timezone) AS timezone,
        COALESCE(i.is_active, false) AS is_active,
        i.onboarding_status::text AS onboarding_status,
        i.billing_plan_id::text AS plan,
        i.billing_status AS subscription_status,
        i.is_auto_verify_enabled AS auto_confirmation_enabled,
        COALESCE(l.installed_at, i.created_at) AS installed_at,
        l.uninstalled_at,
        l.onboarding_started_at,
        l.onboarding_completed_at,
        l.plan_selected_at,
        l.test_requested_at,
        l.test_delivered_at,
        l.first_eligible_order_at,
        l.first_message_delivered_at,
        l.first_customer_response_at,
        l.first_resolved_at,
        l.paid_subscription_activated_at,
        l.provenance,
        COALESCE(u.consumed_count, 0) AS usage_used,
        COALESCE(u.included_limit, 0) AS usage_limit,
        GREATEST(
          i.updated_at,
          verification_metrics.last_activity_at,
          webhook_metrics.last_activity_at,
          u.updated_at
        ) AS last_activity_at,
        COALESCE(verification_metrics.failed_24h, 0) AS failed_24h,
        COALESCE(verification_metrics.total_24h, 0) AS total_24h,
        COALESCE(webhook_metrics.failed_webhooks_1h, 0) AS failed_webhooks_1h,
        (l.integration_id IS NOT NULL) AS has_lifecycle,
        verification_metrics.first_eligible_order_at AS derived_first_eligible_order_at,
        verification_metrics.first_resolved_at AS derived_first_resolved_at,
        ca.status::text AS credit_account_status,
        ca.posted_balance AS credit_posted_balance,
        ca.held_credits AS credit_held_credits${extraColumns}
      FROM integrations i
      INNER JOIN organizations o ON o.id = i.org_id
      LEFT JOIN credit_accounts ca ON ca.org_id = i.org_id
      LEFT JOIN LATERAL (
        SELECT lifecycle.*
        FROM admin_store_lifecycles lifecycle
        WHERE lifecycle.integration_id = i.id
        ORDER BY (lifecycle.uninstalled_at IS NULL) DESC, lifecycle.installed_at DESC
        LIMIT 1
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT usage.*
        FROM integration_monthly_usage usage
        WHERE usage.integration_id = i.id
        ORDER BY usage.period_start DESC
        LIMIT 1
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT
          MAX(v.updated_at) AS last_activity_at,
          COUNT(*) FILTER (
            WHERE v.created_at >= NOW() - INTERVAL '24 hours' AND NOT ord.is_test
          )::int AS total_24h,
          COUNT(*) FILTER (
            WHERE v.created_at >= NOW() - INTERVAL '24 hours'
              AND v.status = 'failed'
              AND NOT ord.is_test
          )::int AS failed_24h,
          MIN(ord.created_at) FILTER (WHERE NOT ord.is_test) AS first_eligible_order_at,
          MIN(COALESCE(v.confirmed_at, v.canceled_at)) FILTER (
            WHERE NOT ord.is_test
          ) AS first_resolved_at
        FROM orders ord
        INNER JOIN verifications v ON v.order_id = ord.id
        WHERE ord.integration_id = i.id
      ) verification_metrics ON true
      LEFT JOIN LATERAL (
        SELECT
          MAX(w.updated_at) AS last_activity_at,
          COUNT(*) FILTER (
            WHERE w.updated_at >= NOW() - INTERVAL '1 hour'
              AND w.status = 'failed'
          )::int AS failed_webhooks_1h
        FROM webhook_events w
        WHERE w.integration_id = i.id
      ) webhook_metrics ON true
      ${where}
    `;
  }
}
