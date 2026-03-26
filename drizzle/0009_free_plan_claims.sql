CREATE TABLE "billing_free_plan_claims" (
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
ALTER TABLE "billing_free_plan_claims" ADD CONSTRAINT "billing_free_plan_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_free_plan_claims_org_id" ON "billing_free_plan_claims" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_billing_free_plan_claims_shop_domain" ON "billing_free_plan_claims" USING btree ("shop_domain" text_ops);--> statement-breakpoint
CREATE POLICY "Service role manages free plan claims" ON "billing_free_plan_claims" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Multi-tenant free plan claims" ON "billing_free_plan_claims" AS PERMISSIVE FOR ALL TO "authenticated" USING ((org_id = get_user_org_id())) WITH CHECK ((org_id = get_user_org_id()));--> statement-breakpoint

INSERT INTO "billing_free_plan_claims" ("org_id", "platform_type", "shop_domain", "claimed_at")
SELECT
  i."org_id",
  i."platform_type",
	lower(trim(i."platform_store_url")),
  COALESCE(i."billing_activated_at", i."updated_at", i."created_at", now())
FROM "integrations" i
WHERE i."billing_plan_id" = 'starter'
  AND COALESCE(lower(trim(i."billing_status")), '') = 'active'
ON CONFLICT ("platform_type", "shop_domain") DO NOTHING;
