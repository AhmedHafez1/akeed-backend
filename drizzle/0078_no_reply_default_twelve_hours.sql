-- New stores reach no reply 12 hours after the 6-hour reminder.
-- The stored delay is measured from the initial message; existing rows are unchanged.
ALTER TABLE "integrations" ALTER COLUMN "escalation_delay_minutes" SET DEFAULT 1080;
