CREATE OR REPLACE VIEW "public"."merchant_billing_health" AS
WITH latest_usage AS (
  SELECT DISTINCT ON ("integration_id")
    "integration_id",
    "period_start",
    "included_limit",
    "consumed_count",
    "blocked_count",
    "updated_at" AS "usage_updated_at"
  FROM "public"."integration_monthly_usage"
  ORDER BY "integration_id", "period_start" DESC
),
billing_health AS (
  SELECT
    organizations."id" AS "org_id",
    organizations."name" AS "organization_name",
    integrations."id" AS "integration_id",
    integrations."platform_store_url" AS "shop_domain",
    integrations."store_name",
    integrations."is_active",
    integrations."onboarding_status",
    integrations."billing_plan_id",
    integrations."billing_status",
    integrations."shopify_subscription_id",
    integrations."billing_initiated_at",
    integrations."billing_activated_at",
    integrations."billing_canceled_at",
    integrations."billing_status_updated_at",
    latest_usage."period_start",
    COALESCE(
      latest_usage."included_limit",
      CASE integrations."billing_plan_id"
        WHEN 'starter' THEN 30
        WHEN 'basic' THEN 300
        WHEN 'pro' THEN 1000
        WHEN 'business' THEN 2500
        ELSE 0
      END
    ) AS "included_limit",
    COALESCE(latest_usage."consumed_count", 0) AS "consumed_count",
    COALESCE(latest_usage."blocked_count", 0) AS "blocked_count",
    latest_usage."usage_updated_at",
    integrations."created_at" AS "installed_at",
    integrations."updated_at" AS "integration_updated_at"
  FROM "public"."integrations" integrations
  INNER JOIN "public"."organizations" organizations
    ON organizations."id" = integrations."org_id"
  LEFT JOIN latest_usage
    ON latest_usage."integration_id" = integrations."id"
  WHERE integrations."platform_type" = 'shopify'
)
SELECT
  "org_id",
  "organization_name",
  "integration_id",
  "shop_domain",
  "store_name",
  "is_active",
  "onboarding_status",
  "billing_plan_id",
  "billing_status",
  "shopify_subscription_id",
  "billing_initiated_at",
  "billing_activated_at",
  "billing_canceled_at",
  "billing_status_updated_at",
  "period_start",
  "included_limit",
  "consumed_count",
  "blocked_count",
  CASE
    WHEN "included_limit" > 0
      THEN ROUND(("consumed_count"::numeric / "included_limit"::numeric) * 100, 2)
    ELSE 0
  END AS "usage_percent",
  "usage_updated_at",
  "installed_at",
  "integration_updated_at",
  CASE
    WHEN "is_active" IS NOT TRUE THEN 'inactive'
    WHEN "billing_status" = 'not_required' THEN 'billing_bypassed'
    WHEN "billing_status" IS NULL THEN 'billing_not_started'
    WHEN LOWER("billing_status") = 'error' THEN 'billing_failed'
    WHEN LOWER("billing_status") IN ('canceled', 'cancelled', 'declined', 'expired', 'frozen')
      THEN 'billing_canceled'
    WHEN LOWER("billing_status") = 'pending'
      AND "billing_initiated_at" < NOW() - INTERVAL '1 hour'
      THEN 'billing_pending_stale'
    WHEN LOWER("billing_status") = 'pending' THEN 'billing_pending'
    WHEN "onboarding_status" <> 'completed' THEN 'not_onboarded'
    WHEN "blocked_count" > 0 THEN 'over_limit_blocking'
    WHEN "included_limit" > 0
      AND "consumed_count" >= CEIL("included_limit" * 0.8)
      THEN 'near_limit'
    WHEN LOWER("billing_status") = 'active'
      AND "onboarding_status" = 'completed'
      THEN 'healthy'
    ELSE 'needs_review'
  END AS "risk_label"
FROM billing_health
ORDER BY "installed_at" DESC;

COMMENT ON VIEW "public"."merchant_billing_health" IS
  'Internal launch-readiness view for Shopify merchant billing, onboarding, and usage health. Do not expose directly to merchant-facing clients.';
