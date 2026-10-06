-- Reminder templates and Arabic style by country (US-08-07 a and d).
--
-- "whatsapp_templates" and "whatsapp_template_drafts" accept a second
-- purpose, 'cod_reminder': the template a reminder (the follow-up send)
-- carries. Staff create reminder templates through the US-08-06 flow; no row
-- is seeded here.
--
-- "integrations" gains:
--   * "cod_reminder_ar_key", "cod_reminder_en_key": the registry key of the
--     reminder the store chose per language. NULL means none was chosen, and
--     the reminder sends the store's first-send template, exactly as before.
--     The code only ever stores a 'cod_reminder' key here.
--   * "cod_template_ar_auto": the store chose 'auto' as its Arabic style, so
--     the style follows the customer's calling code. False for every store.
-- Nothing is read from these columns while WHATSAPP_REMINDER_TEMPLATE_ENABLED
-- and WHATSAPP_ARABIC_STYLE_AUTO_ENABLED are off.
--
-- "verification_message_dispatches"."template_fallback_reason" has no CHECK
-- (0056), so the new reasons 'reminder_unavailable' and
-- 'auto_style_unavailable' need no change.
--
-- Additive and safe to replay. No row is written.
--
-- Rollback: set both switches to false, which restores the previous sends.
-- To remove the schema too, deploy the previous release (it never reads these
-- columns) and then run:
--   ALTER TABLE "integrations" DROP COLUMN IF EXISTS "cod_reminder_ar_key",
--     DROP COLUMN IF EXISTS "cod_reminder_en_key",
--     DROP COLUMN IF EXISTS "cod_template_ar_auto";
--   DELETE FROM "whatsapp_template_drafts" WHERE "purpose" = 'cod_reminder';
--   DELETE FROM "whatsapp_templates" WHERE "purpose" = 'cod_reminder';
--   ALTER TABLE "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_purpose_check",
--     ADD CONSTRAINT "whatsapp_templates_purpose_check" CHECK ("purpose" IN ('cod_confirmation'));
--   ALTER TABLE "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_purpose_check",
--     ADD CONSTRAINT "whatsapp_template_drafts_purpose_check" CHECK ("purpose" IN ('cod_confirmation'));
-- The two DELETEs drop reminder templates staff created; keep them if the
-- rollback is only temporary, and skip the two constraint changes.
ALTER TABLE "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_purpose_check";--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_purpose_check" CHECK ("purpose" IN ('cod_confirmation', 'cod_reminder'));--> statement-breakpoint
ALTER TABLE "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_purpose_check";--> statement-breakpoint
ALTER TABLE "whatsapp_template_drafts" ADD CONSTRAINT "whatsapp_template_drafts_purpose_check" CHECK ("purpose" IN ('cod_confirmation', 'cod_reminder'));--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_ar_key" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_en_key" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_ar_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_ar_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_ar_key_fkey" FOREIGN KEY ("cod_reminder_ar_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_en_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_en_key_fkey" FOREIGN KEY ("cod_reminder_en_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;
