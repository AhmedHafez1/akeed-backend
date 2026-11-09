ALTER TABLE "verification_change_request_effects" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_change_request_effects" ADD COLUMN IF NOT EXISTS "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_change_request_effects" ADD COLUMN IF NOT EXISTS "email_payload" jsonb;--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" ADD COLUMN IF NOT EXISTS "desired_revision" text;--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" ADD COLUMN IF NOT EXISTS "claim_token" uuid;--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" DROP CONSTRAINT IF EXISTS "commerce_outcome_syncs_action_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "commerce_outcome_syncs" ADD CONSTRAINT "commerce_outcome_syncs_action_check" CHECK ("action" IN ('customer_confirmation', 'customer_cancellation', 'merchant_no_reply_cancellation', 'merchant_cancellation_tagging', 'automatic_no_reply_tagging', 'automatic_no_whatsapp_tagging', 'automatic_no_reply_cancellation', 'change_request_reconciliation'));
