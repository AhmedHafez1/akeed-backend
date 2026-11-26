-- The Shipped message gets a Track order link button.
--
-- Each shipping record keeps the carrier name Shopify sends, a random code for
-- its short link, the kind of link the code opens (recorded once, at the first
-- send) and the first time the link was opened. The code is unique, so a
-- public lookup by code is one index probe.
--
-- The six Shipped drafts get their link label, but only while they are still
-- unsubmitted drafts: a draft staff already submitted keeps the text the
-- provider holds.
--
-- Rollback: deploy the previous release. The columns are inert without it;
-- drop them with
--   ALTER TABLE "verification_shipping_notifications"
--     DROP COLUMN IF EXISTS "tracking_company", DROP COLUMN IF EXISTS "tracking_code",
--     DROP COLUMN IF EXISTS "tracking_link_kind", DROP COLUMN IF EXISTS "tracking_opened_at";
--   ALTER TABLE "whatsapp_template_drafts" DROP COLUMN IF EXISTS "link_label";
DO $$ BEGIN
  IF to_regclass('verification_shipping_notifications') IS NOT NULL THEN
    ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "tracking_company" text;
    ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "tracking_code" text;
    ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "tracking_link_kind" text;
    ALTER TABLE "verification_shipping_notifications" ADD COLUMN IF NOT EXISTS "tracking_opened_at" timestamp with time zone;
    ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_tracking_company_check";
    ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_tracking_company_check" CHECK ("tracking_company" IS NULL OR char_length("tracking_company") BETWEEN 1 AND 100);
    ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_tracking_code_check";
    ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_tracking_code_check" CHECK ("tracking_code" IS NULL OR "tracking_code" ~ '^[A-Za-z0-9_-]{22,43}$');
    ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_tracking_link_kind_check";
    ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_tracking_link_kind_check" CHECK ("tracking_link_kind" IS NULL OR "tracking_link_kind" IN ('carrier_link', 'courier_page', 'number_only', 'none'));
    ALTER TABLE "verification_shipping_notifications" DROP CONSTRAINT IF EXISTS "verification_shipping_notifications_tracking_code_key";
    ALTER TABLE "verification_shipping_notifications" ADD CONSTRAINT "verification_shipping_notifications_tracking_code_key" UNIQUE ("tracking_code");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('whatsapp_template_drafts') IS NOT NULL THEN
    ALTER TABLE "whatsapp_template_drafts" ADD COLUMN IF NOT EXISTS "link_label" text;
    ALTER TABLE "whatsapp_template_drafts" DROP CONSTRAINT IF EXISTS "whatsapp_template_drafts_link_label_check";
    ALTER TABLE "whatsapp_template_drafts" ADD CONSTRAINT "whatsapp_template_drafts_link_label_check" CHECK ("link_label" IS NULL OR char_length("link_label") BETWEEN 1 AND 25);
    UPDATE "whatsapp_template_drafts" AS d SET "link_label" = v.label, "updated_at" = now()
    FROM (VALUES
      ('shipping_shipped.ar.default_v1', 'تتبع الطلب'),
      ('shipping_shipped.en.default_v1', 'Track order'),
      ('shipping_shipped.ur.default_v1', 'آرڈر ٹریک کریں'),
      ('shipping_shipped.es.default_v1', 'Rastrear pedido'),
      ('shipping_shipped.fr.default_v1', 'Suivre la commande'),
      ('shipping_shipped.tr.default_v1', 'Siparişi takip et')
    ) AS v(key, label)
    WHERE d."key" = v.key
      AND d."purpose" = 'shipping_shipped'
      AND d."state" = 'draft'
      AND d."template_id" IS NULL
      AND d."link_label" IS NULL;
  END IF;
END $$;
