-- Quiet hours start off for new stores.
--
-- A new store sends at any hour until the merchant turns quiet hours on. The
-- 22:00-09:00 window stays as the default for when they do. Only the column
-- default changes: existing stores keep the setting they have.
--
-- Rollback: ALTER TABLE "integrations" ALTER COLUMN "quiet_hours_enabled" SET DEFAULT true;
ALTER TABLE "integrations" ALTER COLUMN "quiet_hours_enabled" SET DEFAULT false;
