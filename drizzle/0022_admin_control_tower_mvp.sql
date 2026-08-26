ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "country_code" varchar(2);
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "shop_timezone" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;

UPDATE "orders"
SET "is_test" = true
WHERE "external_order_id" LIKE 'akeed-test-%';

CREATE TABLE IF NOT EXISTS "admin_store_lifecycles" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "installed_at" timestamp with time zone NOT NULL,
  "uninstalled_at" timestamp with time zone,
  "onboarding_started_at" timestamp with time zone,
  "onboarding_completed_at" timestamp with time zone,
  "plan_selected_at" timestamp with time zone,
  "test_requested_at" timestamp with time zone,
  "test_delivered_at" timestamp with time zone,
  "first_eligible_order_at" timestamp with time zone,
  "first_message_delivered_at" timestamp with time zone,
  "first_customer_response_at" timestamp with time zone,
  "first_resolved_at" timestamp with time zone,
  "paid_subscription_activated_at" timestamp with time zone,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "admin_store_lifecycles_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "admin_store_lifecycles_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "idx_admin_store_lifecycles_org"
  ON "admin_store_lifecycles" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_admin_store_lifecycles_installed"
  ON "admin_store_lifecycles" ("installed_at");
CREATE INDEX IF NOT EXISTS "idx_admin_store_lifecycles_integration_installed"
  ON "admin_store_lifecycles" ("integration_id", "installed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_admin_store_lifecycles_current"
  ON "admin_store_lifecycles" ("integration_id")
  WHERE "uninstalled_at" IS NULL;

CREATE TABLE IF NOT EXISTS "admin_access_audit" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "user_id" uuid,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "request_id" text,
  "target_integration_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_admin_access_audit_user_created"
  ON "admin_access_audit" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "admin_funnel_monthly" (
  "cohort_month" date NOT NULL,
  "stage" text NOT NULL,
  "reached_count" integer DEFAULT 0 NOT NULL,
  "duration_seconds_total" numeric(20,0) DEFAULT 0 NOT NULL,
  "duration_sample_count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "admin_funnel_monthly_cohort_stage_key"
    UNIQUE ("cohort_month", "stage")
);

CREATE INDEX IF NOT EXISTS "idx_orders_integration_test_created"
  ON "orders" ("integration_id", "is_test", "created_at");
CREATE INDEX IF NOT EXISTS "idx_webhook_events_integration_status_received"
  ON "webhook_events" ("integration_id", "status", "received_at" DESC);

INSERT INTO "admin_store_lifecycles" (
  "org_id",
  "integration_id",
  "installed_at",
  "onboarding_completed_at",
  "plan_selected_at",
  "paid_subscription_activated_at",
  "provenance"
)
SELECT
  integrations."org_id",
  integrations."id",
  COALESCE(integrations."created_at", now()),
  CASE
    WHEN integrations."onboarding_status" = 'completed'
      THEN COALESCE(integrations."billing_activated_at", integrations."updated_at")
    ELSE NULL
  END,
  COALESCE(integrations."billing_initiated_at", integrations."billing_activated_at"),
  CASE
    WHEN integrations."billing_plan_id" <> 'starter'
      AND integrations."billing_status" = 'active'
      THEN integrations."billing_activated_at"
    ELSE NULL
  END,
  jsonb_build_object(
    'installation_completed', 'estimated_integration_created_at',
    'onboarding_completed', CASE
      WHEN integrations."onboarding_status" = 'completed' THEN 'estimated_current_state'
      ELSE 'unavailable'
    END,
    'plan_selected', CASE
      WHEN integrations."billing_plan_id" IS NOT NULL THEN 'estimated_current_plan'
      ELSE 'unavailable'
    END,
    'paid_subscription_activated', CASE
      WHEN integrations."billing_activated_at" IS NOT NULL THEN 'estimated_current_activation'
      ELSE 'unavailable'
    END
  )
FROM "integrations" integrations
WHERE integrations."platform_type" = 'shopify'
ON CONFLICT DO NOTHING;

UPDATE "admin_store_lifecycles" lifecycle
SET
  "test_requested_at" = inferred."test_requested_at",
  "test_delivered_at" = inferred."test_delivered_at",
  "first_eligible_order_at" = inferred."first_eligible_order_at",
  "first_message_delivered_at" = inferred."first_message_delivered_at",
  "first_customer_response_at" = inferred."first_customer_response_at",
  "first_resolved_at" = inferred."first_resolved_at",
  "provenance" = lifecycle."provenance" || jsonb_build_object(
    'test_requested', CASE WHEN inferred."test_requested_at" IS NOT NULL THEN 'estimated_legacy_test_order' ELSE 'unavailable' END,
    'test_delivered', CASE WHEN inferred."test_delivered_at" IS NOT NULL THEN 'exact_retained_verification' ELSE 'unavailable' END,
    'eligible_real_cod_detected', CASE WHEN inferred."first_eligible_order_at" IS NOT NULL THEN 'estimated_retained_order' ELSE 'unavailable' END,
    'first_confirmation_delivered', CASE WHEN inferred."first_message_delivered_at" IS NOT NULL THEN 'exact_retained_verification' ELSE 'unavailable' END,
    'first_customer_response', CASE WHEN inferred."first_customer_response_at" IS NOT NULL THEN 'exact_retained_verification' ELSE 'unavailable' END,
    'first_real_cod_resolved', CASE WHEN inferred."first_resolved_at" IS NOT NULL THEN 'exact_retained_verification' ELSE 'unavailable' END
  ),
  "updated_at" = now()
FROM (
  SELECT
    orders."integration_id",
    MIN(orders."created_at") FILTER (WHERE orders."is_test") AS "test_requested_at",
    MIN(verifications."delivered_at") FILTER (WHERE orders."is_test") AS "test_delivered_at",
    MIN(orders."created_at") FILTER (WHERE NOT orders."is_test") AS "first_eligible_order_at",
    MIN(verifications."delivered_at") FILTER (WHERE NOT orders."is_test") AS "first_message_delivered_at",
    MIN(COALESCE(verifications."confirmed_at", verifications."canceled_at")) FILTER (
      WHERE NOT orders."is_test"
        AND (
          verifications."confirmed_at" IS NOT NULL
          OR (
            verifications."canceled_at" IS NOT NULL
            AND COALESCE(verifications."cancellation_source", 'customer') = 'customer'
          )
        )
    ) AS "first_customer_response_at",
    MIN(COALESCE(verifications."confirmed_at", verifications."canceled_at")) FILTER (
      WHERE NOT orders."is_test"
        AND (
          verifications."confirmed_at" IS NOT NULL
          OR (
            verifications."canceled_at" IS NOT NULL
            AND COALESCE(verifications."cancellation_source", 'customer') = 'customer'
          )
        )
    ) AS "first_resolved_at"
  FROM "orders"
  LEFT JOIN "verifications" ON verifications."order_id" = orders."id"
  GROUP BY orders."integration_id"
) inferred
WHERE lifecycle."integration_id" = inferred."integration_id"
  AND lifecycle."uninstalled_at" IS NULL;

ALTER TABLE "admin_store_lifecycles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_access_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_funnel_monthly" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages admin store lifecycles" ON "admin_store_lifecycles";
CREATE POLICY "Service role manages admin store lifecycles"
  ON "admin_store_lifecycles" FOR ALL TO service_role
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role manages admin access audit" ON "admin_access_audit";
CREATE POLICY "Service role manages admin access audit"
  ON "admin_access_audit" FOR ALL TO service_role
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role manages admin funnel monthly" ON "admin_funnel_monthly";
CREATE POLICY "Service role manages admin funnel monthly"
  ON "admin_funnel_monthly" FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users see their organizations" ON "organizations";
CREATE POLICY "Users see their organizations" ON "organizations"
  FOR SELECT TO authenticated
  USING (id = get_user_org_id());
DROP POLICY IF EXISTS "Users see own memberships" ON "memberships";
CREATE POLICY "Users see own memberships" ON "memberships"
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Multi-tenant orders" ON "orders";
CREATE POLICY "Multi-tenant orders" ON "orders"
  FOR ALL TO authenticated
  USING (org_id = get_user_org_id())
  WITH CHECK (org_id = get_user_org_id());
DROP POLICY IF EXISTS "Multi-tenant verifications" ON "verifications";
CREATE POLICY "Multi-tenant verifications" ON "verifications"
  FOR ALL TO authenticated
  USING (org_id = get_user_org_id())
  WITH CHECK (org_id = get_user_org_id());
