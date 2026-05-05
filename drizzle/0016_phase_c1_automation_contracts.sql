-- Phase C1: Automation contracts — add no_reply status, automation columns
-- NOTE: ALTER TYPE ... ADD VALUE 'no_reply' is not reversible in Postgres.
-- Rollback requires rebuilding the enum type entirely.

-- 1. Add 'no_reply' to verification_status enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'no_reply'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'verification_status')
  ) THEN
    ALTER TYPE "public"."verification_status" ADD VALUE 'no_reply' AFTER 'failed';
  END IF;
END $$;--> statement-breakpoint

-- 2. Add automation columns to integrations
ALTER TABLE "integrations" ADD COLUMN "follow_up_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "follow_up_delay_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "escalation_delay_minutes" integer DEFAULT 360 NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "quiet_hours_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "quiet_hours_start" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "quiet_hours_end" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "timezone" text DEFAULT 'Asia/Riyadh' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "send_delay_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 3. Add automation columns to verifications
ALTER TABLE "verifications" ADD COLUMN "follow_up_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "no_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "follow_up_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "merchant_canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "cancellation_source" text;
