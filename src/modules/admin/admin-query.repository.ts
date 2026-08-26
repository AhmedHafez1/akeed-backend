import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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
}

@Injectable()
export class AdminQueryRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findStores(): Promise<AdminStoreQueryRow[]> {
    const result = await this.db.execute<AdminStoreQueryRow>(sql`
      SELECT
        i.id AS integration_id,
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
        COALESCE(webhook_metrics.failed_webhooks_1h, 0) AS failed_webhooks_1h
      FROM integrations i
      INNER JOIN organizations o ON o.id = i.org_id
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
          )::int AS failed_24h
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
      WHERE i.platform_type = 'shopify'
    `);

    return Array.from(result);
  }
}
