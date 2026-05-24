CREATE OR REPLACE VIEW "public"."webhook_processing_health" AS
SELECT
  "platform",
  "job_type",
  "store_domain",
  "status",
  COUNT(*)::int AS "event_count",
  MIN("received_at") AS "first_received_at",
  MAX("received_at") AS "last_received_at",
  MAX("processed_at") AS "last_processed_at",
  MAX("updated_at") AS "last_updated_at",
  SUM("attempts")::int AS "total_attempts",
  COUNT(*) FILTER (
    WHERE "status" IN ('pending', 'processing')
      AND "received_at" < NOW() - INTERVAL '10 minutes'
  )::int AS "stale_event_count",
  COUNT(*) FILTER (
    WHERE "status" = 'failed'
  )::int AS "failed_event_count"
FROM "public"."webhook_events"
WHERE "received_at" >= NOW() - INTERVAL '7 days'
GROUP BY
  "platform",
  "job_type",
  "store_domain",
  "status"
ORDER BY
  "failed_event_count" DESC,
  "stale_event_count" DESC,
  "last_received_at" DESC;

CREATE OR REPLACE VIEW "public"."failed_webhook_events" AS
SELECT
  webhook_events."id",
  webhook_events."platform",
  webhook_events."job_type",
  webhook_events."store_domain",
  webhook_events."status",
  webhook_events."attempts",
  webhook_events."last_error",
  webhook_events."received_at",
  webhook_events."processed_at",
  webhook_events."updated_at",
  webhook_events."org_id",
  organizations."name" AS "organization_name",
  webhook_events."integration_id"
FROM "public"."webhook_events" webhook_events
LEFT JOIN "public"."organizations" organizations
  ON organizations."id" = webhook_events."org_id"
WHERE webhook_events."status" IN ('failed', 'pending', 'processing')
  AND (
    webhook_events."status" = 'failed'
    OR webhook_events."received_at" < NOW() - INTERVAL '10 minutes'
  )
ORDER BY webhook_events."updated_at" DESC;

CREATE OR REPLACE VIEW "public"."verification_send_failures" AS
SELECT
  verifications."id" AS "verification_id",
  verifications."status",
  verifications."attempts",
  verifications."last_sent_at",
  verifications."created_at",
  verifications."updated_at",
  verifications."metadata" ->> 'reason' AS "failure_reason",
  verifications."metadata" ->> 'kind' AS "failure_kind",
  orders."external_order_id",
  orders."order_number",
  orders."currency",
  orders."total_price",
  integrations."platform_store_url" AS "shop_domain",
  integrations."store_name",
  integrations."billing_plan_id",
  integrations."billing_status",
  organizations."id" AS "org_id",
  organizations."name" AS "organization_name"
FROM "public"."verifications" verifications
INNER JOIN "public"."orders" orders
  ON orders."id" = verifications."order_id"
LEFT JOIN "public"."integrations" integrations
  ON integrations."id" = orders."integration_id"
INNER JOIN "public"."organizations" organizations
  ON organizations."id" = verifications."org_id"
WHERE verifications."status" = 'failed'
ORDER BY verifications."updated_at" DESC;

COMMENT ON VIEW "public"."webhook_processing_health" IS
  'Internal 7-day aggregate for webhook processing health by platform, job type, store, and status.';

COMMENT ON VIEW "public"."failed_webhook_events" IS
  'Internal queue triage view for failed or stale webhook events.';

COMMENT ON VIEW "public"."verification_send_failures" IS
  'Internal triage view for failed WhatsApp verification sends. Does not expose access tokens or webhook secrets.';
