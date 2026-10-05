-- Store settings reference registry keys (US-08-03).
--
-- A store's Arabic and English style lived in "cod_template_ar_variant" and
-- "cod_template_en_variant", limited by CHECK constraints to the 8 names the
-- code knew. Two new columns hold the registry key of each choice instead
-- ('cod_confirm.ar.egyptian'), so a template staff add later can be chosen
-- without a migration. NULL means no key was stored: while the old columns
-- exist the code reads the old variant column for that store, and failing
-- that the store gets the language default, whichever row holds the default
-- flag at the time. Sources created after this migration start with NULL.
--
-- The backfill copies every existing choice. An old value with no registry row
-- is left NULL, which resolves to the language default exactly as the code
-- resolved an unknown variant before.
--
-- Dual-write rule. The old columns and their CHECKs from 0021 stay. From this
-- release every settings write sets the key column and, when the style is one
-- the old CHECK allows, the old variant column too, so the previous release
-- can be redeployed and still read the merchant's latest choice. The rule ends
-- with the migration that drops the old columns, after the US-08-08 gate.
--
-- Rollback: deploy the previous release first. The two columns can then stay,
-- or be removed with ALTER TABLE "integrations" DROP COLUMN
-- "cod_template_ar_key", DROP COLUMN "cod_template_en_key". No choice is lost:
-- the old columns were kept in sync. A previous release writes the old columns
-- only, so before rolling forward again rerun the two UPDATE statements below
-- without their "IS NULL" condition.
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_ar_key" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_en_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_ar_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_ar_key_fkey" FOREIGN KEY ("cod_template_ar_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_en_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_en_key_fkey" FOREIGN KEY ("cod_template_en_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
UPDATE "integrations" AS i SET "cod_template_ar_key" = t."key" FROM "whatsapp_templates" AS t WHERE i."cod_template_ar_key" IS NULL AND t."purpose" = 'cod_confirmation' AND t."language" = 'ar' AND t."style" = i."cod_template_ar_variant";--> statement-breakpoint
UPDATE "integrations" AS i SET "cod_template_en_key" = t."key" FROM "whatsapp_templates" AS t WHERE i."cod_template_en_key" IS NULL AND t."purpose" = 'cod_confirmation' AND t."language" = 'en' AND t."style" = i."cod_template_en_variant";
