-- EasyOrders webhook cleanup on disconnect.
--
-- Until now the per-install webhook URL token was stored only as a hash, so
-- Akeed could not rebuild the two webhook addresses and the merchant deleted
-- the webhooks in EasyOrders by hand. The token is now also kept as ciphertext
-- (`encryptToken`, like the API key), first on the install context and then on
-- the connection, so a disconnect can ask EasyOrders to delete them by URL.
--
-- "provider_cleanup" records how that went on a disconnected row: 'removed'
-- when EasyOrders no longer holds the webhooks, 'manual' when the merchant
-- still has to delete them. It is cleared by a reconnect.
--
-- Rows connected before this migration keep a null token: their next
-- disconnect is recorded as 'manual'. A disconnected row holds no token, like
-- every other credential, and the check enforces it.
--
-- Rollback: drop the two checks added here, restore the previous
-- "easyorders_connections_credentials_state_check" (migration 0050) and drop
-- the three columns. No existing row is rewritten by this migration.
ALTER TABLE "easyorders_pending_installs" ADD COLUMN IF NOT EXISTS "webhook_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "easyorders_pending_installs" DROP CONSTRAINT IF EXISTS "easyorders_pending_installs_webhook_token_encrypted_check";--> statement-breakpoint
ALTER TABLE "easyorders_pending_installs" ADD CONSTRAINT "easyorders_pending_installs_webhook_token_encrypted_check" CHECK ("webhook_token_encrypted" IS NULL OR "webhook_token_encrypted" LIKE 'v1:%');--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "webhook_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "provider_cleanup" text;--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_webhook_token_encrypted_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_webhook_token_encrypted_check" CHECK ("webhook_token_encrypted" IS NULL OR "webhook_token_encrypted" LIKE 'v1:%');--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_provider_cleanup_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_provider_cleanup_check" CHECK ("provider_cleanup" IS NULL OR ("disconnected_at" IS NOT NULL AND "provider_cleanup" = ANY (ARRAY['removed'::text, 'manual'::text])));--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_credentials_state_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_credentials_state_check" CHECK (("disconnected_at" IS NULL AND "api_key_encrypted" IS NOT NULL AND "webhook_token_hash" IS NOT NULL AND "webhook_token_hint" IS NOT NULL) OR ("disconnected_at" IS NOT NULL AND "api_key_encrypted" IS NULL AND "webhook_token_hash" IS NULL AND "webhook_token_hint" IS NULL AND "webhook_token_encrypted" IS NULL AND "orders_webhook_secret_encrypted" IS NULL AND "status_webhook_secret_encrypted" IS NULL AND "store_verified_at" IS NULL));
