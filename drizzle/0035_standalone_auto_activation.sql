-- Standalone accounts no longer wait for staff approval: a verified signup opens
-- an active credit account with its one-time launch grant. This migration
-- activates every account still pending, then removes the approval columns and
-- the `pending_approval` status.
--
-- Conflicting organizations are escalated, never converted: if any pending
-- account belongs to an organization with a native commerce source, native
-- billing history, or other than exactly one owner, the migration aborts and
-- names them. Resolve those by hand, then rerun.
DO $$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(account.org_id::text, ', ' ORDER BY account.org_id)
  INTO conflicts
  FROM "public"."credit_accounts" account
  WHERE account.status::text = 'pending_approval'
    AND (
      EXISTS (SELECT 1 FROM "public"."integrations" source WHERE source.org_id = account.org_id AND source.platform_type <> 'standalone')
      OR EXISTS (SELECT 1 FROM "public"."billing_free_plan_claims" claim WHERE claim.org_id = account.org_id AND claim.platform_type <> 'standalone')
      OR (SELECT count(*) FROM "public"."memberships" member WHERE member.org_id = account.org_id AND member.role = 'owner') <> 1
    );
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Standalone auto-activation blocked by conflicting pending organizations: %', conflicts
      USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint

-- The launch grant is the 30-credit default (`STANDALONE_FREE_GRANT`). The
-- owner is recorded as the actor, exactly as a new signup is.
INSERT INTO "public"."credit_ledger_entries" (org_id, type, quantity, idempotency_key, actor_id, reason, posted_balance_before, posted_balance_after)
SELECT
  account.org_id,
  'free_grant',
  30,
  'standalone-free-grant:' || account.org_id::text || ':v1',
  (SELECT member.user_id FROM "public"."memberships" member WHERE member.org_id = account.org_id AND member.role = 'owner'),
  'auto_activation_backfill',
  account.posted_balance,
  account.posted_balance + 30
FROM "public"."credit_accounts" account
WHERE account.status::text = 'pending_approval'
  AND NOT EXISTS (SELECT 1 FROM "public"."credit_ledger_entries" entry WHERE entry.org_id = account.org_id AND entry.type = 'free_grant');--> statement-breakpoint

UPDATE "public"."credit_accounts" account
SET
  status = 'active',
  posted_balance = account.posted_balance + CASE
    WHEN EXISTS (SELECT 1 FROM "public"."credit_ledger_entries" entry WHERE entry.org_id = account.org_id AND entry.type = 'free_grant' AND entry.reason = 'auto_activation_backfill')
    THEN 30 ELSE 0 END,
  version = account.version + 1,
  updated_at = now()
WHERE account.status::text = 'pending_approval';--> statement-breakpoint

ALTER TABLE "public"."credit_accounts" DROP CONSTRAINT IF EXISTS credit_account_approval_check;--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" DROP COLUMN IF EXISTS approved_by;--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" DROP COLUMN IF EXISTS approved_at;--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" DROP COLUMN IF EXISTS approval_reason;--> statement-breakpoint

ALTER TYPE "public"."credit_account_status" RENAME TO credit_account_status_legacy;--> statement-breakpoint
CREATE TYPE "public"."credit_account_status" AS ENUM ('active', 'suspended');--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" ALTER COLUMN status DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" ALTER COLUMN status TYPE "public"."credit_account_status" USING status::text::"public"."credit_account_status";--> statement-breakpoint
ALTER TABLE "public"."credit_accounts" ALTER COLUMN status SET DEFAULT 'active';--> statement-breakpoint
DROP TYPE "public"."credit_account_status_legacy";
