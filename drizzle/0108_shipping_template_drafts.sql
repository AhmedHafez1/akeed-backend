-- The Shipped message templates become drafts that staff review and submit.
--
-- 0107 seeded the six Shipped templates as registry rows. A registry row is a
-- template the provider already holds, so the admin page showed them as in
-- review, the next sync marked them missing, and no screen could submit them.
-- This removes those rows, but only while the provider has never held them (no
-- provider template id and not approved), and seeds the same templates as
-- drafts, as 0064 and 0068 did for their languages. Staff submit each draft,
-- activate it once the provider approves it, and make it the default.
--
-- The drafts carry the refreshed text: the order is on its way, have the total
-- ready in cash, keep the phone on for the courier, and three replies in the
-- fixed order the code reads (receive it, not available, change address).
-- The thank-you text is updated only where it still holds 0107's wording.
--
-- Rollback: deploy the previous release. The drafts are inert until staff
-- submit them; delete them with
--   DELETE FROM "whatsapp_template_drafts"
--     WHERE "purpose" = 'shipping_shipped' AND "state" = 'draft';
DO $$ BEGIN
  IF to_regclass('whatsapp_templates') IS NOT NULL THEN
    DELETE FROM "whatsapp_templates"
    WHERE "purpose" = 'shipping_shipped'
      AND "key" IN ('shipping_shipped.ar.default', 'shipping_shipped.en.default', 'shipping_shipped.ur.default', 'shipping_shipped.es.default', 'shipping_shipped.fr.default', 'shipping_shipped.tr.default')
      AND "meta_template_id" IS NULL
      AND "review_status" IS DISTINCT FROM 'approved';
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_template_drafts') IS NOT NULL THEN
    INSERT INTO "whatsapp_template_drafts" ("key", "purpose", "language", "style", "version", "meta_template_name", "meta_language_code", "parameter_format", "category", "body", "confirm_label", "cancel_label", "change_label", "samples", "created_by", "updated_by") VALUES
      ('shipping_shipped.ar.default_v1', 'shipping_shipped', 'ar', 'default', 1, 'akeed_shipping_shipped_default_v1', 'ar', 'named', 'utility', E'مرحبًا {{customer}}،\nطلبك رقم {{order}} من {{store}} في الطريق إليك 🚚\n{{tracking}}\nمن فضلك جهّز مبلغ {{total}} نقدًا، وخلّي موبايلك متاح عشان المندوب يقدر يوصلك.\nلو مش هتكون موجود أو محتاج تغيّر العنوان، اختار من الأزرار تحت عشان المتجر يرتّب ده قبل التوصيل.', 'تمام، هستلمه', 'مش هكون موجود', 'تغيير العنوان', '{"customer":"أحمد","order":"TEST-1","store":"متجر أكيد","total":"250.00 EGP","tracking":"للتتبع: 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
      ('shipping_shipped.en.default_v1', 'shipping_shipped', 'en', 'default', 1, 'akeed_shipping_shipped_default_v1', 'en', 'named', 'utility', E'Hello {{customer}},\nYour order {{order}} from {{store}} is on its way 🚚\n{{tracking}}\nPlease have {{total}} ready in cash and keep your phone on so the courier can reach you.\nWon''t be available or need a different address? Tap a button below so the store can sort it out before delivery.', 'I''ll receive it', 'Won''t be available', 'Change address', '{"customer":"Ahmed","order":"TEST-1","store":"Akeed Store","total":"250.00 EGP","tracking":"Tracking: 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
      ('shipping_shipped.ur.default_v1', 'shipping_shipped', 'ur', 'default', 1, 'akeed_shipping_shipped_default_v1', 'ur', 'named', 'utility', E'السلام علیکم {{customer}}،\n{{store}} سے آپ کا آرڈر {{order}} روانہ ہو چکا ہے 🚚\n{{tracking}}\nبراہِ کرم {{total}} نقد تیار رکھیں اور اپنا فون آن رکھیں تاکہ کورئیر آپ سے رابطہ کر سکے۔\nاگر آپ موجود نہیں ہوں گے یا پتہ بدلنا ہے تو نیچے بٹن دبائیں تاکہ اسٹور ڈیلیوری سے پہلے انتظام کر سکے۔', 'ٹھیک ہے، وصول کر لیں گے', 'اس وقت دستیاب نہیں', 'پتہ تبدیل کریں', '{"customer":"احمد","order":"TEST-1","store":"اکید اسٹور","total":"250.00 EGP","tracking":"ٹریکنگ: 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
      ('shipping_shipped.es.default_v1', 'shipping_shipped', 'es', 'default', 1, 'akeed_shipping_shipped_default_v1', 'es', 'named', 'utility', E'Hola, {{customer}}:\nTu pedido {{order}} de {{store}} ya va en camino 🚚\n{{tracking}}\nTen listos {{total}} en efectivo y mantén tu teléfono encendido para que el repartidor pueda contactarte.\n¿No estarás disponible o necesitas otra dirección? Toca un botón abajo para que la tienda lo resuelva antes de la entrega.', 'Lo recibiré', 'No estaré disponible', 'Cambiar dirección', '{"customer":"Ahmed","order":"TEST-1","store":"Tienda Akeed","total":"250.00 EGP","tracking":"Seguimiento: 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
      ('shipping_shipped.fr.default_v1', 'shipping_shipped', 'fr', 'default', 1, 'akeed_shipping_shipped_default_v1', 'fr', 'named', 'utility', E'Bonjour {{customer}},\nVotre commande {{order}} de {{store}} est en route 🚚\n{{tracking}}\nMerci de préparer {{total}} en espèces et de garder votre téléphone allumé pour que le livreur puisse vous joindre.\nAbsent(e) ou besoin de changer d''adresse ? Appuyez sur un bouton ci-dessous pour que la boutique s''en occupe avant la livraison.', 'Je la recevrai', 'Je serai absent(e)', 'Changer d''adresse', '{"customer":"Ahmed","order":"TEST-1","store":"Boutique Akeed","total":"250.00 EGP","tracking":"Suivi : 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'),
      ('shipping_shipped.tr.default_v1', 'shipping_shipped', 'tr', 'default', 1, 'akeed_shipping_shipped_default_v1', 'tr', 'named', 'utility', E'Merhaba {{customer}},\n{{store}} üzerinden verdiğiniz {{order}} numaralı siparişiniz yola çıktı 🚚\n{{tracking}}\nLütfen {{total}} tutarını nakit olarak hazır bulundurun ve kuryenin size ulaşabilmesi için telefonunuzu açık tutun.\nTeslimatta orada olmayacaksanız veya adresi değiştirmeniz gerekiyorsa, mağazanın teslimattan önce ayarlayabilmesi için aşağıdaki düğmelerden birine dokunun.', 'Teslim alacağım', 'Müsait olmayacağım', 'Adresi değiştir', '{"customer":"Ayşe","order":"TEST-1","store":"Akeed Mağazası","total":"250.00 EGP","tracking":"Kargo takibi: 1Z999AA10123456784"}'::jsonb, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_message_texts') IS NOT NULL THEN
    UPDATE "whatsapp_message_texts" AS t SET "body" = v.next_body, "updated_at" = now()
    FROM (VALUES
      ('ar', 'شكرًا لك، وصل طلبك بخصوص الطلب {{order}} إلى {{store}}.', 'شكرًا لك، تم إبلاغ {{store}} بخصوص طلبك رقم {{order}}.'),
      ('en', 'Thank you, {{store}} has received your request for order {{order}}.', 'Thank you. We''ve let {{store}} know about your order {{order}}.'),
      ('ur', 'شکریہ، {{store}} کو آرڈر {{order}} کے بارے میں آپ کی درخواست مل گئی ہے۔', 'شکریہ، ہم نے {{store}} کو آپ کے آرڈر {{order}} کے بارے میں آگاہ کر دیا ہے۔'),
      ('es', 'Gracias, {{store}} recibió tu solicitud sobre el pedido {{order}}.', 'Gracias. Ya avisamos a {{store}} sobre tu pedido {{order}}.'),
      ('fr', 'Merci, {{store}} a bien reçu votre demande concernant la commande {{order}}.', 'Merci. Nous avons informé {{store}} au sujet de votre commande {{order}}.'),
      ('tr', 'Teşekkürler, {{store}} {{order}} numaralı siparişinizle ilgili talebinizi aldı.', 'Teşekkürler. {{order}} numaralı siparişinizle ilgili {{store}} bilgilendirildi.')
    ) AS v(language, previous_body, next_body)
    WHERE t."purpose" = 'ack_shipping' AND t."style" = 'default' AND t."language" = v.language AND t."body" = v.previous_body;
  END IF;
END $$;
