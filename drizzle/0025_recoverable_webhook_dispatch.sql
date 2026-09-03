ALTER TABLE "public"."webhook_events"
  ADD COLUMN "dispatch_required" boolean DEFAULT false NOT NULL,
  ADD COLUMN "dispatch_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "last_dispatch_error" text,
  ADD COLUMN "next_dispatch_at" timestamp with time zone,
  ADD COLUMN "dispatch_lease_until" timestamp with time zone,
  ADD COLUMN "dispatched_at" timestamp with time zone,
  ADD COLUMN "processing_lease_until" timestamp with time zone;--> statement-breakpoint

UPDATE "public"."webhook_events"
SET
  "dispatch_required" = true,
  "next_dispatch_at" = CASE
    WHEN "status" = 'pending' THEN COALESCE("received_at", "created_at", NOW())
    ELSE NULL
  END
WHERE "job_type" = 'order.create'
  AND "status" IN ('pending', 'processing');--> statement-breakpoint

UPDATE "public"."webhook_events"
SET "dispatched_at" = COALESCE("processed_at", "updated_at", "created_at", NOW())
WHERE "status" IN ('completed', 'failed', 'skipped');--> statement-breakpoint

ALTER TABLE "public"."webhook_events"
  DROP CONSTRAINT "webhook_events_platform_idempotency_key";--> statement-breakpoint

ALTER TABLE "public"."webhook_events"
  ADD CONSTRAINT "webhook_events_source_idempotency_key"
  UNIQUE("platform", "store_domain", "idempotency_key");--> statement-breakpoint

CREATE INDEX "idx_webhook_events_dispatch_recovery"
  ON "public"."webhook_events" USING btree
  ("dispatch_required" bool_ops, "status" enum_ops, "next_dispatch_at" timestamptz_ops);--> statement-breakpoint

CREATE OR REPLACE VIEW "public"."webhook_dispatch_health" AS
SELECT
  "platform",
  "job_type",
  "store_domain",
  COUNT(*) FILTER (
    WHERE "dispatch_required" AND "status" = 'pending' AND "dispatched_at" IS NULL
  )::int AS "pending_dispatch_count",
  MIN("received_at") FILTER (
    WHERE "dispatch_required" AND "status" = 'pending' AND "dispatched_at" IS NULL
  ) AS "oldest_pending_at",
  MAX("dispatch_attempts") FILTER (WHERE "dispatch_required")::int AS "max_dispatch_attempts",
  COUNT(*) FILTER (
    WHERE "status" = 'failed' AND "last_error" LIKE 'dispatch_terminal:%'
  )::int AS "terminal_dispatch_failure_count",
  COUNT(*) FILTER (
    WHERE "status" = 'processing'
      AND (("processing_lease_until" IS NOT NULL AND "processing_lease_until" <= NOW())
        OR ("processing_lease_until" IS NULL AND "updated_at" <= NOW() - INTERVAL '10 minutes'))
  )::int AS "stale_processing_count",
  MAX("last_dispatch_error") FILTER (
    WHERE "last_dispatch_error" IS NOT NULL
  ) AS "last_dispatch_error"
FROM "public"."webhook_events"
WHERE "received_at" >= NOW() - INTERVAL '7 days'
GROUP BY "platform", "job_type", "store_domain"
ORDER BY
  "terminal_dispatch_failure_count" DESC,
  "pending_dispatch_count" DESC,
  "oldest_pending_at" ASC;--> statement-breakpoint

COMMENT ON VIEW "public"."webhook_dispatch_health" IS
  'Safe operational visibility for recoverable dispatch, retry exhaustion, and stale processing; payloads and secrets are excluded.';
