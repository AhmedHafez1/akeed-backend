-- Free-form service messages: texts, sends and unresolved replies (US-08-07
-- b, c and e).
--
-- "whatsapp_message_texts" holds the free-form copy staff manage: the
-- acknowledgment after a customer confirms or cancels, the nudge after a typed
-- reply Akeed could not read, and the per-language words used when a customer
-- or store name is missing. One row per (purpose, language, style). The style
-- 'default' is the language's text; a dialect style ('egyptian', 'gulf')
-- overrides it for a verification whose latest send used that style. Body
-- placeholders are Akeed's own ({{order}}, {{store}}). No row is seeded:
-- staff write them in the admin message texts section.
--
-- "whatsapp_message_text_events" records every staff change to a text, with
-- the body before and after. Staff copy only; never customer data.
--
-- "verification_service_messages" records each acknowledgment and nudge.
-- The unique ("verification_id", "kind") is the once-per-verification rule:
-- the row is claimed before the message is sent, so a replayed webhook or a
-- retried job finds it and sends nothing. "state" is 'claimed', then 'sent',
-- 'skipped' (with "skip_reason", for example 'outside_window' or
-- 'window_closed') or 'failed'. These messages are free at the provider
-- (record 4.10.5): they reserve no usage and write no dispatch or credit row.
--
-- "verification_reply_events" records each typed reply that resolved to an
-- open verification but could not be read as an answer. It stores no text.
-- "provider_message_id" is unique, so a redelivered reply is stored once.
--
-- All four tables are service-role only. Merchants never read them directly.
-- Additive and safe to replay. No row is written.
--
-- Rollback: set WHATSAPP_ACKNOWLEDGMENT_ENABLED,
-- WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED and WHATSAPP_LOCALIZED_FALLBACKS_ENABLED
-- to false, which stops every read and write of these tables. To remove the
-- schema too, deploy the previous release and then run:
--   DROP TABLE IF EXISTS "verification_reply_events";
--   DROP TABLE IF EXISTS "verification_service_messages";
--   DROP TABLE IF EXISTS "whatsapp_message_text_events";
--   DROP TABLE IF EXISTS "whatsapp_message_texts";
CREATE TABLE IF NOT EXISTS "whatsapp_message_texts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purpose" text NOT NULL,
  "language" text NOT NULL,
  "style" text DEFAULT 'default' NOT NULL,
  "body" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "updated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_message_texts_purpose_language_style_key" UNIQUE ("purpose", "language", "style"),
  CONSTRAINT "whatsapp_message_texts_purpose_check" CHECK ("purpose" IN ('ack_confirmed', 'ack_canceled', 'unresolved_reply_nudge', 'fallback_customer_name', 'fallback_store_name')),
  CONSTRAINT "whatsapp_message_texts_language_check" CHECK ("language" IN ('ar', 'en')),
  CONSTRAINT "whatsapp_message_texts_style_check" CHECK ("style" ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT "whatsapp_message_texts_body_check" CHECK (char_length("body") BETWEEN 1 AND 4096)
);--> statement-breakpoint
ALTER TABLE "whatsapp_message_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_message_texts" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp message texts" ON "whatsapp_message_texts";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp message texts" ON "whatsapp_message_texts" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_message_text_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "text_id" uuid NOT NULL REFERENCES "whatsapp_message_texts"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "previous_body" text,
  "body" text NOT NULL,
  "previous_is_active" boolean,
  "is_active" boolean NOT NULL,
  "changed_by" uuid NOT NULL,
  "request_id" text,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_message_text_events_action_check" CHECK ("action" IN ('create', 'update'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_message_text_events_text_changed" ON "whatsapp_message_text_events" USING btree ("text_id", "changed_at");--> statement-breakpoint
ALTER TABLE "whatsapp_message_text_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_message_text_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp message text events" ON "whatsapp_message_text_events";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp message text events" ON "whatsapp_message_text_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_service_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "state" text DEFAULT 'claimed' NOT NULL,
  "skip_reason" text,
  "text_purpose" text,
  "text_style" text,
  "language" text,
  "provider_message_id" text,
  "replied_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_service_messages_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_service_messages_once_key" UNIQUE ("verification_id", "kind"),
  CONSTRAINT "verification_service_messages_kind_check" CHECK ("kind" IN ('acknowledgment', 'nudge')),
  CONSTRAINT "verification_service_messages_state_check" CHECK ("state" IN ('claimed', 'sent', 'skipped', 'failed')),
  CONSTRAINT "verification_service_messages_language_check" CHECK ("language" IS NULL OR "language" IN ('ar', 'en')),
  CONSTRAINT "verification_service_messages_sent_has_id_check" CHECK ("state" <> 'sent' OR "provider_message_id" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_service_messages_provider_message_idx" ON "verification_service_messages" USING btree ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_service_messages_org_created" ON "verification_service_messages" USING btree ("org_id", "created_at");--> statement-breakpoint
ALTER TABLE "verification_service_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_service_messages" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification service messages" ON "verification_service_messages";--> statement-breakpoint
CREATE POLICY "Service role manages verification service messages" ON "verification_service_messages" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_reply_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "provider_message_id" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_reply_events_verification_fkey" FOREIGN KEY ("verification_id", "org_id") REFERENCES "verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_reply_events_provider_message_key" UNIQUE ("provider_message_id"),
  CONSTRAINT "verification_reply_events_kind_check" CHECK ("kind" IN ('unresolved_reply'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_reply_events_verification" ON "verification_reply_events" USING btree ("verification_id", "received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_reply_events_org_received" ON "verification_reply_events" USING btree ("org_id", "received_at");--> statement-breakpoint
ALTER TABLE "verification_reply_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_reply_events" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages verification reply events" ON "verification_reply_events";--> statement-breakpoint
CREATE POLICY "Service role manages verification reply events" ON "verification_reply_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
