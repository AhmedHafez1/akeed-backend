-- Tips & updates campaigns gain two types: `change` (Akeed changed how
-- something works) and `note` (information only), beside `tip` and `update`
-- (a new feature).
--
-- Rollback: retype any `change` or `note` campaign, then restore the
-- two-value check.
ALTER TABLE "tips_campaigns" DROP CONSTRAINT IF EXISTS "tips_campaigns_type_check";
--> statement-breakpoint
ALTER TABLE "tips_campaigns" ADD CONSTRAINT "tips_campaigns_type_check" CHECK ("type" IN ('tip', 'update', 'change', 'note'));
