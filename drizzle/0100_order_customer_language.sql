-- The language a customer shopped in, and the message-language setting that
-- follows it. Shopify sends the storefront language of each order
-- (customer_locale); other sources leave the column NULL.
--
-- Rollback: deploy the previous release after setting every store back with
--   UPDATE "integrations" SET "default_language" = 'auto'
--     WHERE "default_language" = 'storefront';
-- then drop the column. PostgreSQL cannot drop a value from an enum type;
-- the unused 'storefront' value of "integration_default_language" may stay.
DO $$ BEGIN
  IF to_regtype('integration_default_language') IS NOT NULL THEN
    ALTER TYPE "integration_default_language" ADD VALUE IF NOT EXISTS 'storefront';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_language" varchar(35);--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_customer_language_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_language_check" CHECK ("customer_language" ~ '^[a-z]{2,3}([-_][a-z0-9]{1,8})*$');
