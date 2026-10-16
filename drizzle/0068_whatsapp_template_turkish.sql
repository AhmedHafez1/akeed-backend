-- Turkish as a WhatsApp message language.
--
-- Every table that names a message language accepts 'tr' next to 'ar', 'en',
-- 'ur', 'es' and 'fr': "whatsapp_templates", "whatsapp_template_drafts",
-- "whatsapp_message_texts", "verification_service_messages" and the resolved
-- language of "verification_message_dispatches". The store's message language,
-- "integrations"."default_language", accepts 'tr' too.
--
-- "integrations" gains the store's choice for Turkish:
--   * "cod_template_tr_key": the first message.
--   * "cod_reminder_tr_key": the reminder. NULL sends the first message, as in
--     the other languages.
-- Both are NULL for every store, and NULL reads as the language default.
-- Turkish has no old variant column.
--
-- Three rows are written to "whatsapp_template_drafts": a standard and a
-- short confirmation and one reminder, in state 'draft'. A draft is not a
-- template: it has no row in "whatsapp_templates", so no send, no store
-- setting and no sync can read it. Staff submit each draft to the provider,
-- and activate the template only after the provider approves it. The text is
-- the same as STARTER_TEMPLATE_DRAFTS in
-- src/shared/messaging/starter-template-drafts.ts. "created_by" is the nil
-- UUID, because no person wrote them. A draft that already holds one of these
-- keys or names is left as it is.
--
-- Five rows are written to "whatsapp_message_texts": the acknowledgment after
-- a customer confirms or cancels, the nudge after a reply Akeed could not
-- read, and the words used when a customer or store name is missing. They are
-- active, style 'default', and the same as STARTER_MESSAGE_TEXTS in
-- src/shared/messaging/starter-message-texts.ts. A free-form text is not a
-- provider template and needs no approval; it is read only for a customer
-- whose message went out in Turkish. A text staff already wrote for the same
-- purpose and language is left as it is. Other languages are not touched.
--
-- Until Turkish has an active default template, a store cannot be set to it
-- and 'auto' never chooses it for a +90 number, so no send changes.
--
-- Additive and safe to replay. A table or type that is missing is skipped, so
-- the file also runs on the partial schemas the contract suites build.
--
-- Rollback: deploy the previous release. It never offers Turkish, so first
-- set any store back with
--   UPDATE "integrations" SET "default_language" = 'auto'
--     WHERE "default_language" = 'tr';
-- To remove the schema too, delete the Turkish drafts, templates and message
-- texts, drop the two "integrations" columns and put the five CHECKs back to
-- IN ('ar', 'en', 'ur', 'es', 'fr'). PostgreSQL cannot drop a value from an
-- enum type; the unused 'tr' value of "integration_default_language" may stay.
ALTER TABLE IF EXISTS "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" ADD CONSTRAINT "whatsapp_template_drafts_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" DROP CONSTRAINT IF EXISTS "whatsapp_message_texts_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" ADD CONSTRAINT "whatsapp_message_texts_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" DROP CONSTRAINT IF EXISTS "verification_service_messages_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" ADD CONSTRAINT "verification_service_messages_language_check" CHECK ("language" IS NULL OR "language" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_resolved_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_message_dispatches" ADD CONSTRAINT "dispatch_resolved_language_check" CHECK ("resolved_language" IS NULL OR "resolved_language" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr'));--> statement-breakpoint
DO $$ BEGIN
  IF to_regtype('integration_default_language') IS NOT NULL THEN
    ALTER TYPE "integration_default_language" ADD VALUE IF NOT EXISTS 'tr';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_tr_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_tr_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_tr_key_fkey" FOREIGN KEY ("cod_template_tr_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_tr_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_tr_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_tr_key_fkey" FOREIGN KEY ("cod_reminder_tr_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
INSERT INTO "whatsapp_template_drafts" ("key", "purpose", "language", "style", "version", "meta_template_name", "meta_language_code", "parameter_format", "category", "body", "confirm_label", "cancel_label", "samples", "created_by", "updated_by") VALUES
  ('cod_confirm.tr.standard_v1', 'cod_confirmation', 'tr', 'standard', 1, 'akeed_cod_confirm_standard_v1', 'tr', 'named', 'utility', E'Merhaba {{customer}},\n{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz alındı. Toplam tutar {{total}}; ödeme kapıda yapılacaktır.\nLütfen siparişinizi onaylayın.', 'Siparişi onayla', 'Siparişi iptal et', '{"customer":"Ayşe","store":"Akeed Mağazası","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.tr.short_v1', 'cod_confirmation', 'tr', 'short', 1, 'akeed_cod_confirm_short_v1', 'tr', 'named', 'utility', E'Merhaba, {{order}} numaralı siparişiniz alındı. Toplam tutar {{total}}; ödeme kapıda yapılacaktır. Lütfen onaylayın.', 'Onayla', 'İptal et', '{"order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_reminder.tr.standard_v1', 'cod_reminder', 'tr', 'standard', 1, 'akeed_cod_reminder_standard_v1', 'tr', 'named', 'utility', E'Merhaba {{customer}},\n{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz hâlâ onayınızı bekliyor. Toplam tutar {{total}}; ödeme kapıda yapılacaktır.\nSiparişinizi gönderebilmemiz için lütfen onaylayın.', 'Siparişi onayla', 'Siparişi iptal et', '{"customer":"Ayşe","store":"Akeed Mağazası","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_message_texts') IS NOT NULL THEN
    INSERT INTO "whatsapp_message_texts" ("purpose", "language", "style", "body", "is_active", "updated_by") VALUES
      ('ack_confirmed', 'tr', 'default', 'Teşekkürler! {{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz onaylandı ve kısa süre içinde yola çıkacak.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_canceled', 'tr', 'default', '{{order}} numaralı siparişiniz iptal edildi. Bilgilendirdiğiniz için {{store}} adına teşekkür ederiz.', true, '00000000-0000-0000-0000-000000000000'),
      ('unresolved_reply_nudge', 'tr', 'default', 'Üzgünüz, yanıtınızı anlayamadık. Siparişinizi onaylamak veya iptal etmek için lütfen yukarıdaki mesajdaki düğmeleri kullanın.', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_customer_name', 'tr', 'default', 'değerli müşterimiz', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_store_name', 'tr', 'default', 'mağazamız', true, '00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
