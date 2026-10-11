-- Order details for the detailed confirmation message.
--
-- A template may now carry what the customer ordered and where it ships
-- (variables `items`, `region` and `address`). Until now an order kept those
-- only inside "raw_payload", which the core never reads. The normalizers of
-- the sources that deliver them (EasyOrders, Shopify) fill these columns at
-- ingest:
--
--   "line_items"        [{ name, quantity, unitPrice, options: [{ name?, value }] }]
--   "shipping_region"   the governorate, else the city
--   "shipping_address"  the street address
--
-- All three are nullable with no default, so this is a catalog-only change and
-- no row is rewritten. Existing orders stay NULL and are not backfilled: their
-- messages were already sent. An order with a NULL the chosen template needs
-- is sent the language default instead.
--
-- Rollback: drop the three columns.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "line_items" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "shipping_region" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "shipping_address" text;
