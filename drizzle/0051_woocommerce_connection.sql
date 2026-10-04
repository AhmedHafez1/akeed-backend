-- WooCommerce application-authentication connection (US-07-02).
--
-- "woocommerce_pending_installs" is the single-use, expiring install context.
-- The authorize link has no `state` and the callback names no store, so the
-- organization and the store both come from this row: a random token rides in
-- the path of Akeed's callback URL and only its SHA-256 is stored here, next
-- to the canonical store URL the merchant entered. "install_reference" is the
-- non-secret number sent as `user_id`. "webhook_token_hash" is written by the
-- callback just before it creates the webhooks, because the store pings the
-- delivery URL before the connection exists; it is NULL until then.
-- "claimed_until" lets one callback at a time run the store calls for an
-- install.
--
-- "woocommerce_connections" holds one integration's credentials: the consumer
-- key, the consumer secret and the webhook secret Akeed generated (AES-256-GCM
-- ciphertext), the hash of the delivery URL token, the ids of the two webhooks
-- Akeed created, and the canonical store URL. The store is verified at
-- connect, and a verified store belongs to one integration.
--
-- Rollback: DROP TABLE "woocommerce_connections"; DROP TABLE
-- "woocommerce_pending_installs". No existing data is rewritten; an
-- "integrations" row with platform_type 'woocommerce' is deactivated, not
-- deleted, so its history stays.
CREATE TABLE IF NOT EXISTS "woocommerce_pending_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"store_url" text NOT NULL,
	"callback_token_hash" text NOT NULL,
	"install_reference" text NOT NULL,
	"webhook_token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "woocommerce_pending_installs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "woocommerce_pending_installs_callback_token_hash_key" UNIQUE ("callback_token_hash"),
	CONSTRAINT "woocommerce_pending_installs_install_reference_key" UNIQUE ("install_reference"),
	CONSTRAINT "woocommerce_pending_installs_webhook_token_hash_key" UNIQUE ("webhook_token_hash"),
	CONSTRAINT "woocommerce_pending_installs_callback_token_hash_check" CHECK ("callback_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "woocommerce_pending_installs_webhook_token_hash_check" CHECK ("webhook_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "woocommerce_pending_installs_install_reference_check" CHECK ("install_reference" ~ '^[0-9]{15}$'),
	CONSTRAINT "woocommerce_pending_installs_store_url_check" CHECK ("store_url" LIKE 'https://%' AND char_length("store_url") <= 255),
	CONSTRAINT "woocommerce_pending_installs_attempts_check" CHECK ("attempts" >= 0)
);--> statement-breakpoint
-- The organization's latest context (connection status) and the supersede
-- update; also covers the organization foreign key.
CREATE INDEX IF NOT EXISTS "idx_woocommerce_pending_installs_org_created" ON "woocommerce_pending_installs" USING btree ("org_id", "created_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "woocommerce_connections" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"store_url" text NOT NULL,
	"store_verified_at" timestamp with time zone,
	"consumer_key_encrypted" text NOT NULL,
	"consumer_secret_encrypted" text NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"webhook_token_hash" text NOT NULL,
	"order_created_webhook_id" bigint NOT NULL,
	"order_updated_webhook_id" bigint NOT NULL,
	"woo_version" text,
	"health" text DEFAULT 'ok' NOT NULL,
	"rejected_deliveries" integer DEFAULT 0 NOT NULL,
	"last_rejected_at" timestamp with time zone,
	"connected_by" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "woocommerce_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "woocommerce_connections_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "woocommerce_connections_webhook_token_hash_key" UNIQUE ("webhook_token_hash"),
	CONSTRAINT "woocommerce_connections_webhook_token_hash_check" CHECK ("webhook_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "woocommerce_connections_store_url_check" CHECK ("store_url" LIKE 'https://%' AND char_length("store_url") <= 255),
	CONSTRAINT "woocommerce_connections_health_check" CHECK ("health" = ANY (ARRAY['ok'::text, 'credentials_rejected'::text, 'permission_denied'::text])),
	CONSTRAINT "woocommerce_connections_webhook_ids_check" CHECK ("order_created_webhook_id" > 0 AND "order_updated_webhook_id" > 0),
	CONSTRAINT "woocommerce_connections_woo_version_check" CHECK ("woo_version" IS NULL OR char_length("woo_version") BETWEEN 1 AND 32),
	CONSTRAINT "woocommerce_connections_rejected_deliveries_check" CHECK ("rejected_deliveries" >= 0),
	-- Ciphertext only: the `v1:` envelope written by encryptToken.
	CONSTRAINT "woocommerce_connections_consumer_key_encrypted_check" CHECK ("consumer_key_encrypted" LIKE 'v1:%'),
	CONSTRAINT "woocommerce_connections_consumer_secret_encrypted_check" CHECK ("consumer_secret_encrypted" LIKE 'v1:%'),
	CONSTRAINT "woocommerce_connections_webhook_secret_encrypted_check" CHECK ("webhook_secret_encrypted" LIKE 'v1:%')
);--> statement-breakpoint
-- One WooCommerce store maps to at most one integration, once it is verified.
-- This index also serves the "is this store connected elsewhere" check.
CREATE UNIQUE INDEX IF NOT EXISTS "woocommerce_connections_verified_store_key" ON "woocommerce_connections" USING btree ("store_url") WHERE "store_verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_woocommerce_connections_org" ON "woocommerce_connections" USING btree ("org_id");--> statement-breakpoint
-- Both tables hold credentials or their hashes and are read and written only
-- by the API. Supabase grants new tables to anon and authenticated by default,
-- so those grants are withdrawn and no policy is created.
ALTER TABLE "woocommerce_pending_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "woocommerce_pending_installs" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "woocommerce_connections" FROM PUBLIC, anon, authenticated;
