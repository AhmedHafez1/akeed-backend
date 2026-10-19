-- Manual App Store review prompts for Shopify stores.
--
-- "review_prompt_requests" holds one row per time staff switch the prompt on
-- for a store. A 'pending' row is the switch: the partial unique index allows
-- one per store. The first merchant answer closes it ('answered', with
-- "closed_action"), or staff switch it off ('admin_disabled'). A request
-- closed with 'dont_ask_again' is the store's permanent opt-out: staff cannot
-- open another request for that store.
--
-- "review_prompt_events" is the append-only history: who switched it on or
-- off, when the banner was first shown and the merchant's answer. One 'shown'
-- event and one answer per request, enforced by partial unique indexes, so a
-- refresh or a double click records nothing twice. 'review_clicked' means the
-- merchant opened the App Store page, not that a review was written.
--
-- Both tables are service-role only. Additive and safe to replay. No row is
-- written.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "review_prompt_events";
--   DROP TABLE IF EXISTS "review_prompt_requests";

CREATE TABLE IF NOT EXISTS "review_prompt_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "enabled_by" uuid NOT NULL,
  "enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  "closed_action" text,
  "closed_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_prompt_requests_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "review_prompt_requests_status_check" CHECK ("status" IN ('pending', 'answered', 'admin_disabled')),
  CONSTRAINT "review_prompt_requests_closed_action_check" CHECK (
    "closed_action" IS NULL
    OR "closed_action" IN ('review_clicked', 'snoozed', 'dismissed', 'dont_ask_again', 'admin_disabled')
  ),
  CONSTRAINT "review_prompt_requests_closed_check" CHECK (
    ("status" = 'pending' AND "closed_at" IS NULL AND "closed_action" IS NULL)
    OR ("status" = 'answered' AND "closed_at" IS NOT NULL AND "closed_action" IN ('review_clicked', 'snoozed', 'dismissed', 'dont_ask_again'))
    OR ("status" = 'admin_disabled' AND "closed_at" IS NOT NULL AND "closed_action" = 'admin_disabled')
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_prompt_requests_one_pending_idx" ON "review_prompt_requests" USING btree ("integration_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_prompt_requests_opted_out_idx" ON "review_prompt_requests" USING btree ("integration_id") WHERE "closed_action" = 'dont_ask_again';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_review_prompt_requests_org" ON "review_prompt_requests" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "review_prompt_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "review_prompt_requests" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages review prompt requests" ON "review_prompt_requests";--> statement-breakpoint
CREATE POLICY "Service role manages review prompt requests" ON "review_prompt_requests" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "review_prompt_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "review_prompt_requests"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "event" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "http_request_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_prompt_events_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "review_prompt_events_event_check" CHECK ("event" IN ('enabled', 'shown', 'review_clicked', 'snoozed', 'dismissed', 'dont_ask_again', 'admin_disabled')),
  CONSTRAINT "review_prompt_events_actor_type_check" CHECK ("actor_type" IN ('admin', 'merchant'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_prompt_events_one_shown_idx" ON "review_prompt_events" USING btree ("request_id") WHERE "event" = 'shown';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_prompt_events_one_answer_idx" ON "review_prompt_events" USING btree ("request_id") WHERE "event" IN ('review_clicked', 'snoozed', 'dismissed', 'dont_ask_again');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_review_prompt_events_integration_created" ON "review_prompt_events" USING btree ("integration_id", "created_at");--> statement-breakpoint
ALTER TABLE "review_prompt_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "review_prompt_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages review prompt events" ON "review_prompt_events";--> statement-breakpoint
CREATE POLICY "Service role manages review prompt events" ON "review_prompt_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
