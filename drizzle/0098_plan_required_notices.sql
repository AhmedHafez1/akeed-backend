DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.admin_store_lifecycles'::regclass AND conname='admin_store_lifecycles_identity_key') THEN
    ALTER TABLE public.admin_store_lifecycles ADD CONSTRAINT admin_store_lifecycles_identity_key UNIQUE (id, org_id, integration_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.plan_required_notices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  lifecycle_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  email_payload jsonb,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  reason text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_required_notices_source_fkey FOREIGN KEY (integration_id,org_id) REFERENCES public.integrations(id,org_id) ON DELETE CASCADE,
  CONSTRAINT plan_required_notices_lifecycle_fkey FOREIGN KEY (lifecycle_id,org_id,integration_id) REFERENCES public.admin_store_lifecycles(id,org_id,integration_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plan_required_notices_due_idx ON public.plan_required_notices(next_attempt_at) WHERE status IN ('pending','sending');
--> statement-breakpoint
ALTER TABLE public.plan_required_notices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages plan required notices" ON public.plan_required_notices;
--> statement-breakpoint
CREATE POLICY "Service role manages plan required notices" ON public.plan_required_notices FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_events_planless_recent_idx ON public.webhook_events(org_id,integration_id,received_at) WHERE platform='shopify' AND job_type='order.create' AND status='skipped' AND last_error='billing_not_active';
