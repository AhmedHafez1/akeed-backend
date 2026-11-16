-- Starter is once per store and once per merchant WhatsApp number.
--
-- phone_hash is HMAC-SHA256 (hex) of the digits of the merchant's WhatsApp
-- number under FREE_PLAN_CLAIM_PHONE_KEY. It is never the number itself: the
-- claim row outlives shop/redact (0041) and must hold no personal data. NULL
-- for claims made before this column or whose store had no number.
--
-- The unique index spans platforms, so one number gets one free plan.
--
-- Rollback: DROP INDEX billing_free_plan_claims_phone_hash_key; then
-- ALTER TABLE billing_free_plan_claims DROP COLUMN phone_hash.
ALTER TABLE "billing_free_plan_claims" ADD COLUMN IF NOT EXISTS "phone_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_free_plan_claims_phone_hash_key" ON "billing_free_plan_claims" USING btree ("phone_hash") WHERE "phone_hash" IS NOT NULL;
