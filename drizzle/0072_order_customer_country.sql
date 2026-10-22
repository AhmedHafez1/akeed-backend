-- The customer's country, read from their phone.
--
-- "customer_country" is the ISO 3166 alpha-2 region of the order's E.164
-- "customer_phone" (libphonenumber), set at ingest for every source. It says
-- where the number is registered, not where the customer lives. The admin
-- control tower shows it on each order and aggregates it per store, which the
-- partial index serves.
--
-- Nullable with no default: a catalog-only change, no row is rewritten.
-- Existing orders stay NULL until `npm run backfill:order-customer-country`
-- fills them; SQL cannot parse phone numbers, so no backfill runs here.
-- Redacting a customer clears it with the phone.
--
-- Rollback: drop the index, the constraint and the column.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_country" varchar(2);--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_customer_country_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_country_check" CHECK ("customer_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_integration_customer_country" ON "orders" USING btree ("integration_id", "customer_country") WHERE "is_test" = false;
