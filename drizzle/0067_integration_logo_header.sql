-- The store's logo and the banner built from it, for the image header of the
-- confirmation and reminder messages.
--
-- "integrations" gains:
--   * "logo_url": the public URL of the logo the merchant uploaded.
--   * "logo_banner_url": the public URL of the 1200x628 banner built from it.
--   * "logo_updated_at": when the logo was last saved.
--   * "logo_header_enabled": staff switch it on per store. Off for every store.
-- The three logo columns are NULL for every store. A store with the switch off
-- or no banner sends the text templates it sends today.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "logo_url" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "logo_banner_url" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "logo_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "logo_header_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_logo_urls_https_check";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_logo_urls_https_check" CHECK (
  ("logo_url" IS NULL OR "logo_url" LIKE 'https://%')
  AND ("logo_banner_url" IS NULL OR "logo_banner_url" LIKE 'https://%')
);
