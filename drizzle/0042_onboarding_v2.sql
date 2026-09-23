-- Onboarding v2: install to first WhatsApp message without a plan picker.
--
-- integrations.merchant_whatsapp_phone is the number the merchant enters in
-- quick setup to receive the free onboarding test message. shop_phone is the
-- Shopify billing-address phone, captured at install only to prefill it.
--
-- admin_store_lifecycles gains first-hit milestones for the new funnel stages
-- (setup completed, test sent/confirmed/skipped, first real confirmation, 80%
-- of included messages used), written with COALESCE like the existing ones.
--
-- product_events keeps every funnel event, including repeats such as
-- test_resend, which milestones cannot count. It is service-role only, like
-- the other admin lifecycle tables, and is also the source for the onboarding
-- test cooldown and daily cap.
--
-- Rollback: DROP TABLE "product_events"; drop the six lifecycle columns and
-- the two integrations columns. No existing data is rewritten.
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "merchant_whatsapp_phone" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "shop_phone" text;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "test_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "test_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "test_skipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "first_real_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_store_lifecycles" ADD COLUMN IF NOT EXISTS "credits_80_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "name" text NOT NULL,
  "props" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_events_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "product_events_integration_id_fkey"
    FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_product_events_integration_name_created"
  ON "product_events" ("integration_id", "name", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_product_events_name_created"
  ON "product_events" ("name", "created_at");--> statement-breakpoint
ALTER TABLE "product_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages product events" ON "product_events";--> statement-breakpoint
CREATE POLICY "Service role manages product events"
  ON "product_events" FOR ALL TO service_role
  USING (true) WITH CHECK (true);
