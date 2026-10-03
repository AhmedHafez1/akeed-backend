-- EasyOrders disconnect and same-store reconnect (US-06-05).
--
-- A disconnect keeps the connection row, because the store id is what a
-- reconnect must match, and wipes every credential on it: the API key, the
-- webhook URL token and both webhook secrets. So the three credential columns
-- that were NOT NULL become nullable, and "disconnected_at" says which rows
-- are allowed to have none.
--
-- A disconnected row has no key to back its store claim, so it also gives up
-- the verified-store slot (contract record section 2: an unverified claim must
-- not hold the slot against the real owner). The check enforces both halves.
--
-- Rollback: reconnect or delete every row with "disconnected_at" set (its
-- credentials are gone by design; deleting a connection row keeps the
-- integration, its orders and its verifications), then drop the check, SET NOT
-- NULL on the three columns and drop the two columns. No existing row is
-- rewritten by this migration.
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD COLUMN IF NOT EXISTS "disconnected_by" uuid;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ALTER COLUMN "api_key_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ALTER COLUMN "webhook_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ALTER COLUMN "webhook_token_hint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "easyorders_connections" DROP CONSTRAINT IF EXISTS "easyorders_connections_credentials_state_check";--> statement-breakpoint
ALTER TABLE "easyorders_connections" ADD CONSTRAINT "easyorders_connections_credentials_state_check" CHECK (("disconnected_at" IS NULL AND "api_key_encrypted" IS NOT NULL AND "webhook_token_hash" IS NOT NULL AND "webhook_token_hint" IS NOT NULL) OR ("disconnected_at" IS NOT NULL AND "api_key_encrypted" IS NULL AND "webhook_token_hash" IS NULL AND "webhook_token_hint" IS NULL AND "orders_webhook_secret_encrypted" IS NULL AND "status_webhook_secret_encrypted" IS NULL AND "store_verified_at" IS NULL));
