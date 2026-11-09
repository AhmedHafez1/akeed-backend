-- Request a change: the merchant's updated confirmation.
--
-- A merchant who contacted the customer can send an updated confirmation
-- built from the order's current details. Until the provider accepts it, the
-- request stays open and the no-reply automation stays stopped.
--
-- "verification_change_requests" gains the state of that send:
--   * "reconfirmation_state": NULL (none asked), 'requested' (queued),
--     'scheduled' (waiting for quiet hours to end), 'sending', or 'failed'
--     (with "last_reconfirmation_error"). A request asked again while one is
--     queued, scheduled or sending is the same request.
--   * "reconfirmation_attempt": how many times the merchant asked, so a queued
--     job of an earlier attempt does nothing.
--   * "reconfirmation_requested_at", "reconfirmation_requested_by",
--     "reconfirmation_scheduled_for": who asked, when, and when it will go.
--   * "reconfirmation_dispatch_id": the confirmation message carrying it. Its
--     acceptance closes the request in the same transaction.
--
-- "verification_change_request_events" may now record 'reconfirmation_requested'
-- and 'reconfirmation_scheduled'.
--
-- "guard_dispatch_generation" keeps every rule for a retry within a cycle (a
-- new generation only after a confirmed, released failure) and admits the
-- first message of a later cycle as a new message: an updated confirmation
-- for the next cycle, or the acknowledgment of the current one. It is
-- restated whole, as the last migration to define it (0089) left it, plus
-- that one branch.
--
-- "dispatch_one_active_generation" becomes one live message per verification,
-- kind and confirmation cycle: the updated confirmation of a later cycle is a
-- new message while the earlier cycle's stays accepted, and so is a later
-- cycle's acknowledgment.
--
-- Rollback: deploy the previous release and run:
--   DROP INDEX IF EXISTS "dispatch_one_active_generation";
--   CREATE UNIQUE INDEX "dispatch_one_active_generation" ON "verification_message_dispatches" ("verification_id", "kind") WHERE state IN ('ready', 'sending', 'outcome_unknown') OR (state = 'accepted' AND failed_at IS NULL);
--   (fails while a later cycle exists; resolve those orders first)
--   ALTER TABLE "verification_change_requests" DROP COLUMN IF EXISTS "reconfirmation_state", DROP COLUMN IF EXISTS "reconfirmation_attempt", DROP COLUMN IF EXISTS "reconfirmation_requested_at", DROP COLUMN IF EXISTS "reconfirmation_requested_by", DROP COLUMN IF EXISTS "reconfirmation_scheduled_for", DROP COLUMN IF EXISTS "reconfirmation_dispatch_id";

ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_state" text;--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD COLUMN IF NOT EXISTS "reconfirmation_dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_change_requests" DROP CONSTRAINT IF EXISTS "verification_change_requests_reconfirmation_state_check";--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD CONSTRAINT "verification_change_requests_reconfirmation_state_check" CHECK ("reconfirmation_state" IS NULL OR "reconfirmation_state" IN ('requested', 'scheduled', 'sending', 'failed'));--> statement-breakpoint
ALTER TABLE "verification_change_requests" DROP CONSTRAINT IF EXISTS "verification_change_requests_reconfirmation_attempt_check";--> statement-breakpoint
ALTER TABLE "verification_change_requests" ADD CONSTRAINT "verification_change_requests_reconfirmation_attempt_check" CHECK ("reconfirmation_attempt" >= 0);--> statement-breakpoint

ALTER TABLE "verification_change_request_events" DROP CONSTRAINT IF EXISTS "verification_change_request_events_event_check";--> statement-breakpoint
ALTER TABLE "verification_change_request_events" ADD CONSTRAINT "verification_change_request_events_event_check" CHECK ("event" IN ('opened', 'repeat_ignored', 'resolved', 'reconfirmation_failed', 'reconfirmation_requested', 'reconfirmation_scheduled'));--> statement-breakpoint

