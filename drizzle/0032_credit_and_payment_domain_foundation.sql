DO $$
DECLARE
  source_count bigint;
  account_count bigint;
  dispatch_count bigint;
  anomaly_count bigint;
BEGIN
  SELECT count(*) INTO source_count FROM "public"."integrations" WHERE platform_type = 'standalone';
  SELECT count(DISTINCT org_id) INTO account_count FROM "public"."integrations" WHERE platform_type = 'standalone';
  IF to_regclass('public.credit_accounts') IS NOT NULL THEN
    EXECUTE 'SELECT count(DISTINCT integration.org_id) FROM "public"."integrations" integration WHERE platform_type = ''standalone'' AND NOT EXISTS (SELECT 1 FROM "public"."credit_accounts" account WHERE account.org_id = integration.org_id)' INTO account_count;
  END IF;
  SELECT count(*) INTO dispatch_count FROM "public"."verification_message_dispatches";
  SELECT count(*) INTO anomaly_count FROM (
    SELECT verification_id, kind FROM "public"."verification_message_dispatches"
    GROUP BY verification_id, kind HAVING count(*) > 1
  ) duplicate_identity;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'verification_message_dispatches' AND column_name = 'generation') THEN
    EXECUTE 'SELECT count(*) FROM (SELECT verification_id, kind, generation FROM "public"."verification_message_dispatches" GROUP BY verification_id, kind, generation HAVING count(*) > 1) duplicates' INTO anomaly_count;
  END IF;
  RAISE NOTICE 'US-04.5-01 preflight: standalone_sources=%, accounts_to_insert=%, legacy_dispatches=%, identity_anomalies=%', source_count, account_count, dispatch_count, anomaly_count;
  IF anomaly_count > 0 THEN RAISE EXCEPTION 'US-04.5-01 incompatible dispatch identities'; END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN CREATE TYPE "public"."credit_account_status" AS ENUM ('pending_approval', 'active', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."credit_reservation_status" AS ENUM ('held', 'consumed', 'released'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."credit_ledger_type" AS ENUM ('free_grant', 'purchase', 'consumption', 'failure_reversal', 'refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement', 'staff_adjustment'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."payment_purchase_status" AS ENUM ('pending', 'successful', 'failed', 'canceled', 'expired', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."payment_dispute_status" AS ENUM ('none', 'open', 'lost', 'won'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "public"."verification_message_dispatches" ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.verification_message_dispatches'::regclass AND conname = 'dispatch_generation_positive') THEN
    ALTER TABLE "public"."verification_message_dispatches" ADD CONSTRAINT dispatch_generation_positive CHECK (generation > 0);
    ALTER TABLE "public"."verification_message_dispatches" ADD CONSTRAINT dispatch_id_org_key UNIQUE (id, org_id);
    ALTER TABLE "public"."verification_message_dispatches" ADD CONSTRAINT dispatch_billable_identity_key UNIQUE (verification_id, kind, generation);
    ALTER TABLE "public"."verification_message_dispatches" ADD CONSTRAINT dispatch_reservation_identity_key UNIQUE (id, org_id, verification_id, kind, generation);
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_one_active_generation ON "public"."verification_message_dispatches" (verification_id, kind)
  WHERE state IN ('ready', 'sending', 'outcome_unknown') OR (state = 'accepted' AND failed_at IS NULL);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."credit_accounts" (
  org_id uuid PRIMARY KEY REFERENCES "public"."organizations"(id),
  status "public"."credit_account_status" NOT NULL DEFAULT 'pending_approval',
  posted_balance integer NOT NULL DEFAULT 0,
  held_credits integer NOT NULL DEFAULT 0 CHECK (held_credits >= 0),
  approved_by uuid,
  approved_at timestamptz,
  approval_reason text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_account_approval_check CHECK ((approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reason IS NOT NULL AND length(trim(approval_reason)) > 0))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."payment_purchases" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES "public"."credit_accounts"(org_id),
  reference text NOT NULL UNIQUE CHECK (length(trim(reference)) > 0),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  request_key text NOT NULL CHECK (length(trim(request_key)) > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor > 0),
  total_minor integer NOT NULL CHECK (total_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status "public"."payment_purchase_status" NOT NULL DEFAULT 'pending',
  dispute_status "public"."payment_dispute_status" NOT NULL DEFAULT 'none',
  provider_intention_id text,
  provider_order_id text,
  provider_transaction_id text,
  checkout_expires_at timestamptz,
  refunded_minor integer NOT NULL DEFAULT 0,
  reconciliation_required boolean NOT NULL DEFAULT false,
  reconciliation_code text CHECK (reconciliation_code ~ '^[a-z0-9_]{1,80}$'),
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
  next_reconciliation_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_purchase_id_org_key UNIQUE (id, org_id),
  CONSTRAINT payment_purchase_request_key UNIQUE (org_id, request_key),
  CONSTRAINT payment_purchase_total_check CHECK (quantity::bigint * unit_price_minor::bigint = total_minor),
  CONSTRAINT payment_purchase_refund_check CHECK (refunded_minor >= 0 AND refunded_minor <= total_minor),
  CONSTRAINT payment_purchase_provider_ids_check CHECK ((provider_intention_id IS NULL OR length(trim(provider_intention_id)) > 0) AND (provider_order_id IS NULL OR length(trim(provider_order_id)) > 0) AND (provider_transaction_id IS NULL OR length(trim(provider_transaction_id)) > 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_purchase_intention_key ON "public"."payment_purchases" (provider, provider_intention_id) WHERE provider_intention_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_purchase_order_key ON "public"."payment_purchases" (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_purchase_transaction_key ON "public"."payment_purchases" (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."credit_reservations" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES "public"."credit_accounts"(org_id),
  dispatch_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  kind "public"."verification_dispatch_kind" NOT NULL CHECK (kind IN ('initial', 'follow_up')),
  generation integer NOT NULL CHECK (generation > 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  billable_key text NOT NULL CHECK (length(trim(billable_key)) > 0),
  status "public"."credit_reservation_status" NOT NULL DEFAULT 'held',
  resolved_at timestamptz,
  resolution_code text CHECK (resolution_code ~ '^[a-z0-9_]{1,80}$'),
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_reservation_id_org_key UNIQUE (id, org_id),
  CONSTRAINT credit_reservation_dispatch_key UNIQUE (dispatch_id),
  CONSTRAINT credit_reservation_billable_key UNIQUE (org_id, billable_key),
  CONSTRAINT credit_reservation_identity_key UNIQUE (verification_id, kind, generation),
  CONSTRAINT credit_reservation_dispatch_fk FOREIGN KEY (dispatch_id, org_id, verification_id, kind, generation) REFERENCES "public"."verification_message_dispatches" (id, org_id, verification_id, kind, generation),
  CONSTRAINT credit_reservation_resolution_check CHECK ((status = 'held' AND resolved_at IS NULL AND resolution_code IS NULL AND resolved_by IS NULL) OR (status <> 'held' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."credit_ledger_entries" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES "public"."credit_accounts"(org_id),
  type "public"."credit_ledger_type" NOT NULL,
  quantity integer NOT NULL CHECK (quantity <> 0),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  reservation_id uuid,
  dispatch_id uuid,
  purchase_id uuid,
  source_ledger_entry_id uuid,
  source_reference text,
  actor_id uuid,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  posted_balance_before integer NOT NULL,
  posted_balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_id_org_key UNIQUE (id, org_id),
  CONSTRAINT credit_ledger_idempotency_key UNIQUE (org_id, idempotency_key),
  CONSTRAINT credit_ledger_reservation_fk FOREIGN KEY (reservation_id, org_id) REFERENCES "public"."credit_reservations" (id, org_id),
  CONSTRAINT credit_ledger_dispatch_fk FOREIGN KEY (dispatch_id, org_id) REFERENCES "public"."verification_message_dispatches" (id, org_id),
  CONSTRAINT credit_ledger_purchase_fk FOREIGN KEY (purchase_id, org_id) REFERENCES "public"."payment_purchases" (id, org_id),
  CONSTRAINT credit_ledger_source_fk FOREIGN KEY (source_ledger_entry_id, org_id) REFERENCES "public"."credit_ledger_entries" (id, org_id),
  CONSTRAINT credit_ledger_projection_check CHECK (posted_balance_before::bigint + quantity::bigint = posted_balance_after),
  CONSTRAINT credit_ledger_sign_check CHECK ((type IN ('free_grant', 'purchase', 'failure_reversal', 'chargeback_reinstatement') AND quantity > 0) OR (type IN ('consumption', 'refund_reversal', 'chargeback_reversal') AND quantity < 0) OR type = 'staff_adjustment'),
  CONSTRAINT credit_ledger_source_check CHECK (
    (type IN ('free_grant', 'staff_adjustment') AND reservation_id IS NULL AND dispatch_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL AND actor_id IS NOT NULL)
    OR (type = 'purchase' AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type = 'consumption' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type = 'failure_reversal' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NULL)
    OR (type IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement') AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NOT NULL AND length(trim(source_reference)) > 0)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_free_grant_key ON "public"."credit_ledger_entries" (org_id) WHERE type = 'free_grant';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_purchase_key ON "public"."credit_ledger_entries" (purchase_id) WHERE type = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_reservation_source_key ON "public"."credit_ledger_entries" (reservation_id, type) WHERE type IN ('consumption', 'failure_reversal');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_reversal_source_key ON "public"."credit_ledger_entries" (purchase_id, type, source_reference) WHERE type IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."payment_provider_events" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid,
  purchase_id uuid,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_intention_id text,
  provider_order_id text,
  provider_transaction_id text,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  verified boolean NOT NULL DEFAULT false,
  result_code text NOT NULL CHECK (result_code ~ '^[a-z0-9_]{1,80}$'),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,80}$'),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_event_fingerprint_key UNIQUE (provider, fingerprint),
  CONSTRAINT payment_event_org_fk FOREIGN KEY (org_id) REFERENCES "public"."credit_accounts" (org_id),
  CONSTRAINT payment_event_purchase_fk FOREIGN KEY (purchase_id, org_id) REFERENCES "public"."payment_purchases" (id, org_id),
  CONSTRAINT payment_event_tenant_check CHECK (purchase_id IS NULL OR org_id IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS credit_account_status_idx ON "public"."credit_accounts" (status);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_reservation_held_idx ON "public"."credit_reservations" (org_id, created_at) WHERE status = 'held';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_ledger_history_idx ON "public"."credit_ledger_entries" (org_id, created_at, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_purchase_history_idx ON "public"."payment_purchases" (org_id, created_at, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_purchase_reconciliation_idx ON "public"."payment_purchases" (next_reconciliation_at, created_at) WHERE status = 'pending' OR reconciliation_required;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_event_retry_idx ON "public"."payment_provider_events" (next_retry_at, received_at) WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_event_purchase_idx ON "public"."payment_provider_events" (org_id, purchase_id, received_at);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".protect_credit_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credit and payment history is immutable' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_ledger_immutable ON "public"."credit_ledger_entries";--> statement-breakpoint
CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE OR DELETE ON "public"."credit_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_ledger_no_truncate ON "public"."credit_ledger_entries";--> statement-breakpoint
CREATE TRIGGER credit_ledger_no_truncate BEFORE TRUNCATE ON "public"."credit_ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_purchase_no_delete ON "public"."payment_purchases";--> statement-breakpoint
CREATE TRIGGER payment_purchase_no_delete BEFORE DELETE ON "public"."payment_purchases" FOR EACH ROW EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_purchase_no_truncate ON "public"."payment_purchases";--> statement-breakpoint
CREATE TRIGGER payment_purchase_no_truncate BEFORE TRUNCATE ON "public"."payment_purchases" FOR EACH STATEMENT EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".protect_payment_purchase_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.org_id, NEW.reference, NEW.provider, NEW.mode, NEW.request_key, NEW.request_hash, NEW.quantity, NEW.unit_price_minor, NEW.total_minor, NEW.currency, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.reference, OLD.provider, OLD.mode, OLD.request_key, OLD.request_hash, OLD.quantity, OLD.unit_price_minor, OLD.total_minor, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'Original purchase terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.provider_intention_id IS NOT NULL AND NEW.provider_intention_id IS DISTINCT FROM OLD.provider_intention_id)
    OR (OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id)
    OR (OLD.provider_transaction_id IS NOT NULL AND NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id) THEN
    RAISE EXCEPTION 'Bound provider identifiers are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_purchase_terms_immutable ON "public"."payment_purchases";--> statement-breakpoint
CREATE TRIGGER payment_purchase_terms_immutable BEFORE UPDATE ON "public"."payment_purchases" FOR EACH ROW EXECUTE FUNCTION "public".protect_payment_purchase_terms();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".guard_credit_account_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version::bigint <> OLD.version::bigint + 1 THEN
    RAISE EXCEPTION 'Account updates require a new version and stable identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_account_version_guard ON "public"."credit_accounts";--> statement-breakpoint
CREATE TRIGGER credit_account_version_guard BEFORE UPDATE ON "public"."credit_accounts" FOR EACH ROW EXECUTE FUNCTION "public".guard_credit_account_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".guard_credit_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.org_id, NEW.dispatch_id, NEW.verification_id, NEW.kind, NEW.generation, NEW.quantity, NEW.billable_key, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.dispatch_id, OLD.verification_id, OLD.kind, OLD.generation, OLD.quantity, OLD.billable_key, OLD.created_at) THEN
    RAISE EXCEPTION 'Reservation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'released' AND NEW.status <> 'released') OR (OLD.status = 'consumed' AND NEW.status = 'held') THEN
    RAISE EXCEPTION 'Reservation cannot return to a previous state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_reservation_guard ON "public"."credit_reservations";--> statement-breakpoint
CREATE TRIGGER credit_reservation_guard BEFORE UPDATE ON "public"."credit_reservations" FOR EACH ROW EXECUTE FUNCTION "public".guard_credit_reservation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".guard_credit_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_entry "public"."credit_ledger_entries"%ROWTYPE;
BEGIN
  IF NEW.reservation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "public"."credit_reservations" WHERE id = NEW.reservation_id AND org_id = NEW.org_id AND dispatch_id = NEW.dispatch_id AND quantity::bigint = abs(NEW.quantity::bigint)) THEN
    RAISE EXCEPTION 'Ledger reservation source mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'purchase' AND NOT EXISTS (SELECT 1 FROM "public"."payment_purchases" WHERE id = NEW.purchase_id AND org_id = NEW.org_id AND quantity = NEW.quantity) THEN
    RAISE EXCEPTION 'Ledger purchase quantity mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_ledger_entry_id IS NOT NULL THEN
    SELECT * INTO source_entry FROM "public"."credit_ledger_entries" WHERE id = NEW.source_ledger_entry_id AND org_id = NEW.org_id;
    IF NOT FOUND OR source_entry.purchase_id IS DISTINCT FROM NEW.purchase_id OR source_entry.reservation_id IS DISTINCT FROM NEW.reservation_id
      OR (NEW.type = 'failure_reversal' AND source_entry.type <> 'consumption')
      OR (NEW.type IN ('refund_reversal', 'chargeback_reversal') AND source_entry.type <> 'purchase')
      OR (NEW.type = 'chargeback_reinstatement' AND (source_entry.type <> 'chargeback_reversal' OR source_entry.source_reference IS DISTINCT FROM NEW.source_reference OR source_entry.quantity::bigint + NEW.quantity::bigint <> 0)) THEN
      RAISE EXCEPTION 'Ledger reversal source mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_ledger_source_guard ON "public"."credit_ledger_entries";--> statement-breakpoint
CREATE TRIGGER credit_ledger_source_guard BEFORE INSERT ON "public"."credit_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "public".guard_credit_ledger_source();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public".guard_dispatch_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preceding "public"."verification_message_dispatches"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.org_id, NEW.integration_id, NEW.verification_id, NEW.kind, NEW.generation, NEW.dispatch_key)
      IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.integration_id, OLD.verification_id, OLD.kind, OLD.generation, OLD.dispatch_key) THEN
      RAISE EXCEPTION 'Dispatch identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.generation > 1 THEN
    PERFORM 1 FROM "public"."verifications" WHERE id = NEW.verification_id AND org_id = NEW.org_id FOR UPDATE;
    SELECT * INTO preceding FROM "public"."verification_message_dispatches" WHERE verification_id = NEW.verification_id AND kind = NEW.kind AND generation = NEW.generation - 1 AND org_id = NEW.org_id FOR UPDATE;
    IF NOT FOUND OR NOT (preceding.state = 'rejected' OR (preceding.state = 'accepted' AND preceding.failed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'New generation requires confirmed preceding failure' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "public"."credit_reservations" WHERE dispatch_id = preceding.id AND status <> 'released') THEN
      RAISE EXCEPTION 'Preceding credit reservation must be released' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "public"."credit_ledger_entries" consumed WHERE consumed.dispatch_id = preceding.id AND consumed.type = 'consumption' AND NOT EXISTS (SELECT 1 FROM "public"."credit_ledger_entries" reversal WHERE reversal.source_ledger_entry_id = consumed.id AND reversal.type = 'failure_reversal')) THEN
      RAISE EXCEPTION 'Preceding credit consumption must be reversed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS dispatch_generation_guard ON "public"."verification_message_dispatches";--> statement-breakpoint
CREATE TRIGGER dispatch_generation_guard BEFORE INSERT OR UPDATE ON "public"."verification_message_dispatches" FOR EACH ROW EXECUTE FUNCTION "public".guard_dispatch_generation();--> statement-breakpoint

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['credit_accounts', 'credit_reservations', 'credit_ledger_entries', 'payment_purchases', 'payment_provider_events'] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON "public".%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON "public".%I TO service_role', table_name);
    EXECUTE format('DROP POLICY IF EXISTS credit_service_access ON "public".%I', table_name);
    EXECUTE format('CREATE POLICY credit_service_access ON "public".%I FOR ALL TO service_role USING (true) WITH CHECK (true)', table_name);
    IF table_name <> 'payment_provider_events' THEN
      EXECUTE format('DROP POLICY IF EXISTS credit_tenant_read ON "public".%I', table_name);
      EXECUTE format('CREATE POLICY credit_tenant_read ON "public".%I FOR SELECT TO authenticated USING (org_id = get_user_org_id())', table_name);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
REVOKE UPDATE ON "public"."credit_ledger_entries" FROM service_role;--> statement-breakpoint
GRANT SELECT (org_id, status, posted_balance, held_credits, version, created_at, updated_at) ON "public"."credit_accounts" TO authenticated;--> statement-breakpoint
GRANT SELECT (id, org_id, dispatch_id, verification_id, kind, generation, quantity, status, resolved_at, created_at, updated_at) ON "public"."credit_reservations" TO authenticated;--> statement-breakpoint
GRANT SELECT (id, org_id, type, quantity, reservation_id, dispatch_id, purchase_id, posted_balance_before, posted_balance_after, created_at) ON "public"."credit_ledger_entries" TO authenticated;--> statement-breakpoint
GRANT SELECT (id, org_id, reference, quantity, unit_price_minor, total_minor, currency, status, dispute_status, checkout_expires_at, refunded_minor, created_at, updated_at) ON "public"."payment_purchases" TO authenticated;--> statement-breakpoint

INSERT INTO "public"."credit_accounts" (org_id)
SELECT DISTINCT org_id FROM "public"."integrations" WHERE platform_type = 'standalone'
ON CONFLICT (org_id) DO NOTHING;
