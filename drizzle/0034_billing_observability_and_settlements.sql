CREATE TABLE IF NOT EXISTS "public"."billing_settlement_reports" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider text NOT NULL DEFAULT 'paymob' CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_report_id text NOT NULL CHECK (length(trim(provider_report_id)) > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  supersedes_id uuid REFERENCES "public"."billing_settlement_reports"(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  settled_at timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transaction_count integer NOT NULL CHECK (transaction_count >= 0),
  gross_minor bigint NOT NULL CHECK (gross_minor >= 0),
  refunded_minor bigint NOT NULL CHECK (refunded_minor >= 0),
  chargeback_minor bigint NOT NULL CHECK (chargeback_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  vat_minor bigint NOT NULL CHECK (vat_minor >= 0),
  net_minor bigint NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  evidence text NOT NULL CHECK (length(trim(evidence)) > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_settlement_period_check CHECK (period_start < period_end),
  CONSTRAINT billing_settlement_no_self_supersede CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT billing_settlement_report_revision_key UNIQUE (provider, provider_report_id, revision),
  CONSTRAINT billing_settlement_actor_idempotency_key UNIQUE (actor_id, idempotency_key)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS billing_settlement_period_idx ON "public"."billing_settlement_reports" (period_start, period_end, created_at);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_settlement_supersedes_key ON "public"."billing_settlement_reports" (supersedes_id) WHERE supersedes_id IS NOT NULL;--> statement-breakpoint

DROP TRIGGER IF EXISTS billing_settlement_immutable ON "public"."billing_settlement_reports";--> statement-breakpoint
CREATE TRIGGER billing_settlement_immutable BEFORE UPDATE OR DELETE ON "public"."billing_settlement_reports" FOR EACH ROW EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_settlement_no_truncate ON "public"."billing_settlement_reports";--> statement-breakpoint
CREATE TRIGGER billing_settlement_no_truncate BEFORE TRUNCATE ON "public"."billing_settlement_reports" FOR EACH STATEMENT EXECUTE FUNCTION "public".protect_credit_history();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."billing_reconciliation_runs" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_key text NOT NULL UNIQUE CHECK (length(trim(run_key)) > 0),
  trigger text NOT NULL CHECK (trigger IN ('nightly', 'settlement', 'manual')),
  mode text NOT NULL CHECK (mode IN ('local_only', 'report_only', 'active')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  settlement_id uuid REFERENCES "public"."billing_settlement_reports"(id),
  triggered_by uuid,
  reason text,
  candidates integer NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  attempted integer NOT NULL DEFAULT 0 CHECK (attempted >= 0),
  resolved integer NOT NULL DEFAULT 0 CHECK (resolved >= 0),
  deferred integer NOT NULL DEFAULT 0 CHECK (deferred >= 0),
  findings_opened integer NOT NULL DEFAULT 0 CHECK (findings_opened >= 0),
  findings_resolved integer NOT NULL DEFAULT 0 CHECK (findings_resolved >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_reconciliation_run_trigger_check CHECK ((trigger = 'settlement' AND settlement_id IS NOT NULL) OR (trigger <> 'settlement' AND settlement_id IS NULL)),
  CONSTRAINT billing_reconciliation_run_reason_check CHECK (reason IS NULL OR length(trim(reason)) > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS billing_reconciliation_run_created_idx ON "public"."billing_reconciliation_runs" (created_at DESC, id DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."billing_reconciliation_attempts" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id uuid NOT NULL REFERENCES "public"."billing_reconciliation_runs"(id) ON DELETE CASCADE,
  org_id uuid REFERENCES "public"."credit_accounts"(org_id),
  purchase_id uuid,
  target_kind text NOT NULL CHECK (target_kind IN ('provider_inquiry', 'purchase_scan', 'account_invariant', 'static_signal', 'settlement_compare')),
  target_key text NOT NULL CHECK (length(trim(target_key)) > 0),
  outcome text NOT NULL CHECK (outcome ~ '^[a-z0-9_]{1,80}$'),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,80}$'),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_reconciliation_attempt_purchase_fk FOREIGN KEY (purchase_id, org_id) REFERENCES "public"."payment_purchases" (id, org_id),
  CONSTRAINT billing_reconciliation_attempt_target_key UNIQUE (run_id, target_kind, target_key),
  CONSTRAINT billing_reconciliation_attempt_tenant_check CHECK (purchase_id IS NULL OR org_id IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS billing_reconciliation_attempt_retention_idx ON "public"."billing_reconciliation_attempts" (attempted_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_reconciliation_attempt_purchase_idx ON "public"."billing_reconciliation_attempts" (org_id, purchase_id, attempted_at DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."billing_reconciliation_findings" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  org_id uuid REFERENCES "public"."credit_accounts"(org_id),
  purchase_id uuid,
  settlement_id uuid REFERENCES "public"."billing_settlement_reports"(id),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,80}$'),
  severity text NOT NULL CHECK (severity IN ('attention', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_action text NOT NULL CHECK (next_action ~ '^[a-z0-9_]{1,80}$'),
  next_attempt_at timestamptz,
  safe_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_id uuid REFERENCES "public"."billing_reconciliation_runs"(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_reconciliation_finding_purchase_fk FOREIGN KEY (purchase_id, org_id) REFERENCES "public"."payment_purchases" (id, org_id),
  CONSTRAINT billing_reconciliation_finding_tenant_check CHECK (purchase_id IS NULL OR org_id IS NOT NULL),
  CONSTRAINT billing_reconciliation_finding_resolution_check CHECK ((status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS billing_reconciliation_finding_queue_idx ON "public"."billing_reconciliation_findings" (status, severity, last_seen_at DESC, id DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_reconciliation_finding_org_idx ON "public"."billing_reconciliation_findings" (org_id, status, last_seen_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_reconciliation_finding_retention_idx ON "public"."billing_reconciliation_findings" (status, resolved_at) WHERE status = 'resolved';--> statement-breakpoint

ALTER TABLE "public"."billing_settlement_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."billing_reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."billing_reconciliation_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."billing_reconciliation_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS billing_observability_service_access ON "public"."billing_settlement_reports";--> statement-breakpoint
CREATE POLICY billing_observability_service_access ON "public"."billing_settlement_reports" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS billing_observability_service_access ON "public"."billing_reconciliation_runs";--> statement-breakpoint
CREATE POLICY billing_observability_service_access ON "public"."billing_reconciliation_runs" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS billing_observability_service_access ON "public"."billing_reconciliation_attempts";--> statement-breakpoint
CREATE POLICY billing_observability_service_access ON "public"."billing_reconciliation_attempts" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS billing_observability_service_access ON "public"."billing_reconciliation_findings";--> statement-breakpoint
CREATE POLICY billing_observability_service_access ON "public"."billing_reconciliation_findings" FOR ALL TO service_role USING (true) WITH CHECK (true);--> statement-breakpoint
