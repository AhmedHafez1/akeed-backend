-- One row per organization that held credits before merchants saw 1 credit as
-- EGP 1. The row is what makes it eligible for the one-time notice and email,
-- so an organization created later never gets either.
--
-- "email_claimed_at" is set before sending and never cleared, so an email goes
-- out at most once even if a sweep crashes after the provider accepted it.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE "credit_model_notices";
CREATE TABLE IF NOT EXISTS "credit_model_notices" (
  "org_id" uuid PRIMARY KEY NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "dismissed_at" timestamptz,
  "email_claimed_at" timestamptz,
  "email_status" text,
  "email_reason" text,
  CONSTRAINT "credit_model_notices_email_status_check" CHECK ("email_status" IN ('sent', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "credit_model_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "credit_model_notices" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_model_notices_unclaimed" ON "credit_model_notices" ("org_id") WHERE "email_claimed_at" IS NULL;--> statement-breakpoint
INSERT INTO "credit_model_notices" ("org_id")
SELECT "org_id" FROM "credit_accounts"
ON CONFLICT ("org_id") DO NOTHING;
