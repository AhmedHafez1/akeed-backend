-- EasyOrders authorized connection (US-06-02).
--
-- "easyorders_pending_installs" is the single-use, expiring install context:
-- EasyOrders has no `state` parameter, so a random token rides in the path of
-- Akeed's callback URL and only its SHA-256 is stored here, bound to the
-- organization that started the install.
--
-- "easyorders_connections" holds one integration's EasyOrders credentials: the
-- API key and the two seller-copied webhook secrets (AES-256-GCM ciphertext),
-- the hash of the per-install webhook URL token, and the store the callback
-- claimed. The claim is verified later, when data fetched with the key carries
-- the same store id, and only a verified claim holds the one-store slot.
--
-- Rollback: DROP TABLE "easyorders_connections"; DROP TABLE
-- "easyorders_pending_installs". No existing data is rewritten; an
-- "integrations" row with platform_type 'easyorders' is deactivated, not
-- deleted, so its history stays.
CREATE TABLE IF NOT EXISTS "easyorders_pending_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"callback_token_hash" text NOT NULL,
	"webhook_token_hash" text NOT NULL,
	"webhook_token_hint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "easyorders_pending_installs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "easyorders_pending_installs_callback_token_hash_key" UNIQUE ("callback_token_hash"),
	CONSTRAINT "easyorders_pending_installs_webhook_token_hash_key" UNIQUE ("webhook_token_hash"),
	CONSTRAINT "easyorders_pending_installs_callback_token_hash_check" CHECK ("callback_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "easyorders_pending_installs_webhook_token_hash_check" CHECK ("webhook_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "easyorders_pending_installs_attempts_check" CHECK ("attempts" >= 0)
);--> statement-breakpoint
-- The organization's latest context (connection status) and the supersede
-- update; also covers the organization foreign key.
CREATE INDEX IF NOT EXISTS "idx_easyorders_pending_installs_org_created" ON "easyorders_pending_installs" USING btree ("org_id", "created_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "easyorders_connections" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" text NOT NULL,
	"store_verified_at" timestamp with time zone,
	"api_key_encrypted" text NOT NULL,
	"webhook_token_hash" text NOT NULL,
	"webhook_token_hint" text NOT NULL,
	"orders_webhook_secret_encrypted" text,
	"status_webhook_secret_encrypted" text,
	"health" text DEFAULT 'ok' NOT NULL,
	"connected_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "easyorders_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "easyorders_connections_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "easyorders_connections_webhook_token_hash_key" UNIQUE ("webhook_token_hash"),
	CONSTRAINT "easyorders_connections_webhook_token_hash_check" CHECK ("webhook_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "easyorders_connections_store_id_check" CHECK (char_length("store_id") BETWEEN 1 AND 128),
	CONSTRAINT "easyorders_connections_health_check" CHECK ("health" = ANY (ARRAY['ok'::text, 'store_inactive'::text])),
	-- Ciphertext only: the `v1:` envelope written by encryptToken.
	CONSTRAINT "easyorders_connections_api_key_encrypted_check" CHECK ("api_key_encrypted" LIKE 'v1:%'),
	CONSTRAINT "easyorders_connections_orders_secret_encrypted_check" CHECK ("orders_webhook_secret_encrypted" IS NULL OR "orders_webhook_secret_encrypted" LIKE 'v1:%'),
	CONSTRAINT "easyorders_connections_status_secret_encrypted_check" CHECK ("status_webhook_secret_encrypted" IS NULL OR "status_webhook_secret_encrypted" LIKE 'v1:%')
);--> statement-breakpoint
-- One EasyOrders store maps to at most one integration, once the store is
-- verified. An unverified claim never blocks the real owner.
CREATE UNIQUE INDEX IF NOT EXISTS "easyorders_connections_verified_store_key" ON "easyorders_connections" USING btree ("store_id") WHERE "store_verified_at" IS NOT NULL;--> statement-breakpoint
-- The "is this store already verified elsewhere" check on every callback.
CREATE INDEX IF NOT EXISTS "idx_easyorders_connections_store" ON "easyorders_connections" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_easyorders_connections_org" ON "easyorders_connections" USING btree ("org_id");--> statement-breakpoint
-- Both tables hold credentials or their hashes and are read and written only
-- by the API. Supabase grants new tables to anon and authenticated by default,
-- so those grants are withdrawn and no policy is created.
ALTER TABLE "easyorders_pending_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "easyorders_pending_installs" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
ALTER TABLE "easyorders_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "easyorders_connections" FROM PUBLIC, anon, authenticated;
