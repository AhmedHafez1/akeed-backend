CREATE TYPE "public"."integration_default_language" AS ENUM('en', 'ar', 'auto');--> statement-breakpoint
CREATE TYPE "public"."integration_onboarding_status" AS ENUM('pending', 'completed');--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "store_name" varchar(255);--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "default_language" "integration_default_language" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "is_auto_verify_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "onboarding_status" "integration_onboarding_status" DEFAULT 'pending' NOT NULL;
