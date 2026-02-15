CREATE TYPE "public"."integration_billing_plan_id" AS ENUM('starter', 'growth', 'pro', 'scale');--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_plan_id" "integration_billing_plan_id";--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "shopify_subscription_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_status" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_initiated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "billing_status_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_integrations_billing_status" ON "integrations" USING btree ("billing_status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_integrations_shopify_subscription_id" ON "integrations" USING btree ("shopify_subscription_id" text_ops);