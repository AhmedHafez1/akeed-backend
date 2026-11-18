-- New stores send the reminder 2 hours after the first message and reach
-- no reply 12 hours after that reminder (840 minutes from the first message).
-- Only the column defaults change: existing stores keep the timings they have.
ALTER TABLE "integrations" ALTER COLUMN "follow_up_delay_minutes" SET DEFAULT 120;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "escalation_delay_minutes" SET DEFAULT 840;
