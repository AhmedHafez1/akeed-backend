-- Paid-through resume: the end of the 30-day period a paid Shopify store had
-- already paid for when it uninstalled. A reinstall before this time gets the
-- same plan back (billing_status = 'paid_through') until then. Set once per
-- paid period at uninstall; no backfill.
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "paid_through_at" timestamp with time zone;
