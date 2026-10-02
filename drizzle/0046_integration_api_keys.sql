-- Server credentials for one Standalone integration (US-05-01). A key is
-- shown once; only the SHA-256 of its 32-byte random secret is stored, beside
-- a non-secret, unique prefix that the API guard looks the key up by.
--
-- Rollback: DROP TABLE "integration_api_keys".
-- No existing data is rewritten.
CREATE TABLE IF NOT EXISTS "integration_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "integration_api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "integration_api_keys_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "integration_api_keys_prefix_key" UNIQUE ("prefix"),
	CONSTRAINT "integration_api_keys_prefix_check" CHECK ("prefix" ~ '^ak_live_[a-z0-9]{8}$'),
	CONSTRAINT "integration_api_keys_key_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "integration_api_keys_name_check" CHECK (char_length("name") BETWEEN 1 AND 60),
	CONSTRAINT "integration_api_keys_revoked_check" CHECK ("revoked_by" IS NULL OR "revoked_at" IS NOT NULL)
);--> statement-breakpoint
-- The active-key count per integration (the issuance cap) and the guard's
-- revocation check; also covers the integration foreign key.
CREATE INDEX IF NOT EXISTS "idx_integration_api_keys_integration_revoked" ON "integration_api_keys" USING btree ("integration_id", "revoked_at");--> statement-breakpoint
-- The settings list; also covers the organization foreign key.
CREATE INDEX IF NOT EXISTS "idx_integration_api_keys_org_created" ON "integration_api_keys" USING btree ("org_id", "created_at" DESC);--> statement-breakpoint
-- Keys are issued and revoked only by the API, which checks the member's
-- role. Supabase grants new tables to anon and authenticated by default, so
-- those grants are withdrawn: a viewer must not be able to insert a key whose
-- hash they chose. Members may read their organization's key metadata, never
-- the hash.
ALTER TABLE "integration_api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "integration_api_keys" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
GRANT SELECT ("id", "org_id", "integration_id", "prefix", "name", "created_by", "created_at", "last_used_at", "revoked_at", "revoked_by") ON "integration_api_keys" TO authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Members read integration api key metadata" ON "integration_api_keys";--> statement-breakpoint
CREATE POLICY "Members read integration api key metadata" ON "integration_api_keys" AS PERMISSIVE FOR SELECT TO authenticated USING (org_id = get_user_org_id());
