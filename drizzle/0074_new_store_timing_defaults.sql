-- New store timing defaults.
--
-- New stores send one reminder 6 hours after the first message, escalate to
-- "no reply" 24 hours after that reminder (30 hours after the first message),
-- and hold messages during quiet hours, 22:00-09:00 in the store timezone.
-- Only the column defaults change: existing stores keep the timings they have.
ALTER TABLE "integrations" ALTER COLUMN "follow_up_delay_minutes" SET DEFAULT 360;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "escalation_delay_minutes" SET DEFAULT 1800;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "quiet_hours_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "quiet_hours_start" SET DEFAULT '22:00';--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "quiet_hours_end" SET DEFAULT '09:00';
