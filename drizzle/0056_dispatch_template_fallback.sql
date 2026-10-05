-- Why a send did not carry the store's stored template choice (US-08-04).
--
-- "template_fallback_reason" is why the language default was sent instead of
-- the store's stored choice: 'key_unknown', 'key_inactive', 'wrong_language'
-- or, under the send guardrail, 'not_approved'. "template_skipped_key" is the
-- stored registry key that was passed over. Both are written by the claim,
-- together with the template identity columns of 0053, and are NULL when the
-- choice was sent or the store had none. Older rows stay NULL; nothing is
-- backfilled. No CHECK: the reason is a neutral code owned by the selector.
--
-- Additive and safe to replay.
--
-- Rollback: deploy the previous release (it does not read the columns), then
-- optionally:
--   ALTER TABLE "verification_message_dispatches" DROP COLUMN IF EXISTS "template_fallback_reason",
--     DROP COLUMN IF EXISTS "template_skipped_key";
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "template_skipped_key" text;
