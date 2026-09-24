-- Who confirmed an order: the customer (WhatsApp reply) or the merchant
-- (manual confirmation from the dashboard's action list).
--
-- verifications.confirmation_source mirrors cancellation_source. NULL means a
-- confirmation recorded before this column existed, which could only have come
-- from a customer reply, so no backfill is needed and none is attempted.
--
-- idx_orders_org_order_number backs the confirmations search by order number,
-- which is always scoped to one organization.
--
-- Rollback: DROP INDEX "idx_orders_org_order_number"; ALTER TABLE
-- "verifications" DROP COLUMN "confirmation_source". No existing data is
-- rewritten.
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "confirmation_source" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "verifications" ADD CONSTRAINT "verifications_confirmation_source_check" CHECK ("confirmation_source" IS NULL OR "confirmation_source" IN ('customer', 'merchant_manual'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_org_order_number" ON "orders" USING btree ("org_id" uuid_ops, "order_number" text_ops);
