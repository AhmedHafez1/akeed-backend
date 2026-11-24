-- Shipping notifications: the Shipped message, its quick replies and its
-- thank-you.
--
-- * Two dispatch kinds: "shipping_shipped" (the Shipped template, charged
--   like a reminder under the confirmation reserve) and
--   "shipping_acknowledgment" (the thank-you after a tap). Neither ever
--   changes a verification's own status.
-- * Template purpose "shipping_shipped" for registry rows and drafts, and
--   dispatch template purpose "shipping".
-- * The registry rows for all six languages are seeded with review status
--   "pending": nothing sends them until a sync reads them approved at the
--   provider.
-- * Free-form text purpose "ack_shipping", seeded in every language.
-- * The shipping record keeps the customer's first tap, and when the
--   merchant dealt with what it asks of them: a reschedule or address
--   request, or a message that could not reach the customer.
--
-- Rollback: deploy the previous release. The enum values cannot be dropped and
-- are unused by it. Optionally run:
--   DELETE FROM "whatsapp_templates" WHERE "purpose" = 'shipping_shipped';
--   DELETE FROM "whatsapp_message_texts" WHERE "purpose" = 'ack_shipping';
--   ALTER TABLE "verification_shipping_notifications" DROP COLUMN IF EXISTS "needs_action_resolved_by", DROP COLUMN IF EXISTS "needs_action_resolved_at", DROP COLUMN IF EXISTS "customer_replied_at";

ALTER TYPE verification_dispatch_kind ADD VALUE IF NOT EXISTS 'shipping_shipped';
--> statement-breakpoint
ALTER TYPE verification_dispatch_kind ADD VALUE IF NOT EXISTS 'shipping_acknowledgment';
--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_templates" DROP CONSTRAINT IF EXISTS "whatsapp_templates_purpose_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_purpose_check" CHECK ("purpose" IN ('cod_confirmation', 'cod_reminder', 'shipping_shipped'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_purpose_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_template_drafts" ADD CONSTRAINT "whatsapp_template_drafts_purpose_check" CHECK ("purpose" IN ('cod_confirmation', 'cod_reminder', 'shipping_shipped'));--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" DROP CONSTRAINT IF EXISTS "dispatch_template_purpose_check";--> statement-breakpoint
ALTER TABLE "verification_message_dispatches" ADD CONSTRAINT "dispatch_template_purpose_check" CHECK ("template_purpose" IS NULL OR "template_purpose" IN ('initial', 'reminder', 'test', 'shipping'));--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" DROP CONSTRAINT IF EXISTS "verification_service_messages_kind_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "verification_service_messages" ADD CONSTRAINT "verification_service_messages_kind_check" CHECK ("kind" IN ('acknowledgment', 'nudge', 'shipping_acknowledgment'));--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" DROP CONSTRAINT IF EXISTS "whatsapp_message_texts_purpose_check";--> statement-breakpoint
ALTER TABLE IF EXISTS "whatsapp_message_texts" ADD CONSTRAINT "whatsapp_message_texts_purpose_check" CHECK ("purpose" IN ('ack_confirmed', 'ack_canceled', 'unresolved_reply_nudge', 'fallback_customer_name', 'fallback_store_name', 'ack_shipping'));--> statement-breakpoint

ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "customer_replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "needs_action_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "needs_action_resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_reply_check";--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_reply_check" CHECK (("customer_reply" IS NULL) = ("customer_replied_at" IS NULL) AND ("customer_reply" IS NULL OR "customer_reply" IN ('home', 'reschedule', 'address')));--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_resolution_check";--> statement-breakpoint
ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_resolution_check" CHECK ("needs_action_resolved_at" IS NULL OR "customer_reply" IN ('reschedule', 'address') OR ("status" = 'failed' AND "reason_code" IN ('no_phone', 'not_on_whatsapp')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shipping_notifications_needs_action" ON "verification_shipping_notifications" USING btree ("org_id", "verification_id") WHERE "needs_action_resolved_at" IS NULL AND ("customer_reply" IN ('reschedule', 'address') OR ("status" = 'failed' AND "reason_code" IN ('no_phone', 'not_on_whatsapp')));--> statement-breakpoint

