-- EasyOrders order-webhook ingestion (US-06-03).
--
-- The order payload carries no currency and no country (contract record
-- section 4), so both are setup inputs the merchant chooses. They are nullable:
-- while either is missing an order is recorded as not eligible, never guessed.
--
-- "rejected_deliveries" counts webhooks that reached a valid URL token with a
-- wrong secret, so a mistyped secret is visible instead of silent (section 7).
--
-- "credentials_rejected" is the health state of a key EasyOrders answered
-- 401 or 403 for: a permanent failure that needs the merchant (section 2).
--
-- Rollback: restore the two-value health check after moving any
-- 'credentials_rejected' row back to 'ok', then drop the four columns and
-- their checks. No existing row is rewritten by this migration.
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "phone_country" varchar(2);--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "rejected_deliveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "last_rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_currency_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_phone_country_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_phone_country_check" CHECK ("phone_country" IS NULL OR "phone_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_rejected_deliveries_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_rejected_deliveries_check" CHECK ("rejected_deliveries" >= 0);--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_health_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_health_check" CHECK ("health" = ANY (ARRAY['ok'::text, 'store_inactive'::text, 'credentials_rejected'::text]));
