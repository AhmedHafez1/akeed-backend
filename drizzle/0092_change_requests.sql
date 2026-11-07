-- Request a change (CR01): the durable domain for a customer's change request.
--
-- A customer waiting to confirm a COD order may ask for a change instead of
-- confirming or canceling. Akeed records the request, stops the reminder and
-- the no-reply automation, and the merchant contacts the customer. The
-- request never edits the order.
--
-- "integrations" gains:
--   * "change_requests_enabled": the merchant's opt-in. Off for every store,
--     existing and new. It only decides whether future messages carry the
--     third button; a button already sent stays valid after it is switched off.
--
-- "verifications" gains:
--   * "confirmation_cycle": which confirmation message set is current. Every
--     existing row is cycle 1. A successful updated confirmation moves the
--     order to the next cycle, which retires the buttons of the earlier ones.
--
-- "verification_message_dispatches" gains "confirmation_cycle": the cycle a
-- message was sent in. Every existing row is cycle 1.
--
-- "verification_change_requests" holds one row per request. At most one is
-- open per verification, and one exists per verification and cycle. The row
-- keeps the merchant, order, source, sender, the outbound message and the
-- cycle it answers, and how and by whom it was resolved.
-- "verification_change_request_events" is its append-only audit trail; a
-- replayed provider event is recorded once per request.
-- "verification_change_request_effects" is the side-effect outbox written in
-- the same transaction as each transition: the customer acknowledgment, the
-- merchant email and the store marker. Later workers consume it.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "verification_change_request_effects";
--   DROP TABLE IF EXISTS "verification_change_request_events";
--   DROP TABLE IF EXISTS "verification_change_requests";
--   ALTER TABLE "verification_message_dispatches" DROP COLUMN IF EXISTS "confirmation_cycle";
--   ALTER TABLE "verifications" DROP COLUMN IF EXISTS "confirmation_cycle";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "change_requests_enabled";
-- Rolling back while requests are open loses them: disable the feature and
-- resolve open requests first.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "change_requests_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "confirmation_cycle" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "verifications" DROP CONSTRAINT IF EXISTS "verifications_confirmation_cycle_check";--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_confirmation_cycle_check" CHECK ("confirmation_cycle" > 0);--> statement-breakpoint

ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "confirmation_cycle" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_confirmation_cycle_check";--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD CONSTRAINT "dispatch_confirmation_cycle_check" CHECK ("confirmation_cycle" > 0);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_change_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "confirmation_cycle" integer NOT NULL,
  "source_dispatch_id" uuid NOT NULL,
  "source_provider_message_id" text NOT NULL,
  "sender_kind" text NOT NULL,
  "sender_phone_number_id" text,
  "sender_connection_id" uuid,
  "opened_event_id" text NOT NULL,
  "opened_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" uuid,
  "last_reconfirmation_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_change_requests_id_org_key" UNIQUE ("id", "org_id"),
  CONSTRAINT "verification_change_requests_cycle_key" UNIQUE ("verification_id", "confirmation_cycle"),
  CONSTRAINT "verification_change_requests_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_requests_order_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "orders"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_requests_integration_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_requests_dispatch_fkey" FOREIGN KEY ("source_dispatch_id", "org_id") REFERENCES "verification_message_dispatches"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_requests_cycle_check" CHECK ("confirmation_cycle" > 0),
  CONSTRAINT "verification_change_requests_sender_kind_check" CHECK ("sender_kind" IN ('akeed_system', 'merchant_own')),
  CONSTRAINT "verification_change_requests_status_check" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "verification_change_requests_resolution_check" CHECK (
    ("status" = 'open' AND "resolution" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'resolved' AND "resolved_at" IS NOT NULL AND "resolution" IN ('customer_confirmed', 'customer_canceled', 'merchant_confirmed', 'merchant_canceled', 'reconfirmation_sent'))
  ),
  CONSTRAINT "verification_change_requests_event_id_check" CHECK (char_length("opened_event_id") BETWEEN 1 AND 256),
  CONSTRAINT "verification_change_requests_error_check" CHECK ("last_reconfirmation_error" IS NULL OR char_length("last_reconfirmation_error") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_change_requests_one_open" ON "verification_change_requests" USING btree ("verification_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_change_requests_org_open" ON "verification_change_requests" USING btree ("org_id", "opened_at") WHERE "status" = 'open';--> statement-breakpoint
ALTER TABLE "verification_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_change_requests" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification change requests" ON "verification_change_requests";--> statement-breakpoint
CREATE POLICY "Service role manages verification change requests" ON "verification_change_requests" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_change_request_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "change_request_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "event" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" uuid,
  "source_event_id" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_change_request_events_request_fkey" FOREIGN KEY ("change_request_id", "org_id") REFERENCES "verification_change_requests"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_request_events_event_check" CHECK ("event" IN ('opened', 'repeat_ignored', 'resolved', 'reconfirmation_failed')),
  CONSTRAINT "verification_change_request_events_actor_check" CHECK ("actor_kind" IN ('customer', 'merchant', 'system')),
  CONSTRAINT "verification_change_request_events_source_event_check" CHECK ("source_event_id" IS NULL OR char_length("source_event_id") BETWEEN 1 AND 256)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_change_request_events_source_event_key" ON "verification_change_request_events" USING btree ("change_request_id", "source_event_id") WHERE "source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_change_request_events_request" ON "verification_change_request_events" USING btree ("change_request_id", "created_at");--> statement-breakpoint
ALTER TABLE "verification_change_request_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_change_request_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification change request events" ON "verification_change_request_events";--> statement-breakpoint
CREATE POLICY "Service role manages verification change request events" ON "verification_change_request_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_change_request_effects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "change_request_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_change_request_effects_kind_key" UNIQUE ("change_request_id", "kind"),
  CONSTRAINT "verification_change_request_effects_request_fkey" FOREIGN KEY ("change_request_id", "org_id") REFERENCES "verification_change_requests"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_change_request_effects_kind_check" CHECK ("kind" IN ('customer_acknowledgment', 'merchant_email', 'platform_marker_set', 'platform_marker_clear')),
  CONSTRAINT "verification_change_request_effects_status_check" CHECK ("status" IN ('pending', 'in_progress', 'done', 'skipped', 'failed')),
  CONSTRAINT "verification_change_request_effects_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "verification_change_request_effects_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_change_request_effects_due" ON "verification_change_request_effects" USING btree ("kind", "status", "created_at") WHERE "status" IN ('pending', 'in_progress');--> statement-breakpoint
ALTER TABLE "verification_change_request_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_change_request_effects" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification change request effects" ON "verification_change_request_effects";--> statement-breakpoint
CREATE POLICY "Service role manages verification change request effects" ON "verification_change_request_effects" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
