-- Free plan is once per store, including after shop/redact.
--
-- Shopify sends shop/redact ~48h after uninstall and handleShopRedact deletes
-- the organization. With ON DELETE CASCADE the claim went with it, so a later
-- reinstall could claim the starter plan again. The claim now outlives the
-- org: org_id becomes nullable and the FK sets it to NULL. The retained row
-- holds only platform_type + shop_domain (store identity, no customer data),
-- kept to prevent repeat free-plan claims.
--
-- RLS "Multi-tenant free plan claims" compares org_id to get_user_org_id(), so
-- orphaned rows are invisible to tenants; service_role is unaffected.
--
-- Rollback: delete rows WHERE org_id IS NULL, restore NOT NULL and re-add the
-- FK with ON DELETE CASCADE.
ALTER TABLE "billing_free_plan_claims" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" DROP CONSTRAINT IF EXISTS "billing_free_plan_claims_org_id_fkey";--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" ADD CONSTRAINT "billing_free_plan_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
