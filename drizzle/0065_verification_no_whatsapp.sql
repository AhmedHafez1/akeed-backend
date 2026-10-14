-- A verification whose customer number cannot receive WhatsApp messages.
--
-- When the provider reports error 131026 for the confirmation message, the
-- verification moves to 'no_whatsapp' instead of 'failed'. The merchant is
-- asked to call the customer, the reminder is not sent, and no usage is
-- counted for the message.
--
-- "verifications" gains:
--   * "no_whatsapp_at": when the provider first reported the number
--     undeliverable. Written once, never overwritten.
--   * "delivery_error_code": the provider's error code for that report.
-- Both are NULL for every existing row. Existing 'failed' rows that carry the
-- same error code in their metadata stay 'failed'.
--
-- "commerce_outcome_syncs"."action" accepts 'automatic_no_whatsapp_tagging',
-- the outcome that tags the order in its store.
--
-- ALTER TYPE ... ADD VALUE cannot be undone in Postgres. The new value is not
-- used anywhere in this migration.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'no_whatsapp'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'verification_status')
  ) THEN
    ALTER TYPE "public"."verification_status" ADD VALUE 'no_whatsapp' AFTER 'no_reply';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "no_whatsapp_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "delivery_error_code" text;--> statement-breakpoint

ALTER TABLE "commerce_outcome_syncs" DROP CONSTRAINT IF EXISTS "commerce_outcome_syncs_action_check";--> statement-breakpoint
ALTER TABLE "commerce_outcome_syncs" ADD CONSTRAINT "commerce_outcome_syncs_action_check" CHECK ("action" = ANY (ARRAY['customer_confirmation'::text, 'customer_cancellation'::text, 'merchant_no_reply_cancellation'::text, 'merchant_cancellation_tagging'::text, 'automatic_no_reply_tagging'::text, 'automatic_no_whatsapp_tagging'::text]));
