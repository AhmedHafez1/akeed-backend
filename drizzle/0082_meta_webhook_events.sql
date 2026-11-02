-- One row per change Meta sent, stored before the webhook is answered and then
-- processed by a worker. Payloads hold customer data, so this is API-only: RLS
-- on, no policy, nothing granted.
--
-- "payload" is text, not jsonb: a message_template_id can exceed 2^53, and the
-- driver would read it back from jsonb as a rounded number. It is cleared when
-- an event succeeds and "dedupe_hash" stays, so a redelivery is still a
-- duplicate. Failed rows keep it for 14 days for replay. Rows go after 30 days,
-- well past Meta's 7 days of redelivery.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE "meta_webhook_events";
CREATE TABLE IF NOT EXISTS "meta_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dedupe_hash" text NOT NULL,
  "field" text,
  "waba_id" text,
  "phone_number_id" text,
  "payload" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamptz,
  "next_attempt_at" timestamptz,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz,
  "failed_at" timestamptz,
  "last_error" text,
  CONSTRAINT "meta_webhook_events_dedupe_hash_unique" UNIQUE ("dedupe_hash"),
  CONSTRAINT "meta_webhook_events_status_check" CHECK ("status" IN ('pending', 'processing', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "meta_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "meta_webhook_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meta_webhook_events_due" ON "meta_webhook_events" ("next_attempt_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meta_webhook_events_leased" ON "meta_webhook_events" ("lease_until") WHERE "status" = 'processing';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meta_webhook_events_failed" ON "meta_webhook_events" ("failed_at") WHERE "status" = 'failed' AND "payload" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meta_webhook_events_finished" ON "meta_webhook_events" ("received_at") WHERE "status" IN ('succeeded', 'failed');
