-- Image-header twins of the confirmation and reminder templates.
--
-- "whatsapp_templates" gains:
--   * "header_format": 'none' for every existing row, 'image' for a twin.
--   * "image_twin_of_key": for a twin, the key of the text template it
--     repeats. A twin has the same body, buttons and parameters as that
--     template, with an image header added.
-- A twin is never a default, and each text template has at most one twin.
--
-- No row is written. Staff register a twin by hand after the provider has the
-- template. Selection reads only rows with header format 'none', so stores
-- choose from and send exactly the templates they did before. A twin is sent
-- only in place of its text template, for a store with the logo header switched
-- on and a banner saved.

ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "header_format" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "image_twin_of_key" text;--> statement-breakpoint

ALTER TABLE "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_header_format_check";--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_header_format_check" CHECK (
  ("header_format" = 'none' AND "image_twin_of_key" IS NULL)
  OR ("header_format" = 'image' AND "image_twin_of_key" IS NOT NULL AND "is_default" = false)
);--> statement-breakpoint

ALTER TABLE "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_image_twin_of_key_fkey";--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_image_twin_of_key_fkey" FOREIGN KEY ("image_twin_of_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_one_image_twin_idx" ON "whatsapp_templates" ("image_twin_of_key") WHERE "image_twin_of_key" IS NOT NULL;
