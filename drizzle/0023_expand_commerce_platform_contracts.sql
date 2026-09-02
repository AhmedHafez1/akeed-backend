ALTER TABLE "integrations" DROP CONSTRAINT "integrations_platform_type_check";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_platform_type_check" CHECK ("platform_type" = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text, 'standalone'::text, 'easyorders'::text])) NOT VALID;--> statement-breakpoint
ALTER TABLE "integrations" VALIDATE CONSTRAINT "integrations_platform_type_check";--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" DROP CONSTRAINT "billing_free_plan_claims_platform_type_check";--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" ADD CONSTRAINT "billing_free_plan_claims_platform_type_check" CHECK ("platform_type" = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text, 'standalone'::text, 'easyorders'::text])) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing_free_plan_claims" VALIDATE CONSTRAINT "billing_free_plan_claims_platform_type_check";
