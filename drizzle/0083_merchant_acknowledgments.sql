-- Merchant-controlled thank-you messages. Every statement can run twice.
ALTER TYPE "verification_dispatch_kind" ADD VALUE IF NOT EXISTS 'acknowledgment';
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "acknowledgment_enabled" boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "acknowledgment_enabled_at" timestamptz;
--> statement-breakpoint
-- Cast to text so this constraint can be installed in the same transaction as
-- the enum extension, including when Drizzle batches pending migrations.
ALTER TABLE "credit_reservations" DROP CONSTRAINT IF EXISTS "credit_reservations_kind_check";
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_kind_check" CHECK (kind::text IN ('initial', 'follow_up', 'acknowledgment'));
--> statement-breakpoint
ALTER TABLE "verification_service_messages" ADD COLUMN IF NOT EXISTS "dispatch_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('verification_service_messages')
      AND conname = 'verification_service_messages_dispatch_fkey'
  ) THEN
    ALTER TABLE "verification_service_messages"
      ADD CONSTRAINT "verification_service_messages_dispatch_fkey"
        FOREIGN KEY ("dispatch_id", "org_id")
        REFERENCES "verification_message_dispatches"("id", "org_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_service_messages_dispatch_idx" ON "verification_service_messages" ("dispatch_id") WHERE "dispatch_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dispatch_sending_lease" ON "verification_message_dispatches" ("lease_until") WHERE "state" = 'sending' AND "lease_until" IS NOT NULL;
