-- Quiet hours run in the Shopify store's own zone.
--
-- A Shopify store still on the Riyadh column default never chose a zone, so it
-- moves to the zone Shopify reported for the store. Stores with quiet hours on
-- keep their zone: their window is already running and may have been chosen.
-- A zone Postgres does not know is left alone.
--
-- Rollback: none per row; the previous value was the Riyadh default.
UPDATE "integrations"
SET "timezone" = "shop_timezone"
WHERE "platform_type" = 'shopify'
  AND "timezone" = 'Asia/Riyadh'
  AND "quiet_hours_enabled" = false
  AND "shop_timezone" IS NOT NULL
  AND "shop_timezone" <> 'Asia/Riyadh'
  AND "shop_timezone" IN (SELECT "name" FROM pg_timezone_names);
