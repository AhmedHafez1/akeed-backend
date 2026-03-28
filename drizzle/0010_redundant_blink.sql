CREATE TABLE IF NOT EXISTS "billing_free_plan_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform_type" text NOT NULL,
	"shop_domain" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "billing_free_plan_claims_platform_shop_key" UNIQUE("platform_type","shop_domain"),
	CONSTRAINT "billing_free_plan_claims_platform_type_check" CHECK (platform_type = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text]))
);
--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_orders_created_at";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_orders_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_verifications_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_verifications_status";--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'billing_free_plan_claims_org_id_fkey'
			AND conrelid = 'billing_free_plan_claims'::regclass
	) THEN
		ALTER TABLE "billing_free_plan_claims"
			ADD CONSTRAINT "billing_free_plan_claims_org_id_fkey"
			FOREIGN KEY ("org_id")
			REFERENCES "public"."organizations"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_free_plan_claims_org_id" ON "billing_free_plan_claims" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_free_plan_claims_shop_domain" ON "billing_free_plan_claims" USING btree ("shop_domain" text_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_org_created_id" ON "orders" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops DESC NULLS FIRST,"id" uuid_ops DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verifications_org_created_id" ON "verifications" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops DESC NULLS FIRST,"id" uuid_ops DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verifications_org_created_status" ON "verifications" USING btree ("org_id" uuid_ops,"created_at" timestamptz_ops,"status" enum_ops);--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages free plan claims" ON "billing_free_plan_claims";--> statement-breakpoint
DROP POLICY IF EXISTS "Multi-tenant free plan claims" ON "billing_free_plan_claims";--> statement-breakpoint
CREATE POLICY "Service role manages free plan claims" ON "billing_free_plan_claims" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Multi-tenant free plan claims" ON "billing_free_plan_claims" AS PERMISSIVE FOR ALL TO "authenticated" USING ((org_id = get_user_org_id())) WITH CHECK ((org_id = get_user_org_id()));
