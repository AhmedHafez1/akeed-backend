-- Restore the send facts on verifications whose dispatch never recorded its
-- acceptance.
--
-- `markAccepted` is the only writer of `last_sent_at`, `attempts` and
-- `wa_message_id`. Anything that interrupted a send between the claim and that
-- write left the ledger stuck at `sending`/`outcome_unknown` and the
-- verification with no trace that a message ever went out -- even though the
-- customer received it and, in these rows, replied.
--
-- The dashboard funnel counts `sent` as count(last_sent_at), so those rows
-- reported sent = 0, delivered = 0, read = 0 and a reply rate divided by zero.
-- This repairs the columns for rows where the send is beyond doubt; the write
-- path is fixed separately so the drift cannot recur.
--
-- Scope is deliberately narrow: only verifications the customer has already
-- answered (`confirmed`/`canceled`) prove a message was delivered. `status` is
-- never touched -- the customer's reply is the final word -- and
-- `wa_message_id` stays NULL because that id is genuinely lost and inventing
-- one would misdirect the delivery and read webhooks.
--
-- Idempotent: only rows still missing `last_sent_at` are touched, and
-- `attempts` is raised with GREATEST so a re-run cannot lower a real count.
--
-- The reported count is read back off the UPDATE with GET DIAGNOSTICS rather
-- than measured by a second query, so what is logged is exactly what was
-- written.

DO $$
DECLARE
  repaired_count bigint;
BEGIN
  UPDATE "public"."verifications" AS verification
  SET
    "last_sent_at" = "dispatch"."updated_at",
    "attempts" = GREATEST(COALESCE("verification"."attempts", 0), "dispatch"."attempt_count"),
    "updated_at" = now()
  FROM "public"."verification_message_dispatches" AS dispatch
  WHERE "dispatch"."verification_id" = "verification"."id"
    AND "dispatch"."kind" = 'initial'
    AND "dispatch"."state" IN ('sending', 'outcome_unknown')
    AND "verification"."last_sent_at" IS NULL
    AND "verification"."status" IN ('confirmed', 'canceled');

  GET DIAGNOSTICS repaired_count = ROW_COUNT;
  RAISE NOTICE 'Repaired send facts on % stranded verification(s)', repaired_count;
END $$;
