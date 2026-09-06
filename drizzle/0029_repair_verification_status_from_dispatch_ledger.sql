-- Repair verifications whose status lags behind the dispatch ledger.
--
-- `verifications.status` is a projection of `verification_message_dispatches`:
-- the ledger is the source of truth for "did a message reach the provider".
-- Three code paths used to skip that projection while still marking the ledger
-- accepted, and migration 0028 backfilled `accepted` dispatches for every
-- legacy row without touching the status at all. The result is rows that read
-- `pending` -- "we have not contacted this customer yet" -- for orders whose
-- customer already received, opened, and sometimes answered the message.
--
-- Those orders are never re-sent, so no application code path can reach them;
-- the KPI cards and the status filter read the column directly, so they are
-- wrong too. This restores the invariant for existing rows. The write paths are
-- fixed separately so the drift cannot recur.
--
-- Idempotent: only rows still claiming `pending`/NULL are touched, and every
-- timestamp is COALESCEd so a re-run cannot overwrite a real value.

DO $$
DECLARE
  drifted_count bigint;
BEGIN
  SELECT count(*) INTO drifted_count
  FROM "public"."verifications" AS verification
  WHERE ("verification"."status" IS NULL OR "verification"."status" = 'pending')
    AND EXISTS (
      SELECT 1
      FROM "public"."verification_message_dispatches" AS dispatch
      WHERE dispatch."verification_id" = verification."id"
        AND dispatch."state" = 'accepted'
        AND dispatch."provider_message_id" IS NOT NULL
    );
  RAISE NOTICE 'verification status repair preflight: drifted_rows=%', drifted_count;
END $$;--> statement-breakpoint

WITH ledger AS (
  SELECT
    dispatch."verification_id" AS verification_id,
    -- Oldest acceptance is the true first send; later rows are follow-ups.
    min(dispatch."accepted_at")  AS accepted_at,
    max(dispatch."delivered_at") AS delivered_at,
    max(dispatch."read_at")      AS read_at,
    -- Any accepted dispatch still carrying a provider id proves a real send.
    max(dispatch."provider_message_id") FILTER (
      WHERE dispatch."provider_message_id" IS NOT NULL
    ) AS provider_message_id
  FROM "public"."verification_message_dispatches" AS dispatch
  WHERE dispatch."state" = 'accepted'
    AND dispatch."provider_message_id" IS NOT NULL
  GROUP BY dispatch."verification_id"
)
UPDATE "public"."verifications" AS verification
SET
  -- Advance to the furthest state the ledger can actually prove, and no further.
  "status" = CASE
    WHEN ledger.read_at      IS NOT NULL THEN 'read'::verification_status
    WHEN ledger.delivered_at IS NOT NULL THEN 'delivered'::verification_status
    ELSE 'sent'::verification_status
  END,
  "last_sent_at"   = COALESCE(verification."last_sent_at", ledger.accepted_at),
  "delivered_at"   = COALESCE(verification."delivered_at", ledger.delivered_at),
  "read_at"        = COALESCE(verification."read_at", ledger.read_at),
  -- The webhook path resolves delivery/read receipts by this id. A row that
  -- never got its projection never got the id either, which is why later
  -- receipts were dropped on the floor.
  "wa_message_id"  = COALESCE(verification."wa_message_id", ledger.provider_message_id),
  "updated_at"     = now()
FROM ledger
WHERE ledger.verification_id = verification."id"
  -- A customer's own reply outranks anything the ledger knows; never touch it.
  AND (verification."status" IS NULL OR verification."status" = 'pending');--> statement-breakpoint

-- With every NULL resolved above, the column can carry its own guarantee. This
-- also retires the `?? 'pending'` fallback in the read path, which used to
-- present "we do not know" to merchants as a confident "not sent yet".
ALTER TABLE "public"."verifications"
  ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint

UPDATE "public"."verifications" SET "status" = 'pending' WHERE "status" IS NULL;--> statement-breakpoint

ALTER TABLE "public"."verifications"
  ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint

DO $$
DECLARE
  remaining_drift bigint;
  repaired_sent bigint;
BEGIN
  SELECT count(*) INTO remaining_drift
  FROM "public"."verifications" AS verification
  WHERE verification."status" = 'pending'
    AND EXISTS (
      SELECT 1
      FROM "public"."verification_message_dispatches" AS dispatch
      WHERE dispatch."verification_id" = verification."id"
        AND dispatch."state" = 'accepted'
        AND dispatch."provider_message_id" IS NOT NULL
    );
  SELECT count(*) INTO repaired_sent
  FROM "public"."verifications"
  WHERE "status" IN ('sent', 'delivered', 'read');
  RAISE NOTICE 'verification status repair: remaining_drift=%, rows_at_or_past_sent=%',
    remaining_drift, repaired_sent;
END $$;
