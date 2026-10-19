-- Per-store state of the App Store review prompt.
--
-- "review_prompt_requests" stays the staff switch: a 'pending' row means the
-- prompt is on for the store. Merchant answers no longer close it. What the
-- merchant did lives in "review_prompt_states", one row per store, so turning
-- the switch off and on again never re-shows a snoozed, declined or reviewed
-- prompt; only a staff reset does.
--
-- States: 'eligible', 'snoozed' (until "snoozed_until"), 'declined' (a second
-- "Not now"), 'clicked', 'reviewed_prompted' (Shopify's review modal opened),
-- 'reviewed' (Shopify reports an existing review), 'ineligible'.
--
-- "review_prompt_events" gains the new merchant events ('clicked', 'result'
-- with "result_code", 'declined') and the staff 'reset'. "request_id" becomes
-- optional, so an answer given after staff switched the prompt off is still
-- logged. Impressions are logged once per page session, and a click and its
-- result are both logged, so the one-per-request indexes go.
--
-- Backfill: each store's latest merchant answer becomes its state.
-- 'dont_ask_again' -> 'declined'; 'review_clicked' -> 'clicked'; 'snoozed' and
-- 'dismissed' -> 'snoozed' for 14 days from the answer. Requests closed by an
-- answer stay closed, so the switch stays off for those stores.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "review_prompt_states";
--   DELETE FROM "review_prompt_events" WHERE "request_id" IS NULL
--     OR "event" IN ('clicked', 'result', 'declined', 'reset');
--   DELETE FROM "review_prompt_events" e USING "review_prompt_events" d
--     WHERE e."event" = 'shown' AND d."event" = 'shown'
--     AND e."request_id" = d."request_id" AND e."created_at" > d."created_at";
--   ALTER TABLE "review_prompt_events" DROP COLUMN IF EXISTS "result_code";
--   ALTER TABLE "review_prompt_events" ALTER COLUMN "request_id" SET NOT NULL;
--   then recreate the 0070 event CHECK and the two unique indexes.

CREATE TABLE IF NOT EXISTS "review_prompt_states" (
  "integration_id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "state" text DEFAULT 'eligible' NOT NULL,
  "snoozed_until" timestamp with time zone,
  "snooze_count" integer DEFAULT 0 NOT NULL,
  "shown_count" integer DEFAULT 0 NOT NULL,
  "last_shown_at" timestamp with time zone,
  "last_result_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_prompt_states_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "review_prompt_states_state_check" CHECK ("state" IN ('eligible', 'snoozed', 'declined', 'clicked', 'reviewed_prompted', 'reviewed', 'ineligible')),
  CONSTRAINT "review_prompt_states_snooze_check" CHECK ("state" <> 'snoozed' OR "snoozed_until" IS NOT NULL),
  CONSTRAINT "review_prompt_states_counts_check" CHECK ("snooze_count" >= 0 AND "shown_count" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_review_prompt_states_org" ON "review_prompt_states" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "review_prompt_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "review_prompt_states" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages review prompt states" ON "review_prompt_states";--> statement-breakpoint
CREATE POLICY "Service role manages review prompt states" ON "review_prompt_states" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "review_prompt_events" ADD COLUMN IF NOT EXISTS "result_code" text;--> statement-breakpoint
ALTER TABLE "review_prompt_events" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_prompt_events" DROP CONSTRAINT IF EXISTS "review_prompt_events_event_check";--> statement-breakpoint
ALTER TABLE "review_prompt_events" ADD CONSTRAINT "review_prompt_events_event_check" CHECK ("event" IN ('enabled', 'shown', 'review_clicked', 'snoozed', 'dismissed', 'dont_ask_again', 'admin_disabled', 'clicked', 'result', 'declined', 'reset'));--> statement-breakpoint
DROP INDEX IF EXISTS "review_prompt_events_one_shown_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "review_prompt_events_one_answer_idx";--> statement-breakpoint

INSERT INTO "review_prompt_states" ("integration_id", "org_id", "state", "snoozed_until", "snooze_count", "shown_count", "last_shown_at", "created_at", "updated_at")
SELECT
  latest."integration_id",
  latest."org_id",
  CASE latest."closed_action"
    WHEN 'dont_ask_again' THEN 'declined'
    WHEN 'review_clicked' THEN 'clicked'
    ELSE 'snoozed'
  END,
  CASE WHEN latest."closed_action" IN ('snoozed', 'dismissed') THEN latest."closed_at" + interval '14 days' END,
  CASE latest."closed_action"
    WHEN 'dont_ask_again' THEN 2
    WHEN 'review_clicked' THEN 0
    ELSE 1
  END,
  (SELECT count(*)::integer FROM "review_prompt_events" shown WHERE shown."integration_id" = latest."integration_id" AND shown."event" = 'shown'),
  (SELECT max(shown."created_at") FROM "review_prompt_events" shown WHERE shown."integration_id" = latest."integration_id" AND shown."event" = 'shown'),
  latest."closed_at",
  latest."closed_at"
FROM (
  SELECT DISTINCT ON ("integration_id") "integration_id", "org_id", "closed_action", "closed_at"
  FROM "review_prompt_requests"
  WHERE "status" = 'answered'
  ORDER BY "integration_id", "closed_at" DESC
) latest
ON CONFLICT ("integration_id") DO NOTHING;
