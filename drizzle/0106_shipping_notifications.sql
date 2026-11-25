-- Shipping notifications: the merchant's settings and one record per order
-- and stage.
--
-- "integrations" gains:
--   * "shipping_notifications_enabled": the merchant's opt-in. Off for every
--     store, existing and new.
--   * "shipping_fulfillment_trigger_enabled": a store fulfillment counts as
--     shipped. On by default, so switching the feature on enables it.
--   * "shipping_tags": order tags that also count as shipped. Empty by default.
--
-- "verification_shipping_notifications" holds at most one row per
-- verification and stage. The unique key makes duplicate, replayed and
-- out-of-order store events, and a tag added after fulfillment, leave one row.
-- A row that can never be sent is "failed" with a reason code, so the merchant
-- sees why.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "verification_shipping_notifications";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "shipping_tags";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "shipping_fulfillment_trigger_enabled";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "shipping_notifications_enabled";

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "shipping_notifications_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "shipping_fulfillment_trigger_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "shipping_tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_shipping_tags_count_check";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_shipping_tags_count_check" CHECK (cardinality("shipping_tags") <= 10);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification_shipping_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "trigger" text NOT NULL,
  "matched_tag" text,
  "tracking_number" text,
  "tracking_url" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason_code" text,
  "dispatch_id" uuid,
  "customer_reply" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_shipping_notifications_stage_key" UNIQUE ("verification_id", "stage"),
  CONSTRAINT "verification_shipping_notifications_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_shipping_notifications_dispatch_fkey" FOREIGN KEY ("dispatch_id", "org_id") REFERENCES "verification_message_dispatches"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_shipping_notifications_stage_check" CHECK ("stage" IN ('shipped')),
  CONSTRAINT "verification_shipping_notifications_trigger_check" CHECK ("trigger" IN ('fulfillment', 'tag')),
  CONSTRAINT "verification_shipping_notifications_status_check" CHECK ("status" IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  CONSTRAINT "verification_shipping_notifications_reason_check" CHECK (("status" = 'failed') = ("reason_code" IS NOT NULL) AND ("reason_code" IS NULL OR "reason_code" IN ('no_phone', 'not_on_whatsapp', 'allowance_low', 'no_allowance', 'order_too_old', 'order_cancelled', 'send_failed', 'template_unavailable'))),
  CONSTRAINT "verification_shipping_notifications_tag_check" CHECK (("trigger" = 'tag') = ("matched_tag" IS NOT NULL) AND ("matched_tag" IS NULL OR char_length("matched_tag") BETWEEN 1 AND 40)),
  CONSTRAINT "verification_shipping_notifications_tracking_check" CHECK (("tracking_number" IS NULL OR char_length("tracking_number") BETWEEN 1 AND 255) AND ("tracking_url" IS NULL OR (char_length("tracking_url") <= 2048 AND "tracking_url" LIKE 'https://%')))
);--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_shipping_notifications" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification shipping notifications" ON "verification_shipping_notifications";--> statement-breakpoint
CREATE POLICY "Service role manages verification shipping notifications" ON "verification_shipping_notifications" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
