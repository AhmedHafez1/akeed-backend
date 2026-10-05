-- WooCommerce disconnect, same-store reconnect and webhook state (US-07-05).
--
-- A disconnect keeps the connection row, because the canonical store URL is
-- what a reconnect must match, and wipes every credential on it: the consumer
-- key, the consumer secret, the webhook secret, the delivery URL token hash and
-- the ids of the two webhooks Akeed created. So those six columns that were
-- NOT NULL become nullable, and "disconnected_at" says which rows are allowed
-- to hold none. A disconnected row has no key to back its store, so it also
-- gives up the verified-store slot. The check enforces both halves.
--
-- "order_created_webhook_state" and "order_updated_webhook_state" hold what
-- the store last answered for each webhook, and "webhooks_checked_at" when it
-- was asked. They are written at connect ('active') and whenever health is
-- read, the connection is checked or a webhook is re-enabled; nothing polls.
-- NULL means the store has not been asked since the row was created.
--
-- Rollback: reconnect or delete every row with "disconnected_at" set (its
-- credentials are gone by design; deleting a connection row keeps the
-- integration, its orders and its verifications), then drop the two checks,
-- SET NOT NULL on the six columns and drop the five columns. No existing row
-- is rewritten by this migration.
ALTER TABLE "woocommerce_connections" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD COLUMN IF NOT EXISTS "disconnected_by" uuid;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD COLUMN IF NOT EXISTS "order_created_webhook_state" text;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD COLUMN IF NOT EXISTS "order_updated_webhook_state" text;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD COLUMN IF NOT EXISTS "webhooks_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "consumer_key_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "consumer_secret_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "webhook_secret_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "webhook_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "order_created_webhook_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ALTER COLUMN "order_updated_webhook_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" DROP CONSTRAINT IF EXISTS "woocommerce_connections_credentials_state_check";--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD CONSTRAINT "woocommerce_connections_credentials_state_check" CHECK (("disconnected_at" IS NULL AND "consumer_key_encrypted" IS NOT NULL AND "consumer_secret_encrypted" IS NOT NULL AND "webhook_secret_encrypted" IS NOT NULL AND "webhook_token_hash" IS NOT NULL AND "order_created_webhook_id" IS NOT NULL AND "order_updated_webhook_id" IS NOT NULL) OR ("disconnected_at" IS NOT NULL AND "consumer_key_encrypted" IS NULL AND "consumer_secret_encrypted" IS NULL AND "webhook_secret_encrypted" IS NULL AND "webhook_token_hash" IS NULL AND "order_created_webhook_id" IS NULL AND "order_updated_webhook_id" IS NULL AND "order_created_webhook_state" IS NULL AND "order_updated_webhook_state" IS NULL AND "store_verified_at" IS NULL));--> statement-breakpoint
ALTER TABLE "woocommerce_connections" DROP CONSTRAINT IF EXISTS "woocommerce_connections_webhook_state_check";--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ADD CONSTRAINT "woocommerce_connections_webhook_state_check" CHECK (("order_created_webhook_state" IS NULL OR "order_created_webhook_state" = ANY (ARRAY['active'::text, 'paused'::text, 'disabled'::text, 'missing'::text])) AND ("order_updated_webhook_state" IS NULL OR "order_updated_webhook_state" = ANY (ARRAY['active'::text, 'paused'::text, 'disabled'::text, 'missing'::text])));
