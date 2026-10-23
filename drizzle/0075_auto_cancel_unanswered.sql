-- Automatic cancellation of unanswered COD orders.
--
-- A store may switch on "auto_cancel_enabled". An order that then reaches
-- 'no_reply' is canceled in its store once every safety rule holds: the
-- confirmation and any reminder were delivered, the customer never wrote back,
-- the merchant did not exclude the order, and the store still reports it
-- unpaid and unfulfilled. The reason recorded is "No response after
-- confirmation attempts" ("cancellation_source" = 'automatic_no_reply').
--
-- "integrations" gains:
--   * "auto_cancel_enabled": off by default, for every existing store too.
--   * "auto_cancel_restock": restock the items on cancel (Shopify).
--   * "auto_cancel_notify_customer": let the store email the customer (Shopify).
--
-- "verifications" gains:
--   * "customer_last_message_at": the latest message received from the
--     customer's number for this order, whatever it said. Any message stops
--     the automatic cancellation.
--   * "auto_cancel_excluded_at", "auto_cancel_excluded_by": the merchant kept
--     this order out of the automatic cancellation, and who did.
--
-- "verification_auto_cancellations" holds one row per verification, the state
-- of its automatic cancellation. The unique verification id is what stops a
-- second attempt. "verification_auto_cancellation_events" is its append-only
-- audit trail.
--
-- "commerce_outcome_syncs"."action" accepts 'automatic_no_reply_cancellation'.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "verification_auto_cancellation_events";
--   DROP TABLE IF EXISTS "verification_auto_cancellations";
--   ALTER TABLE "verifications" DROP COLUMN IF EXISTS "customer_last_message_at",
--     DROP COLUMN IF EXISTS "auto_cancel_excluded_at", DROP COLUMN IF EXISTS "auto_cancel_excluded_by";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "auto_cancel_enabled",
--     DROP COLUMN IF EXISTS "auto_cancel_restock", DROP COLUMN IF EXISTS "auto_cancel_notify_customer";
-- and restore the previous "commerce_outcome_syncs_action_check".

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "auto_cancel_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "auto_cancel_restock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "auto_cancel_notify_customer" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "customer_last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "auto_cancel_excluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "auto_cancel_excluded_by" uuid;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_auto_cancellations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "due_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamp with time zone,
  "provider_operation_id" text,
  "restock" boolean,
  "notify_customer" boolean,
  "dispatched_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "late_reply_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_auto_cancellations_verification_key" UNIQUE ("verification_id"),
  CONSTRAINT "verification_auto_cancellations_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_auto_cancellations_order_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "orders"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_auto_cancellations_integration_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_auto_cancellations_status_check" CHECK ("status" IN ('scheduled', 'paused', 'in_progress', 'awaiting_platform', 'succeeded', 'failed', 'skipped', 'stopped')),
  CONSTRAINT "verification_auto_cancellations_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "verification_auto_cancellations_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_auto_cancellations_status_due" ON "verification_auto_cancellations" USING btree ("status", "due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_auto_cancellations_org" ON "verification_auto_cancellations" USING btree ("org_id", "verification_id");--> statement-breakpoint
ALTER TABLE "verification_auto_cancellations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_auto_cancellations" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification auto cancellations" ON "verification_auto_cancellations";--> statement-breakpoint
CREATE POLICY "Service role manages verification auto cancellations" ON "verification_auto_cancellations" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_auto_cancellation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "event" text NOT NULL,
  "actor_user_id" uuid,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_auto_cancellation_events_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_auto_cancellation_events_event_check" CHECK ("event" IN ('scheduled', 'paused', 'resumed', 'excluded', 'included', 'stopped', 'platform_checked', 'dispatch_started', 'platform_pending', 'retry_scheduled', 'succeeded', 'failed', 'skipped', 'late_reply'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_auto_cancellation_events_verification" ON "verification_auto_cancellation_events" USING btree ("verification_id", "created_at");--> statement-breakpoint
ALTER TABLE "verification_auto_cancellation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_auto_cancellation_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification auto cancellation events" ON "verification_auto_cancellation_events";--> statement-breakpoint
CREATE POLICY "Service role manages verification auto cancellation events" ON "verification_auto_cancellation_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "commerce_outcome_syncs" DROP CONSTRAINT IF EXISTS "commerce_outcome_syncs_action_check";--> statement-breakpoint
ALTER TABLE "commerce_outcome_syncs" ADD CONSTRAINT "commerce_outcome_syncs_action_check" CHECK ("action" = ANY (ARRAY['customer_confirmation'::text, 'customer_cancellation'::text, 'merchant_no_reply_cancellation'::text, 'merchant_cancellation_tagging'::text, 'automatic_no_reply_tagging'::text, 'automatic_no_whatsapp_tagging'::text, 'automatic_no_reply_cancellation'::text]));
