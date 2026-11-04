-- Own-number billing. An own-number send costs half a stored credit on
-- prepaid and draws a separate pool on a plan. No stored balance changes.
ALTER TABLE "credit_accounts"
  ADD COLUMN IF NOT EXISTS "spare_credit" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "credit_accounts"
  DROP CONSTRAINT IF EXISTS "credit_accounts_spare_credit_check";
--> statement-breakpoint
ALTER TABLE "credit_accounts"
  ADD CONSTRAINT "credit_accounts_spare_credit_check" CHECK (spare_credit IN (0, 1));
--> statement-breakpoint
ALTER TYPE "credit_ledger_type" ADD VALUE IF NOT EXISTS 'own_number_pack';
--> statement-breakpoint
ALTER TYPE "credit_ledger_type" ADD VALUE IF NOT EXISTS 'own_number_pack_reversal';
--> statement-breakpoint
-- A value added above cannot be used in this transaction, so the checks
-- compare the type as text.
ALTER TABLE "credit_ledger_entries"
  DROP CONSTRAINT IF EXISTS "credit_ledger_sign_check";
--> statement-breakpoint
ALTER TABLE "credit_ledger_entries"
  ADD CONSTRAINT "credit_ledger_sign_check" CHECK (
    (type::text IN ('free_grant', 'purchase', 'failure_reversal', 'chargeback_reinstatement') AND quantity > 0)
    OR (type::text IN ('consumption', 'refund_reversal', 'chargeback_reversal') AND quantity < 0)
    OR type::text = 'staff_adjustment'
    OR (type::text = 'own_number_pack' AND quantity = -1)
    OR (type::text = 'own_number_pack_reversal' AND quantity = 1)
  );
--> statement-breakpoint
ALTER TABLE "credit_ledger_entries"
  DROP CONSTRAINT IF EXISTS "credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "credit_ledger_entries"
  ADD CONSTRAINT "credit_ledger_source_check" CHECK (
    (type::text IN ('free_grant', 'staff_adjustment') AND reservation_id IS NULL AND dispatch_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL AND actor_id IS NOT NULL)
    OR (type::text = 'purchase' AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type::text = 'consumption' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type::text = 'failure_reversal' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NULL)
    OR (type::text IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement') AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NOT NULL AND length(trim(source_reference)) > 0)
    -- Own-number charges have no reservation. A reversal names the dispatch
    -- whose refund turned two spares back into a stored credit.
    OR (type::text IN ('own_number_pack', 'own_number_pack_reversal') AND dispatch_id IS NOT NULL AND reservation_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
  );
--> statement-breakpoint
-- At most one pack and one pack reversal per dispatch. The source check above
-- allows a dispatch without a reservation only on those two types, and an
-- index predicate cannot cast the type, so this is the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_own_number_dispatch_key"
  ON "credit_ledger_entries" (dispatch_id, type)
  WHERE dispatch_id IS NOT NULL AND reservation_id IS NULL;
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  ADD COLUMN IF NOT EXISTS "billing_pool" text,
  ADD COLUMN IF NOT EXISTS "billing_cost" integer,
  ADD COLUMN IF NOT EXISTS "billing_refunded_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  DROP CONSTRAINT IF EXISTS "dispatch_billing_pool_check";
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  ADD CONSTRAINT "dispatch_billing_pool_check" CHECK (billing_pool IS NULL OR billing_pool IN ('credits', 'akeed', 'own_number'));
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  DROP CONSTRAINT IF EXISTS "dispatch_billing_cost_check";
--> statement-breakpoint
-- Prepaid costs are displayed credits: 2 is a reserved stored credit, 1 an
-- own-number charge, 0 a fallback with nothing left. Plan costs are messages.
ALTER TABLE "verification_message_dispatches"
  ADD CONSTRAINT "dispatch_billing_cost_check" CHECK (
    (billing_pool IS NULL AND billing_cost IS NULL)
    OR (billing_pool = 'credits' AND billing_cost IN (0, 1, 2))
    OR (billing_pool IN ('akeed', 'own_number') AND billing_cost >= 0)
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_dispatch_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A plan-billed row whose usage was released may be claimed again, and that
  -- claim records its own charge. Anything still charged keeps its record.
  IF (OLD.billing_pool IS NOT NULL OR OLD.billing_cost IS NOT NULL)
    AND NOT (OLD.accounting_mode = 'periodic_plan' AND NOT OLD.usage_reserved AND NEW.usage_reserved)
    AND ROW(NEW.billing_pool, NEW.billing_cost) IS DISTINCT FROM ROW(OLD.billing_pool, OLD.billing_cost) THEN
    RAISE EXCEPTION 'Dispatch billing is immutable after claim' USING ERRCODE = '23514';
  END IF;
  IF OLD.billing_refunded_at IS NOT NULL AND NEW.billing_refunded_at IS DISTINCT FROM OLD.billing_refunded_at THEN
    RAISE EXCEPTION 'Dispatch billing refund is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "dispatch_billing_immutable" ON "verification_message_dispatches";
--> statement-breakpoint
CREATE TRIGGER "dispatch_billing_immutable" BEFORE UPDATE ON "verification_message_dispatches"
  FOR EACH ROW EXECUTE FUNCTION protect_dispatch_billing();
--> statement-breakpoint
-- The generation guard from 0032, plus one rule: an own-number charge on the
-- previous attempt must be returned before a new attempt can be charged.
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
    IF NOT FOUND OR NOT (preceding.state = 'rejected' OR (preceding.state = 'accepted' AND preceding.failed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'New generation requires confirmed preceding failure' USING ERRCODE = '23514';
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
--> statement-breakpoint
ALTER TABLE "integration_monthly_usage"
  ADD COLUMN IF NOT EXISTS "own_number_consumed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "integration_monthly_usage"
  DROP CONSTRAINT IF EXISTS "integration_monthly_usage_own_number_consumed_check";
--> statement-breakpoint
ALTER TABLE "integration_monthly_usage"
  ADD CONSTRAINT "integration_monthly_usage_own_number_consumed_check" CHECK (own_number_consumed >= 0);
