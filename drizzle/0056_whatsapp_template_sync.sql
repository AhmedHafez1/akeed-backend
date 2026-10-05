-- Meta template sync, status webhooks and the send guardrail (US-08-04).
--
-- "whatsapp_templates" gains what sync and webhooks need on each row:
--   * "pending_category": a category the provider says the template will move
--     to (a scheduled re-categorization);
--   * "status_event_at", "quality_event_at", "category_event_at": the provider
--     time of the newest status, quality and category state applied, so an
--     older webhook never overwrites a newer state. A sync raises each to its
--     own start time;
--   * "components_drift_at": when a sync last found the provider's text
--     different from the snapshot it held before.
-- The provider-side values themselves ("review_status", "category",
-- "quality", "components_snapshot", "meta_template_id", "last_synced_at") are
-- the columns 0054 already created. They hold neutral values ('approved',
-- 'paused', 'utility', ...), never the provider's own strings, and they come
-- from each environment's own sync: this migration writes none of them.
--
-- "whatsapp_template_events" keeps every template webhook, applied or not.
-- The provider sends no event ID, so "identity_key" is derived from the
-- field, the account, the provider's time and a hash of the payload value; a
-- redelivery hits the unique constraint and is a no-op.
--
-- "whatsapp_template_sync_runs" records each sync. The partial unique index
-- allows one 'running' run at a time across every instance. A failed run
-- changed no registry row; "error_code" is neutral.
--
-- "verification_message_dispatches" gains "template_fallback_reason" and
-- "template_skipped_key": why the store's stored choice was not the template
-- sent, and which key was passed over. Older rows stay NULL.
--
-- All three tables are service-role only, like "whatsapp_templates".
-- Everything here is additive and safe to replay.
--
-- Rollback: set WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED=false and
-- WHATSAPP_TEMPLATE_SYNC_ENABLED=false, which restores the US-08-03 send path
-- (active rows only) and stops sync and template webhooks. To remove the
-- schema too, deploy the previous release and then run:
--   DROP TABLE IF EXISTS "whatsapp_template_events";
--   DROP TABLE IF EXISTS "whatsapp_template_sync_runs";
--   ALTER TABLE "whatsapp_templates" DROP COLUMN IF EXISTS "pending_category",
--     DROP COLUMN IF EXISTS "status_event_at", DROP COLUMN IF EXISTS "quality_event_at",
--     DROP COLUMN IF EXISTS "category_event_at", DROP COLUMN IF EXISTS "components_drift_at";
--   ALTER TABLE "verification_message_dispatches" DROP COLUMN IF EXISTS "template_fallback_reason",
--     DROP COLUMN IF EXISTS "template_skipped_key";
-- The synced values in the 0054 columns can stay: the previous release does
-- not read them.
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "pending_category" text;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "status_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "quality_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "category_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "components_drift_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_template_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL,
  "field" text NOT NULL,
  "identity_key" text NOT NULL,
  "provider_template_name" text NOT NULL,
  "provider_language_code" text NOT NULL,
  "provider_template_id" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "neutral_value" jsonb NOT NULL,
  "outcome" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_template_events_identity_key_key" UNIQUE ("identity_key"),
  CONSTRAINT "whatsapp_template_events_field_check" CHECK ("field" IN ('status', 'quality', 'category')),
  CONSTRAINT "whatsapp_template_events_outcome_check" CHECK ("outcome" IN ('applied', 'stale', 'conflict', 'unregistered'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_template_events_template_occurred" ON "whatsapp_template_events" USING btree ("template_id", "occurred_at");--> statement-breakpoint
ALTER TABLE "whatsapp_template_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_template_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp template events" ON "whatsapp_template_events";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp template events" ON "whatsapp_template_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_template_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger" text NOT NULL,
  "requested_by" uuid,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "provider_template_count" integer,
  "updated_count" integer,
  "unchanged_count" integer,
  "missing_keys" jsonb,
  "unknown_at_provider" jsonb,
  "error_code" text,
  CONSTRAINT "whatsapp_template_sync_runs_trigger_check" CHECK ("trigger" IN ('scheduled', 'manual', 'webhook')),
  CONSTRAINT "whatsapp_template_sync_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_template_sync_runs_one_running_idx" ON "whatsapp_template_sync_runs" USING btree ("status") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_template_sync_runs_started_at" ON "whatsapp_template_sync_runs" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "whatsapp_template_sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_template_sync_runs" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp template sync runs" ON "whatsapp_template_sync_runs";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp template sync runs" ON "whatsapp_template_sync_runs" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_skipped_key" text;
