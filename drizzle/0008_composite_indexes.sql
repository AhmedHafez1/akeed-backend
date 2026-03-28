-- Orders: replace single-column org_id and created_at indexes with
-- composite (org_id, created_at DESC, id DESC) for cursor pagination
DROP INDEX IF EXISTS "idx_orders_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_orders_created_at";--> statement-breakpoint
CREATE INDEX "idx_orders_org_created_id" ON "orders" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops DESC NULLS FIRST,"id" uuid_ops DESC NULLS FIRST);--> statement-breakpoint

-- Verifications: replace single-column org_id and status indexes with
-- composite (org_id, created_at DESC, id DESC) for cursor pagination
-- and composite (org_id, created_at, status) for stats aggregation
DROP INDEX IF EXISTS "idx_verifications_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_verifications_status";--> statement-breakpoint
CREATE INDEX "idx_verifications_org_created_id" ON "verifications" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops DESC NULLS FIRST,"id" uuid_ops DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_verifications_org_created_status" ON "verifications" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops,"status" enum_ops);