DROP INDEX IF EXISTS "dispatch_one_active_generation";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_one_active_generation" ON "verification_message_dispatches" ("verification_id", "kind", "confirmation_cycle") WHERE state IN ('ready', 'sending', 'outcome_unknown') OR (state = 'accepted' AND failed_at IS NULL);--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_dispatch_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preceding verification_message_dispatches%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.org_id, NEW.integration_id, NEW.verification_id, NEW.kind, NEW.generation, NEW.dispatch_key)
      IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.integration_id, OLD.verification_id, OLD.kind, OLD.generation, OLD.dispatch_key) THEN
      RAISE EXCEPTION 'Dispatch identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.generation > 1 THEN
    PERFORM 1 FROM verifications WHERE id = NEW.verification_id AND org_id = NEW.org_id FOR UPDATE;
    SELECT * INTO preceding FROM verification_message_dispatches WHERE verification_id = NEW.verification_id AND kind = NEW.kind AND generation = NEW.generation - 1 AND org_id = NEW.org_id FOR UPDATE;
    -- The first message of a later confirmation cycle (an updated confirmation,
    -- or that cycle's acknowledgment) is a new message, not a retry of the
    -- previous cycle's: it follows that cycle's accepted message and is charged
    -- as its own. Only the current cycle or the next one, and only once.
    IF FOUND AND NEW.confirmation_cycle > preceding.confirmation_cycle THEN
      IF NOT EXISTS (SELECT 1 FROM verifications v WHERE v.id = NEW.verification_id AND v.org_id = NEW.org_id AND NEW.confirmation_cycle BETWEEN v.confirmation_cycle AND v.confirmation_cycle + 1) THEN
        RAISE EXCEPTION 'Cycle message must belong to the current or next cycle' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM verification_message_dispatches d WHERE d.verification_id = NEW.verification_id AND d.kind = NEW.kind AND d.confirmation_cycle >= NEW.confirmation_cycle) THEN
        RAISE EXCEPTION 'Cycle message already exists' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT FOUND OR NOT (preceding.state = 'rejected' OR (preceding.state = 'accepted' AND preceding.failed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'New generation requires confirmed preceding failure' USING ERRCODE = '23514';
    END IF;
    IF NEW.accounting_mode = 'periodic_plan' AND (NEW.fallback_for_dispatch_id IS DISTINCT FROM preceding.id OR preceding.sender_kind <> 'merchant_own' OR preceding.usage_reserved) THEN
      RAISE EXCEPTION 'Periodic generations require settled merchant sender fallback' USING ERRCODE = '23514';
    END IF;
    IF NEW.fallback_for_dispatch_id IS NOT NULL AND (NEW.fallback_for_dispatch_id IS DISTINCT FROM preceding.id OR NEW.sender_kind <> 'akeed_system' OR preceding.sender_kind <> 'merchant_own' OR preceding.sender_recovery_state <> 'fallback' OR preceding.usage_reserved) THEN
      RAISE EXCEPTION 'Invalid sender fallback generation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM credit_reservations WHERE dispatch_id = preceding.id AND status <> 'released') THEN
      RAISE EXCEPTION 'Preceding credit reservation must be released' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM credit_ledger_entries consumed WHERE consumed.dispatch_id = preceding.id AND consumed.type = 'consumption' AND NOT EXISTS (SELECT 1 FROM credit_ledger_entries reversal WHERE reversal.source_ledger_entry_id = consumed.id AND reversal.type = 'failure_reversal')) THEN
      RAISE EXCEPTION 'Preceding credit consumption must be reversed' USING ERRCODE = '23514';
    END IF;
    IF preceding.accounting_mode = 'prepaid_credit' AND preceding.billing_pool = 'credits'
      AND preceding.billing_cost = 1 AND preceding.billing_refunded_at IS NULL THEN
      RAISE EXCEPTION 'Preceding own-number charge must be refunded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
