-- Urdu, Spanish and French as WhatsApp message languages.
--
-- Every table that names a message language accepts 'ur', 'es' and 'fr' next
-- to 'ar' and 'en': "whatsapp_templates", "whatsapp_template_drafts",
-- "whatsapp_message_texts", "verification_service_messages" and the resolved
-- language of "verification_message_dispatches". The store's message language,
-- "integrations"."default_language", accepts the three new values too.
--
-- "integrations" gains the store's choice per new language:
--   * "cod_template_ur_key", "cod_template_es_key", "cod_template_fr_key":
--     the first message.
--   * "cod_reminder_ur_key", "cod_reminder_es_key", "cod_reminder_fr_key":
--     the reminder. NULL sends the first message, as in Arabic and English.
-- All six are NULL for every store, and NULL reads as the language default.
-- These languages have no old variant column.
--
-- Nine rows are written to "whatsapp_template_drafts": a standard and a short
-- confirmation and one reminder for each new language, in state 'draft'. A
-- draft is not a template: it has no row in "whatsapp_templates", so no send,
-- no store setting and no sync can read it. Staff submit each draft to the
-- provider, and activate the template only after the provider approves it.
-- The text is the same as STARTER_TEMPLATE_DRAFTS in
-- src/shared/messaging/starter-template-drafts.ts. "created_by" is the nil
-- UUID, because no person wrote them. A draft that already holds one of
-- these keys or names is left as it is.
--
-- Fifteen rows are written to "whatsapp_message_texts", five for each new
-- language: the acknowledgment after a customer confirms or cancels, the
-- nudge after a reply Akeed could not read, and the words used when a
-- customer or store name is missing. They are active, style 'default', and
-- the same as STARTER_MESSAGE_TEXTS in
-- src/shared/messaging/starter-message-texts.ts. A free-form text is not a
-- provider template and needs no approval; it is read only for a customer
-- whose message went out in that language. A text staff already wrote for the
-- same purpose and language is left as it is. Arabic and English texts are
-- not touched.
--
-- Until a new language has an active default template, a store cannot be set
-- to it and 'auto' never chooses it, so Arabic and English sends do not
-- change.
--
-- Additive and safe to replay. A table or type that is missing is skipped, so
-- the file also runs on the partial schemas the contract suites build.
--
-- Rollback: deploy the previous release. It never offers the new languages,
-- so first set any store back with
--   UPDATE "integrations" SET "default_language" = 'auto'
--     WHERE "default_language" IN ('ur', 'es', 'fr');
-- To remove the schema too, delete the drafts, templates and message texts of
-- the three languages, drop the six "integrations" columns and put the five CHECKs back
-- to IN ('ar', 'en'). PostgreSQL cannot drop a value from an enum type; the
-- three unused values of "integration_default_language" may stay.
ALTER TABLE IF EXISTS "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" ADD CONSTRAINT "whatsapp_template_drafts_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" DROP CONSTRAINT IF EXISTS "whatsapp_message_texts_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" ADD CONSTRAINT "whatsapp_message_texts_language_check" CHECK ("language" IN ('ar', 'en', 'ur', 'es', 'fr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" DROP CONSTRAINT IF EXISTS "verification_service_messages_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" ADD CONSTRAINT "verification_service_messages_language_check" CHECK ("language" IS NULL OR "language" IN ('ar', 'en', 'ur', 'es', 'fr'));--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_resolved_language_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_message_dispatches" ADD CONSTRAINT "dispatch_resolved_language_check" CHECK ("resolved_language" IS NULL OR "resolved_language" IN ('ar', 'en', 'ur', 'es', 'fr'));--> statement-breakpoint
DO $$ BEGIN
  IF to_regtype('integration_default_language') IS NOT NULL THEN
    ALTER TYPE "integration_default_language" ADD VALUE IF NOT EXISTS 'ur';
    ALTER TYPE "integration_default_language" ADD VALUE IF NOT EXISTS 'es';
    ALTER TYPE "integration_default_language" ADD VALUE IF NOT EXISTS 'fr';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_ur_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_ur_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_ur_key_fkey" FOREIGN KEY ("cod_template_ur_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_es_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_es_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_es_key_fkey" FOREIGN KEY ("cod_template_es_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_template_fr_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_template_fr_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_fr_key_fkey" FOREIGN KEY ("cod_template_fr_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_ur_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_ur_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_ur_key_fkey" FOREIGN KEY ("cod_reminder_ur_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_es_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_es_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_es_key_fkey" FOREIGN KEY ("cod_reminder_es_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "cod_reminder_fr_key" text;--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_cod_reminder_fr_key_fkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_reminder_fr_key_fkey" FOREIGN KEY ("cod_reminder_fr_key") REFERENCES "whatsapp_templates"("key") ON UPDATE CASCADE;--> statement-breakpoint
INSERT INTO "whatsapp_template_drafts" ("key", "purpose", "language", "style", "version", "meta_template_name", "meta_language_code", "parameter_format", "category", "body", "confirm_label", "cancel_label", "samples", "created_by", "updated_by") VALUES
  ('cod_confirm.ur.standard_v1', 'cod_confirmation', 'ur', 'standard', 1, 'akeed_cod_confirm_standard_v1', 'ur', 'named', 'utility', E'السلام علیکم {{customer}}،\n{{store}} پر آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔\nبراہِ کرم اپنے آرڈر کی تصدیق کریں۔', 'آرڈر کی تصدیق کریں', 'آرڈر منسوخ کریں', '{"customer":"احمد","store":"اکید اسٹور","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.ur.short_v1', 'cod_confirmation', 'ur', 'short', 1, 'akeed_cod_confirm_short_v1', 'ur', 'named', 'utility', E'آپ کا آرڈر {{order}} موصول ہو گیا ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔ براہِ کرم تصدیق کریں۔', 'تصدیق کریں', 'منسوخ کریں', '{"order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_reminder.ur.standard_v1', 'cod_reminder', 'ur', 'standard', 1, 'akeed_cod_reminder_standard_v1', 'ur', 'named', 'utility', E'السلام علیکم {{customer}}،\n{{store}} پر آپ کا آرڈر {{order}} ابھی آپ کی تصدیق کا منتظر ہے۔ کل رقم {{total}} ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔\nتصدیق کر دیں تاکہ ہم آپ کا آرڈر روانہ کر سکیں۔', 'آرڈر کی تصدیق کریں', 'آرڈر منسوخ کریں', '{"customer":"احمد","store":"اکید اسٹور","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.es.standard_v1', 'cod_confirmation', 'es', 'standard', 1, 'akeed_cod_confirm_standard_v1', 'es', 'named', 'utility', E'Hola, {{customer}}:\nHemos recibido tu pedido {{order}} en {{store}}. El total es de {{total}} y lo pagas al recibirlo.\nPor favor, confirma tu pedido.', 'Confirmar pedido', 'Cancelar pedido', '{"customer":"Carlos","store":"Tienda Akeed","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.es.short_v1', 'cod_confirmation', 'es', 'short', 1, 'akeed_cod_confirm_short_v1', 'es', 'named', 'utility', E'Hemos recibido tu pedido {{order}}. El total es de {{total}} y lo pagas al recibirlo. Por favor, confírmalo.', 'Confirmar', 'Cancelar', '{"order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_reminder.es.standard_v1', 'cod_reminder', 'es', 'standard', 1, 'akeed_cod_reminder_standard_v1', 'es', 'named', 'utility', E'Hola, {{customer}}:\nTu pedido {{order}} en {{store}} sigue pendiente de confirmación. El total es de {{total}} y lo pagas al recibirlo.\nConfírmalo para que podamos enviártelo.', 'Confirmar pedido', 'Cancelar pedido', '{"customer":"Carlos","store":"Tienda Akeed","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.fr.standard_v1', 'cod_confirmation', 'fr', 'standard', 1, 'akeed_cod_confirm_standard_v1', 'fr', 'named', 'utility', E'Bonjour {{customer}},\nNous avons bien reçu votre commande {{order}} sur {{store}}. Le total est de {{total}}, à payer à la livraison.\nMerci de confirmer votre commande.', 'Confirmer la commande', 'Annuler la commande', '{"customer":"Camille","store":"Boutique Akeed","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_confirm.fr.short_v1', 'cod_confirmation', 'fr', 'short', 1, 'akeed_cod_confirm_short_v1', 'fr', 'named', 'utility', E'Nous avons bien reçu votre commande {{order}}. Le total est de {{total}}, à payer à la livraison. Merci de la confirmer.', 'Confirmer', 'Annuler', '{"order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
  ('cod_reminder.fr.standard_v1', 'cod_reminder', 'fr', 'standard', 1, 'akeed_cod_reminder_standard_v1', 'fr', 'named', 'utility', E'Bonjour {{customer}},\nVotre commande {{order}} sur {{store}} attend toujours votre confirmation. Le total est de {{total}}, à payer à la livraison.\nConfirmez-la pour que nous puissions vous l''expédier.', 'Confirmer la commande', 'Annuler la commande', '{"customer":"Camille","store":"Boutique Akeed","order":"TEST-1","total":"250.00 USD"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_message_texts') IS NOT NULL THEN
    INSERT INTO "whatsapp_message_texts" ("purpose", "language", "style", "body", "is_active", "updated_by") VALUES
      ('ack_confirmed', 'ur', 'default', 'شکریہ! {{store}} پر آپ کا آرڈر {{order}} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_canceled', 'ur', 'default', 'آپ کا آرڈر {{order}} منسوخ کر دیا گیا ہے۔ {{store}} کو آگاہ کرنے کا شکریہ۔', true, '00000000-0000-0000-0000-000000000000'),
      ('unresolved_reply_nudge', 'ur', 'default', 'معذرت، ہم آپ کا جواب نہیں سمجھ سکے۔ براہِ کرم اوپر والے پیغام کے بٹن سے اپنے آرڈر کی تصدیق یا منسوخی کریں۔', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_customer_name', 'ur', 'default', 'محترم صارف', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_store_name', 'ur', 'default', 'ہمارے اسٹور', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_confirmed', 'es', 'default', '¡Gracias! Tu pedido {{order}} en {{store}} está confirmado y pronto estará en camino.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_canceled', 'es', 'default', 'Tu pedido {{order}} ha sido cancelado. Gracias por avisar a {{store}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('unresolved_reply_nudge', 'es', 'default', 'Disculpa, no hemos entendido tu respuesta. Usa los botones del mensaje anterior para confirmar o cancelar tu pedido.', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_customer_name', 'es', 'default', 'estimado cliente', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_store_name', 'es', 'default', 'nuestra tienda', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_confirmed', 'fr', 'default', 'Merci, votre commande {{order}} sur {{store}} est bien confirmée. Elle sera expédiée très bientôt.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_canceled', 'fr', 'default', 'Votre commande {{order}} a bien été annulée. Merci d''avoir prévenu {{store}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('unresolved_reply_nudge', 'fr', 'default', 'Désolé, nous n''avons pas compris votre réponse. Utilisez les boutons du message précédent pour confirmer ou annuler votre commande.', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_customer_name', 'fr', 'default', 'cher client', true, '00000000-0000-0000-0000-000000000000'),
      ('fallback_store_name', 'fr', 'default', 'notre boutique', true, '00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
