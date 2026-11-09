-- Capability and recipient snapshots bind customer actions to the actual outbound message.
ALTER TYPE verification_dispatch_kind ADD VALUE IF NOT EXISTS 'change_acknowledgment';
--> statement-breakpoint
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS customer_action_at timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS customer_action_event_id text;
ALTER TABLE verification_message_dispatches ADD COLUMN IF NOT EXISTS change_request_buttons boolean NOT NULL DEFAULT false;
ALTER TABLE verification_message_dispatches ADD COLUMN IF NOT EXISTS recipient_hash text;
--> statement-breakpoint
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS change_request_of_key text;
ALTER TABLE whatsapp_template_drafts ADD COLUMN IF NOT EXISTS change_label text;
ALTER TABLE whatsapp_template_drafts ADD COLUMN IF NOT EXISTS change_request_of_key text;
--> statement-breakpoint
ALTER TABLE credit_reservations DROP CONSTRAINT IF EXISTS credit_reservations_kind_check;
ALTER TABLE credit_reservations ADD CONSTRAINT credit_reservations_kind_check CHECK (kind::text IN ('initial', 'follow_up', 'acknowledgment', 'change_acknowledgment'));
--> statement-breakpoint
-- Drafts are preparation only: no provider IDs, approval, activation or default changes.
-- Include draft-only languages too, and preserve every existing style/version and legacy row.
WITH sources AS (
  SELECT t.key, t.purpose, t.language, t.style, t.meta_language_code,
    COALESCE(d.body, concat_ws(E'\n', NULLIF(t.preview->>'greeting',''), NULLIF(t.preview->>'body',''), NULLIF(t.preview->>'totalLabel',''), NULLIF(t.preview->>'ending',''))) AS body,
    t.preview->>'confirmButton' AS confirm_label, t.preview->>'cancelButton' AS cancel_label,
    COALESCE(d.samples, '{"customer":"Customer","store":"Example Store","order":"TEST-1","total":"100.00 EGP","items":"Example item","region":"Example region","address":"Example address"}'::jsonb) AS samples
  FROM whatsapp_templates t LEFT JOIN whatsapp_template_drafts d ON d.template_id = t.id
  WHERE t.header_format = 'none' AND t.retired_at IS NULL AND t.change_request_of_key IS NULL
  UNION ALL
  SELECT d.key, d.purpose, d.language, d.style, d.meta_language_code, d.body, d.confirm_label, d.cancel_label, d.samples
  FROM whatsapp_template_drafts d WHERE d.template_id IS NULL AND d.change_request_of_key IS NULL
), prepared AS (
  SELECT DISTINCT ON (key) *, 'change_' || substr(md5(key),1,16) AS new_style FROM sources ORDER BY key
)
INSERT INTO whatsapp_template_drafts
  (key, purpose, language, style, version, meta_template_name, meta_language_code, parameter_format, category, body, confirm_label, cancel_label, change_label, change_request_of_key, samples, created_by, updated_by)
SELECT
  CASE purpose WHEN 'cod_confirmation' THEN 'cod_confirm' ELSE 'cod_reminder' END || '.' || language || '.' || new_style || '_v1',
  purpose, language, new_style, 1,
  'akeed_' || CASE purpose WHEN 'cod_confirmation' THEN 'cod_confirm' ELSE 'cod_reminder' END || '_' || new_style || '_v1',
  meta_language_code, 'named', 'utility', body, confirm_label, cancel_label,
  CASE language WHEN 'ar' THEN 'طلب تعديل' WHEN 'en' THEN 'Request a change' WHEN 'ur' THEN 'تبدیلی کی درخواست' WHEN 'es' THEN 'Solicitar un cambio' WHEN 'fr' THEN 'Demander une modification' WHEN 'tr' THEN 'Değişiklik iste' END,
  key, samples, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
FROM prepared ON CONFLICT DO NOTHING;
