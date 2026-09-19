-- US-04.6-02: durable import batches, their parsed rows and saved column
-- mappings for Standalone bulk order import (E04.6).
--
-- Additive only: three new tables, nothing existing is altered. Every route
-- that writes them is behind STANDALONE_BULK_IMPORT_ENABLED.
--
-- Rollback: turn the flag off. The tables can stay; drop them only after every
-- batch is purged (rows cascade from their batch).
CREATE TABLE IF NOT EXISTS "order_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" char(64) NOT NULL,
	"file_size" integer NOT NULL,
	"file_format" text NOT NULL,
	"encoding" text,
	"delimiter" text,
	"sheet_name" text,
	"headers" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"mapping" jsonb,
	"options" jsonb,
	"mapping_profile_id" uuid,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order_date_min" date,
	"order_date_max" date,
	"commit_idempotency_key" text,
	"start_idempotency_key" text,
	"committed_at" timestamp with time zone,
	"attested_by" uuid,
	"attested_at" timestamp with time zone,
	"attestation_version" text,
	"started_at" timestamp with time zone,
	"paused_reason" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"start_deadline_at" timestamp with time zone,
	"short_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_batches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "order_import_batches_integration_id_fkey" FOREIGN KEY ("integration_id","org_id") REFERENCES "integrations"("id","org_id"),
	CONSTRAINT "order_import_batches_id_org_id_key" UNIQUE("id","org_id"),
	CONSTRAINT "order_import_batches_commit_key" UNIQUE("org_id","commit_idempotency_key"),
	CONSTRAINT "order_import_batches_short_code_key" UNIQUE("org_id","short_code"),
	CONSTRAINT "order_import_batches_status_check" CHECK ("status" IN ('draft', 'committing', 'awaiting_start', 'releasing', 'paused', 'completed', 'stopped', 'not_started', 'expired', 'failed')),
	CONSTRAINT "order_import_batches_file_format_check" CHECK ("file_format" IN ('csv', 'xlsx')),
	-- IMP-<code>-<row> order numbers: six Crockford base32 characters.
	CONSTRAINT "order_import_batches_short_code_check" CHECK ("short_code" ~ '^[0-9A-HJKMNP-TV-Z]{6}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_import_batches_org_created" ON "order_import_batches" USING btree ("org_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_import_batches_org_sha" ON "order_import_batches" USING btree ("org_id","file_sha256","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"outcome" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"include_override" boolean DEFAULT false NOT NULL,
	"dedupe_key" text,
	"collapsed_into" integer,
	"order_id" uuid,
	"webhook_event_id" uuid,
	-- The composite key keeps a row inside its batch's organization.
	CONSTRAINT "order_import_rows_batch_id_fkey" FOREIGN KEY ("batch_id","org_id") REFERENCES "order_import_batches"("id","org_id") ON DELETE CASCADE,
	CONSTRAINT "order_import_rows_batch_row_key" UNIQUE("batch_id","row_number"),
	CONSTRAINT "order_import_rows_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('ready', 'invalid', 'duplicate', 'excluded', 'imported'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_import_rows_batch_outcome" ON "order_import_rows" USING btree ("batch_id","outcome","row_number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_import_mapping_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"header_signature" char(64) NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_mapping_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "order_import_mapping_profiles_signature_key" UNIQUE("org_id","header_signature")
);--> statement-breakpoint
-- Row-level security matches orders: a signed-in member sees only their
-- organization. As for orders, the API still scopes every query by org_id.
ALTER TABLE "order_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_import_mapping_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "Multi-tenant order import batches" ON "order_import_batches";--> statement-breakpoint
CREATE POLICY "Multi-tenant order import batches" ON "order_import_batches" AS PERMISSIVE FOR ALL TO authenticated USING (org_id = get_user_org_id()) WITH CHECK (org_id = get_user_org_id());--> statement-breakpoint
DROP POLICY IF EXISTS "Multi-tenant order import rows" ON "order_import_rows";--> statement-breakpoint
CREATE POLICY "Multi-tenant order import rows" ON "order_import_rows" AS PERMISSIVE FOR ALL TO authenticated USING (org_id = get_user_org_id()) WITH CHECK (org_id = get_user_org_id());--> statement-breakpoint
DROP POLICY IF EXISTS "Multi-tenant order import mapping profiles" ON "order_import_mapping_profiles";--> statement-breakpoint
CREATE POLICY "Multi-tenant order import mapping profiles" ON "order_import_mapping_profiles" AS PERMISSIVE FOR ALL TO authenticated USING (org_id = get_user_org_id()) WITH CHECK (org_id = get_user_org_id());
