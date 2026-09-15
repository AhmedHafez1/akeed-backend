import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';

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

export interface AdminStoreDetailQueryRow extends AdminStoreQueryRow {
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

  async findStoreById(
    integrationId: string,
  ): Promise<AdminStoreDetailQueryRow | null> {
    const result = await this.db.execute<AdminStoreDetailQueryRow>(
      this.storeQuery(
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
      ),
    );

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
