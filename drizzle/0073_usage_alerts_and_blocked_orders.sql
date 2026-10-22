-- Usage alerts and orders blocked by sending capacity.
--
-- "verification_status" gains 'blocked': the order was accepted, but the
-- confirmation was not sent because the plan allowance or the prepaid credits
-- ran out. "metadata"->>'reason' says which ('plan_limit_reached',
-- 'INSUFFICIENT_CREDITS', 'CREDIT_DEBT_OUTSTANDING'). No usage or credit is
-- taken for it, and no reminder or no-reply escalation is scheduled. Recovery
-- sends it once capacity returns, or moves it to 'failed' with reason
-- 'capacity_block_stale' when it is older than BLOCKED_ORDER_MAX_AGE_HOURS.
--
-- ALTER TYPE ... ADD VALUE cannot be undone in Postgres, and the new value
-- cannot be used in the transaction that adds it. The migrator applies pending
-- migrations in one transaction, so nothing here names 'blocked' as an enum
-- literal: the index that finds blocked rows leads with the status column
-- instead of a partial predicate, and existing
-- 'failed' rows with a capacity reason are not rewritten. Recovery picks up
-- the recent ones as they are.
--
-- "integrations"."notification_email" is the shop's email read from Shopify,
-- where usage alerts go for an embedded store. NULL until the shop profile is
-- read again.
--
-- "usage_alerts" records each alert once:
--   * 'plan_usage' at levels '80', '95', '100', once per billing period
--     ("cycle_key" is the period start, 'one_time:<start>' for Starter);
--   * 'credit_balance' at levels 'low', 'depleted', once per incident: the
--     open row ("resolved_at" IS NULL) blocks a repeat until the balance
--     recovers and the row is resolved.
--
-- Rollback: deploy the previous release and run:
--   DROP TABLE IF EXISTS "usage_alerts";
--   DROP INDEX IF EXISTS "idx_verifications_status_org_created";
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "notification_email";
--   UPDATE "verifications" SET "status" = 'failed' WHERE "status"::text = 'blocked';
-- The enum value stays.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'blocked'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'verification_status')
  ) THEN
    ALTER TYPE "public"."verification_status" ADD VALUE 'blocked' AFTER 'no_whatsapp';
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_verifications_status_org_created" ON "verifications" USING btree ("status", "org_id", "created_at");--> statement-breakpoint

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "notification_email" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "usage_alerts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "level" text NOT NULL,
  "cycle_key" text NOT NULL,
  "email_status" text DEFAULT 'pending' NOT NULL,
  "email_error" text,
  "sent_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "usage_alerts_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "usage_alerts_kind_level_check" CHECK (("kind" = 'plan_usage' AND "level" IN ('80', '95', '100')) OR ("kind" = 'credit_balance' AND "level" IN ('low', 'depleted'))),
  CONSTRAINT "usage_alerts_email_status_check" CHECK ("email_status" IN ('pending', 'sent', 'skipped', 'failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_alerts_plan_cycle_idx" ON "usage_alerts" USING btree ("integration_id", "kind", "level", "cycle_key") WHERE "kind" = 'plan_usage';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_alerts_open_credit_idx" ON "usage_alerts" USING btree ("org_id", "kind", "level") WHERE "kind" = 'credit_balance' AND "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_alerts_org" ON "usage_alerts" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "usage_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "usage_alerts" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages usage alerts" ON "usage_alerts";--> statement-breakpoint
CREATE POLICY "Service role manages usage alerts" ON "usage_alerts" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
