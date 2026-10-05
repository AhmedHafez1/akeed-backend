-- The WhatsApp template registry (US-08-03).
--
-- The 8 COD confirmation variants were a list in code
-- (src/shared/messaging/cod-template-catalog.ts). They become rows here, one
-- per template and language, so later stories can sync, inspect and change
-- them without a deploy. From this release the send path, the onboarding test
-- and the settings response read this table.
--
-- "key" is the stable identity, 'cod_confirm.<language>.<style>'. Keys,
-- purposes, languages, styles and variable mappings are the same in every
-- environment. "style" is what a merchant chooses ('standard', 'friendly').
-- "variable_mapping" is the ordered list of neutral variables with the
-- provider's parameter name (named) or position (positional). "preview" is the
-- hand-kept preview text the Settings page and the onboarding test show, until
-- US-08-07g renders previews from "components_snapshot".
--
-- "meta_template_id", "review_status", "category", "quality",
-- "components_snapshot" and "last_synced_at" are environment data: dev and
-- prod are separate Meta apps with their own templates. They stay NULL here
-- and are filled by each environment's own sync (US-08-04). Until then a row
-- is sendable when "is_active" is true.
--
-- The seed is the code catalog, verbatim, including the two legacy names with
-- a stray underscore. All 8 rows are active; 'ar.standard' and 'en.friendly'
-- are the defaults. ON CONFLICT DO NOTHING makes a rerun a no-op and never
-- overwrites a row staff changed later.
--
-- At most one default per purpose and language, and a default is always
-- active. The table is service-role only: merchants never read it directly.
--
-- Rollback: deploy the previous release first (it reads the code catalog and
-- the old "integrations" variant columns, which are kept in sync). Then roll
-- back 0055, and DROP TABLE "whatsapp_templates". No existing data is touched.
CREATE TABLE IF NOT EXISTS "whatsapp_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "purpose" text NOT NULL,
  "language" text NOT NULL,
  "style" text NOT NULL,
  "meta_template_name" text NOT NULL,
  "meta_language_code" text NOT NULL,
  "parameter_format" text NOT NULL,
  "variable_mapping" jsonb NOT NULL,
  "preview" jsonb NOT NULL,
  "components_snapshot" jsonb,
  "meta_template_id" text,
  "review_status" text,
  "category" text,
  "quality" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_synced_at" timestamp with time zone,
  CONSTRAINT "whatsapp_templates_key_key" UNIQUE ("key"),
  CONSTRAINT "whatsapp_templates_purpose_language_style_key" UNIQUE ("purpose", "language", "style"),
  CONSTRAINT "whatsapp_templates_purpose_check" CHECK ("purpose" IN ('cod_confirmation')),
  CONSTRAINT "whatsapp_templates_language_check" CHECK ("language" IN ('ar', 'en')),
  CONSTRAINT "whatsapp_templates_parameter_format_check" CHECK ("parameter_format" IN ('named', 'positional')),
  CONSTRAINT "whatsapp_templates_default_is_active_check" CHECK (NOT "is_default" OR "is_active")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_one_default_per_purpose_language_idx" ON "whatsapp_templates" USING btree ("purpose", "language") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_templates" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp templates" ON "whatsapp_templates";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp templates" ON "whatsapp_templates" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
