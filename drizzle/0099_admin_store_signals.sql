-- Order intake per store, for the admin health signal that catches orders
-- arriving but not being confirmed. Counts and payment-method names only:
-- no customer data. Rows older than 90 days are deleted by the hourly
-- webhook retention job.
--
-- integration_order_intake_orders is the dedupe ledger: one row per store
-- order, so a second delivery of the same order (a new webhook id) is not
-- counted again. integration_order_intake holds the hourly counts.
CREATE TABLE IF NOT EXISTS public.integration_order_intake_orders (
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  external_order_id text NOT NULL,
  received_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('eligible','skipped')),
  skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, external_order_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS integration_order_intake_orders_received_idx ON public.integration_order_intake_orders(received_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.integration_order_intake (
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  received integer NOT NULL DEFAULT 0 CHECK (received >= 0),
  eligible integer NOT NULL DEFAULT 0 CHECK (eligible >= 0),
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  skipped_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_methods jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, bucket_start)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS integration_order_intake_bucket_idx ON public.integration_order_intake(bucket_start);
--> statement-breakpoint
ALTER TABLE public.integration_order_intake_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.integration_order_intake ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.integration_order_intake_orders FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON public.integration_order_intake FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages order intake orders" ON public.integration_order_intake_orders;
--> statement-breakpoint
CREATE POLICY "Service role manages order intake orders" ON public.integration_order_intake_orders FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages order intake" ON public.integration_order_intake;
--> statement-breakpoint
CREATE POLICY "Service role manages order intake" ON public.integration_order_intake FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
-- The plan a store was on when it uninstalled. A reinstall or a later plan
-- overwrites the integration's billing columns, so admin reads it here.
ALTER TABLE public.admin_store_lifecycles ADD COLUMN IF NOT EXISTS uninstall_plan_id text;
--> statement-breakpoint
ALTER TABLE public.admin_store_lifecycles ADD COLUMN IF NOT EXISTS uninstall_billing_status text;
--> statement-breakpoint
ALTER TABLE public.admin_store_lifecycles ADD COLUMN IF NOT EXISTS uninstall_paid_through_at timestamptz;
