ALTER TABLE "verification_message_dispatches"
  ADD COLUMN IF NOT EXISTS "sender_connection_id" uuid,
  ADD COLUMN IF NOT EXISTS "sender_phone_number_id" text,
  ADD COLUMN IF NOT EXISTS "sender_reason" text;
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  DROP CONSTRAINT IF EXISTS "verification_message_dispatches_sender_kind_check";
--> statement-breakpoint
ALTER TABLE "verification_message_dispatches"
  ADD CONSTRAINT "verification_message_dispatches_sender_kind_check"
  CHECK (sender_kind IN ('akeed_system', 'merchant_own'));
--> statement-breakpoint
ALTER TABLE "verification_service_messages"
  ADD COLUMN IF NOT EXISTS "sender_kind" text NOT NULL DEFAULT 'akeed_system',
  ADD COLUMN IF NOT EXISTS "sender_reason" text,
  ADD COLUMN IF NOT EXISTS "sender_phone_number_id" text;
