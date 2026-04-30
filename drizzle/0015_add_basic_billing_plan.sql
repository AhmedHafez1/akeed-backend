ALTER TABLE "integrations" ALTER COLUMN "billing_plan_id" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."integration_billing_plan_id";--> statement-breakpoint
CREATE TYPE "public"."integration_billing_plan_id" AS ENUM('starter', 'basic', 'pro', 'business');--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "billing_plan_id" SET DATA TYPE "public"."integration_billing_plan_id" USING "billing_plan_id"::"public"."integration_billing_plan_id";
