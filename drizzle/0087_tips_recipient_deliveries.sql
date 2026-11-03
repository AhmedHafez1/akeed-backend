-- Keep each account's previous delivery when staff show an update again.
ALTER TABLE "tips_campaign_recipients"
  ADD COLUMN IF NOT EXISTS "removed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "delivery_generation" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "delivery_started_at" timestamptz;--> statement-breakpoint
UPDATE "tips_campaign_recipients" r
SET "delivery_started_at" = COALESCE(c."published_at", r."created_at")
FROM "tips_campaigns" c
WHERE c."id" = r."campaign_id" AND r."delivery_started_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tips_campaign_recipients"
  ALTER COLUMN "delivery_started_at" SET DEFAULT now(),
  ALTER COLUMN "delivery_started_at" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tips_campaign_recipients" ADD CONSTRAINT "tips_recipient_generation_check" CHECK ("delivery_generation" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tips_campaign_recipients_org_open";--> statement-breakpoint
CREATE INDEX "idx_tips_campaign_recipients_org_open" ON "tips_campaign_recipients"
  ("org_id", "delivery_started_at" DESC, "campaign_id")
  WHERE "dismissed_at" IS NULL AND "removed_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tips_campaign_delivery_history" (
  "campaign_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "delivery_generation" integer NOT NULL CHECK ("delivery_generation" >= 1),
  "delivery_started_at" timestamptz NOT NULL,
  "first_viewed_at" timestamptz,
  "first_clicked_at" timestamptz,
  "dismissed_at" timestamptz,
  "removed_at" timestamptz,
  "archived_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("campaign_id", "org_id", "delivery_generation"),
  FOREIGN KEY ("campaign_id", "org_id") REFERENCES "tips_campaign_recipients" ("campaign_id", "org_id") ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE "tips_campaign_delivery_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "tips_campaign_delivery_history" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tips_campaign_delivery_history" TO service_role;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages tips delivery history" ON "tips_campaign_delivery_history";--> statement-breakpoint
CREATE POLICY "Service role manages tips delivery history" ON "tips_campaign_delivery_history"
  AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