INSERT INTO "whatsapp_templates" ("key", "purpose", "language", "style", "meta_template_name", "meta_language_code", "parameter_format", "variable_mapping", "preview", "is_active", "is_default", "sort_order") VALUES
  ('cod_confirm.ar.standard', 'cod_confirmation', 'ar', 'standard', 'akeed_cod_verification_friendly', 'ar', 'named', $json$[{"key":"customer","name":"customer"},{"key":"store","name":"store"},{"key":"order","name":"order"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"أهلًا بك {{customer}} 👋","body":"شكرًا لتسوّقك من {{store}}.\n\n طلبك رقم #{{order}} بقيمة {{total}} جاهز تقريبًا للشحن!","totalLabel":"إجمالي الطلب: {{total}}","ending":"يرجى تأكيد الطلب لنتمكن من إرساله إليك بأسرع وقت.","confirmButton":"تأكيد الطلب","cancelButton":"إلغاء الطلب"}$json$::jsonb, true, true, 1),
  ('cod_confirm.ar.egyptian', 'cod_confirmation', 'ar', 'egyptian', 'akeed_cod_verification_direct_eg', 'ar_EG', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"أهلًا {{customer}}،","body":"طلبك رقم #{{order}} من {{store}} مستني تأكيدك.","totalLabel":"إجمالي الطلب: {{total}}","ending":"ياريت تأكّد الطلب بقيمة {{total}} دلوقتي عشان نشحنهولك فورًا.","confirmButton":"تأكيد وشحن","cancelButton":"إلغاء الطلب"}$json$::jsonb, true, false, 2),
  ('cod_confirm.ar.gulf', 'cod_confirmation', 'ar', 'gulf', 'akeed_cod_verification_direct_gulf', 'ar', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"أهلًا {{customer}}،","body":"طلبك رقم #{{order}} من {{store}} بانتظار تأكيدك.","totalLabel":"إجمالي الطلب: {{total}}","ending":"ياليت تأكد الدفع عند الاستلام بقيمة {{total}} الحين عشان نطلعه للشحن فورًا وما يتأخر عليك.","confirmButton":"اشحن طلبي","cancelButton":"إلغاء"}$json$::jsonb, true, false, 3),
  ('cod_confirm.ar.short', 'cod_confirmation', 'ar', 'short', 'akeed_cod_verification', 'ar', 'positional', $json$[{"key":"order","position":1},{"key":"total","position":2}]$json$::jsonb, $json${"greeting":"السلام عليكم","body":"تم استلام طلبك رقم #{{order}} والدفع عند الاستلام","totalLabel":"إجمالي السعر: {{total}}","ending":"من فضلك أكد الطلب.","confirmButton":"تأكيد","cancelButton":"إلغاء"}$json$::jsonb, true, false, 4),
  ('cod_confirm.en.friendly', 'cod_confirmation', 'en', 'friendly', 'akeed_cod_verification_friendly', 'en', 'named', $json$[{"key":"customer","name":"customer"},{"key":"store","name":"store"},{"key":"order","name":"order"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"Hi {{customer}}! 👋","body":"Thank you for shopping with {{store}}.","totalLabel":"Your order #{{order}} for {{total}} is ready to go!","ending":"Please tap the button below to confirm your order so we can ship it immediately.","confirmButton":"Confirm Order","cancelButton":"Cancel Order"}$json$::jsonb, true, true, 1),
  ('cod_confirm.en.professional', 'cod_confirmation', 'en', 'professional', '_akeed_cod_verification_professional', 'en', 'named', $json$[{"key":"customer","name":"customer"},{"key":"store","name":"store"},{"key":"order","name":"order"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"Hello {{customer}},","body":"Thank you for choosing {{store}}.","totalLabel":"We have received your Cash on Delivery order #{{order}} for {{total}}.","ending":"Once confirmed, we will ship your order.","confirmButton":"Confirm & Ship","cancelButton":"Cancel Order"}$json$::jsonb, true, false, 2),
  ('cod_confirm.en.direct', 'cod_confirmation', 'en', 'direct', 'akeed_cod_verification_direct_', 'en', 'named', $json$[{"key":"customer","name":"customer"},{"key":"order","name":"order"},{"key":"store","name":"store"},{"key":"total","name":"total"}]$json$::jsonb, $json${"greeting":"Hi {{customer}},","body":"We are preparing your order #{{order}} at {{store}}.","totalLabel":"Please confirm your COD total of {{total}} right now so we ship your order immediately.","ending":"","confirmButton":"Ship My Order","cancelButton":"Cancel"}$json$::jsonb, true, false, 3),
  ('cod_confirm.en.short', 'cod_confirmation', 'en', 'short', 'akeed_cod_verification', 'en', 'positional', $json$[{"key":"order","position":1},{"key":"total","position":2}]$json$::jsonb, $json${"greeting":"Hello","body":"We have received your order #{{order}} with Cash on Delivery.","totalLabel":"Total Price: {{total}}","ending":"Please confirm your order.","confirmButton":"Confirm","cancelButton":"Cancel"}$json$::jsonb, true, false, 4)
ON CONFLICT ("key") DO NOTHING;
