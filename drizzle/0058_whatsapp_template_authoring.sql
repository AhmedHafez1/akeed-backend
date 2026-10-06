-- Staff template authoring: drafts, edits and retiring (US-08-06).
--
-- "whatsapp_template_drafts" holds what an operator writes before, and after,
-- a template exists at the provider. The body is kept in Akeed's own
-- placeholder syntax ({{customer}}, {{store}}, {{order}}, {{total}}); the
-- provider's syntax is built in the provider adapter at submit time.
--   * "state" is 'draft' (editable), 'submitting' (one submit is in flight),
--     'submit_unknown' (the provider's answer never arrived, so staff must
--     check the provider before anything is sent again) or 'submitted'.
--   * "template_id" names the registry row, which is inserted only once the
--     provider has confirmed the template. A draft that was never confirmed
--     therefore has no registry row, and no send path can read it.
--   * "key" and ("meta_template_name", "meta_language_code") are unique, so
--     two drafts can never claim one template.
--
-- "whatsapp_template_edits" records every edit sent to the provider. Akeed
-- counts an approved template's edits itself, in rolling windows, from these
-- rows; an edit whose outcome is unknown counts.
--
-- "whatsapp_templates" gains "retired_at" (a retired template is inactive for
-- good) and "rejection_reason" (the provider's reason for a rejection, as a
-- neutral value). Neither is read by a send.
--
-- Both new tables are service-role only, like "whatsapp_templates".
-- Everything here is additive and safe to replay. No row is written.
--
-- Rollback: set WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false, which refuses
-- every template write; templates already approved and active keep sending.
-- To remove the schema too, deploy the previous release and then run:
--   DROP TABLE IF EXISTS "whatsapp_template_edits";
--   DROP TABLE IF EXISTS "whatsapp_template_drafts";
--   ALTER TABLE "whatsapp_templates" DROP COLUMN IF EXISTS "retired_at",
--     DROP COLUMN IF EXISTS "rejection_reason";
-- Registry rows created from drafts stay valid registry rows: the previous
-- release reads them like any other.
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "rejection_reason" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_template_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "purpose" text NOT NULL,
  "language" text NOT NULL,
  "style" text NOT NULL,
  "version" integer NOT NULL,
  "meta_template_name" text NOT NULL,
  "meta_language_code" text NOT NULL,
  "parameter_format" text NOT NULL,
  "category" text NOT NULL,
  "body" text NOT NULL,
  "confirm_label" text NOT NULL,
  "cancel_label" text NOT NULL,
  "samples" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error_code" text,
  "last_provider_reference" text,
  "template_id" uuid REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL,
  "updated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_template_drafts_key_key" UNIQUE ("key"),
  CONSTRAINT "whatsapp_template_drafts_provider_identity_key" UNIQUE ("meta_template_name", "meta_language_code"),
  CONSTRAINT "whatsapp_template_drafts_purpose_check" CHECK ("purpose" IN ('cod_confirmation')),
  CONSTRAINT "whatsapp_template_drafts_language_check" CHECK ("language" IN ('ar', 'en')),
  CONSTRAINT "whatsapp_template_drafts_version_check" CHECK ("version" >= 1),
  CONSTRAINT "whatsapp_template_drafts_parameter_format_check" CHECK ("parameter_format" IN ('named', 'positional')),
  CONSTRAINT "whatsapp_template_drafts_state_check" CHECK ("state" IN ('draft', 'submitting', 'submit_unknown', 'submitted')),
  CONSTRAINT "whatsapp_template_drafts_submitted_has_template_check" CHECK ("state" <> 'submitted' OR "template_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_template_drafts_template" ON "whatsapp_template_drafts" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "whatsapp_template_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_template_drafts" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp template drafts" ON "whatsapp_template_drafts";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp template drafts" ON "whatsapp_template_drafts" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_template_edits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "whatsapp_templates"("id") ON DELETE CASCADE,
  "requested_by" uuid NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "outcome" text DEFAULT 'unknown' NOT NULL,
  "provider_reference" text,
  CONSTRAINT "whatsapp_template_edits_outcome_check" CHECK ("outcome" IN ('applied', 'refused', 'unknown'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_template_edits_template_requested" ON "whatsapp_template_edits" USING btree ("template_id", "requested_at");--> statement-breakpoint
ALTER TABLE "whatsapp_template_edits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_template_edits" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp template edits" ON "whatsapp_template_edits";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp template edits" ON "whatsapp_template_edits" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
