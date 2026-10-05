-- Which template each send carried (US-08-02).
--
-- A dispatch recorded "template_name" as 'cod_verification' and
-- "language_code" as the store preference, usually 'auto', so nothing said
-- which of the variants a customer received. Five nullable columns now hold
-- it: the variant key (for example 'ar.egyptian'), the purpose of the send
-- ('initial', 'reminder' or 'test'), the provider's template name and language
-- code as sent, and the language the send resolved to ('ar' or 'en'). The
-- claim writes them and the acceptance confirms them; from this release
-- "template_name" and "language_code" on a new dispatch hold the provider's
-- name and code as well.
--
-- Rows written before this migration keep all five columns NULL and are
-- reported as "not recorded". Nothing here updates a row: a past send's
-- template cannot be known, so it is not guessed.
--
-- "verifications"."template_name" and "language_code" lose their defaults
-- ('cod_verification' and 'ar'). No code ever wrote them, so every row read
-- 'ar' even for an English message. They are now written by the acceptance of
-- a send, with "wa_message_id", and stay NULL until then. Existing rows keep
-- the values they have.
--
-- The index serves the staff template metrics, which read dispatches by
-- acceptance time. It is built inside the migration transaction and so blocks
-- writes to the ledger while it builds; on a large ledger create it first by
-- hand with CREATE INDEX CONCURRENTLY under the same name, and this statement
-- becomes a no-op.
--
-- Rollback: deploy the previous release first (it does not read or write the
-- new columns). The columns can then stay. To remove them: drop the index, the
-- two checks and the five columns, and restore the defaults with
-- ALTER TABLE "verifications" ALTER COLUMN "template_name" SET DEFAULT 'cod_verification'
-- and ALTER COLUMN "language_code" SET DEFAULT 'ar'. No existing ledger or
-- verification data is lost either way.
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_variant_key" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_purpose" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "meta_template_name" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "meta_language_code" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "resolved_language" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_template_purpose_check";--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD CONSTRAINT "dispatch_template_purpose_check" CHECK ("template_purpose" IS NULL OR "template_purpose" IN ('initial', 'reminder', 'test'));--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_resolved_language_check";--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD CONSTRAINT "dispatch_resolved_language_check" CHECK ("resolved_language" IS NULL OR "resolved_language" IN ('ar', 'en'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_message_dispatches_accepted_at" ON "verification_message_dispatches" USING btree ("accepted_at") WHERE "accepted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "template_name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "language_code" DROP DEFAULT;
