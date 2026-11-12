-- Shopify 48-hour uninstall window: when the store last uninstalled.
-- Existing inactive rows are deliberately left NULL (no backfill): only
-- uninstalls after this release are scheduled for automatic deletion.
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "uninstalled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integrations_uninstalled_due" ON "integrations" USING btree ("uninstalled_at") WHERE "is_active" = false AND "uninstalled_at" IS NOT NULL;
