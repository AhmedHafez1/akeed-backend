ALTER TABLE verification_message_dispatches
  ADD COLUMN IF NOT EXISTS sender_connection_generation bigint,
  ADD COLUMN IF NOT EXISTS sender_recovery_state text,
  ADD COLUMN IF NOT EXISTS sender_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sender_recovery_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sender_recovery_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS sender_recovery_template jsonb,
  ADD COLUMN IF NOT EXISTS fallback_for_dispatch_id uuid,
  ADD COLUMN IF NOT EXISTS sender_automation_pending boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE provider_message_receipts ADD COLUMN IF NOT EXISTS sender_receipt_context jsonb;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sender_recovery_state_check' AND conrelid = 'verification_message_dispatches'::regclass) THEN ALTER TABLE verification_message_dispatches ADD CONSTRAINT sender_recovery_state_check
  CHECK (sender_recovery_state IS NULL OR sender_recovery_state IN ('retry', 'fallback', 'complete', 'canceled')); END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sender_retry_budget_check' AND conrelid = 'verification_message_dispatches'::regclass) THEN ALTER TABLE verification_message_dispatches ADD CONSTRAINT sender_retry_budget_check CHECK (sender_retry_count BETWEEN 0 AND 2); END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_fallback_source_fkey' AND conrelid = 'verification_message_dispatches'::regclass) THEN ALTER TABLE verification_message_dispatches ADD CONSTRAINT dispatch_fallback_source_fkey
  FOREIGN KEY (fallback_for_dispatch_id, org_id) REFERENCES verification_message_dispatches(id, org_id); END IF; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_one_sender_fallback ON verification_message_dispatches(fallback_for_dispatch_id) WHERE fallback_for_dispatch_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispatch_sender_recovery_due ON verification_message_dispatches(sender_recovery_due_at) WHERE sender_recovery_state IN ('retry', 'fallback') OR sender_automation_pending;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS verification_sender_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 0 AND 2),
  claim_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('authorized', 'in_flight', 'accepted', 'failed', 'unknown')),
  connection_id uuid NOT NULL,
  signup_generation bigint NOT NULL,
  phone_number_id text NOT NULL,
  waba_id text NOT NULL,
  provider_message_id text UNIQUE,
  lease_until timestamptz NOT NULL,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  failure jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(dispatch_id, attempt_number),
  FOREIGN KEY (dispatch_id, org_id) REFERENCES verification_message_dispatches(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id, org_id) REFERENCES whatsapp_connections(id, org_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sender_attempt_expired ON verification_sender_attempts(lease_until) WHERE state IN ('authorized', 'in_flight');
--> statement-breakpoint
ALTER TABLE verification_sender_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON verification_sender_attempts FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS health_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_claim_token uuid,
  ADD COLUMN IF NOT EXISTS health_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS next_health_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS whatsapp_connection_health_due ON whatsapp_connections(next_health_at) WHERE state IN ('verifying', 'active');

--> statement-breakpoint
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