DO $$ BEGIN
  IF to_regclass('whatsapp_templates') IS NOT NULL THEN
    INSERT INTO "whatsapp_templates" ("key", "purpose", "language", "style", "meta_template_name", "meta_language_code", "parameter_format", "variable_mapping", "preview", "review_status", "category", "is_active", "is_default", "sort_order") VALUES
      ('shipping_shipped.ar.default', 'shipping_shipped', 'ar', 'default', 'akeed_shipping_shipped_default_v1', 'ar', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"مرحبًا {{customer}}،","body":"تم شحن طلبك رقم {{order}} من {{store}}.\n{{tracking}}","totalLabel":"","ending":"إذا احتجت أي تعديل قبل التسليم، اختر من الأزرار أدناه.","confirmButton":"سأكون في المنزل","cancelButton":"تغيير الموعد","changeButton":"تغيير العنوان"}$json$::jsonb, 'pending', 'utility', true, true, 1),
      ('shipping_shipped.en.default', 'shipping_shipped', 'en', 'default', 'akeed_shipping_shipped_default_v1', 'en', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"Hello {{customer}},","body":"Your order {{order}} from {{store}} has been shipped.\n{{tracking}}","totalLabel":"","ending":"If you need a change before delivery, choose an option below.","confirmButton":"I'll be home","cancelButton":"Reschedule","changeButton":"Change address"}$json$::jsonb, 'pending', 'utility', true, true, 1),
      ('shipping_shipped.ur.default', 'shipping_shipped', 'ur', 'default', 'akeed_shipping_shipped_default_v1', 'ur', 'named', $json$[{"key":"customer","name":"customer"},{"key":"store","name":"store"},{"key":"order","name":"order"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"السلام علیکم {{customer}}،","body":"{{store}} سے آپ کا آرڈر {{order}} روانہ کر دیا گیا ہے۔\n{{tracking}}","totalLabel":"","ending":"ڈیلیوری سے پہلے کسی تبدیلی کے لیے نیچے سے انتخاب کریں۔","confirmButton":"میں گھر پر موجود ہوں","cancelButton":"وقت تبدیل کریں","changeButton":"پتہ تبدیل کریں"}$json$::jsonb, 'pending', 'utility', true, true, 1),
      ('shipping_shipped.es.default', 'shipping_shipped', 'es', 'default', 'akeed_shipping_shipped_default_v1', 'es', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"Hola, {{customer}}:","body":"Tu pedido {{order}} de {{store}} ya fue enviado.\n{{tracking}}","totalLabel":"","ending":"Si necesitas algún cambio antes de la entrega, elige una opción abajo.","confirmButton":"Estaré en casa","cancelButton":"Reprogramar","changeButton":"Cambiar dirección"}$json$::jsonb, 'pending', 'utility', true, true, 1),
      ('shipping_shipped.fr.default', 'shipping_shipped', 'fr', 'default', 'akeed_shipping_shipped_default_v1', 'fr', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"Bonjour {{customer}},","body":"Votre commande {{order}} de {{store}} a été expédiée.\n{{tracking}}","totalLabel":"","ending":"Si vous avez besoin d'un changement avant la livraison, choisissez une option ci-dessous.","confirmButton":"Je serai chez moi","cancelButton":"Reprogrammer","changeButton":"Changer d'adresse"}$json$::jsonb, 'pending', 'utility', true, true, 1),
      ('shipping_shipped.tr.default', 'shipping_shipped', 'tr', 'default', 'akeed_shipping_shipped_default_v1', 'tr', 'named', $json$[{"key":"customer","name":"customer"},{"key":"store","name":"store"},{"key":"order","name":"order"},{"key":"tracking","name":"tracking"}]$json$::jsonb, $json${"greeting":"Merhaba {{customer}},","body":"{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz kargoya verildi.\n{{tracking}}","totalLabel":"","ending":"Teslimattan önce bir değişiklik gerekiyorsa aşağıdaki seçeneklerden birini seçin.","confirmButton":"Evde olacağım","cancelButton":"Yeniden planla","changeButton":"Adresi değiştir"}$json$::jsonb, 'pending', 'utility', true, true, 1)
    ON CONFLICT ("key") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_message_texts') IS NOT NULL THEN
    INSERT INTO "whatsapp_message_texts" ("purpose", "language", "style", "body", "is_active", "updated_by") VALUES
      ('ack_shipping', 'ar', 'default', 'شكرًا لك، وصل طلبك بخصوص الطلب {{order}} إلى {{store}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_shipping', 'en', 'default', 'Thank you, {{store}} has received your request for order {{order}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_shipping', 'ur', 'default', 'شکریہ، {{store}} کو آرڈر {{order}} کے بارے میں آپ کی درخواست مل گئی ہے۔', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_shipping', 'es', 'default', 'Gracias, {{store}} recibió tu solicitud sobre el pedido {{order}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_shipping', 'fr', 'default', 'Merci, {{store}} a bien reçu votre demande concernant la commande {{order}}.', true, '00000000-0000-0000-0000-000000000000'),
      ('ack_shipping', 'tr', 'default', 'Teşekkürler, {{store}} {{order}} numaralı siparişinizle ilgili talebinizi aldı.', true, '00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
