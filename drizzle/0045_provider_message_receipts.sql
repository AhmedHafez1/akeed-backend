-- Delivery receipts (delivered / read / failed) that arrived before the send
-- they describe was recorded.
--
-- Meta can report a message as delivered before the transaction that stores
-- its wamid has committed -- routinely for prepaid sends, whose acceptance also
-- moves credits under the organization's credit lock. Such a receipt matched
-- nothing and was dropped, and because the webhook still answered 200 Meta
-- never sent it again, so the verification stayed at `sent`. Receipts are now
-- parked here and applied by the acceptance transaction when it records the
-- wamid; `applied_at` marks the ones that have been.
--
-- There is no org_id: a wamid is globally unique, and the tenant is only known
-- once the receipt matches a dispatch. The table is service-role only.
--
-- Rollback: DROP TABLE "provider_message_receipts". No existing data is
-- touched.
CREATE TABLE IF NOT EXISTS "provider_message_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_message_id" text NOT NULL,
  "status" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "error_code" text,
  "error_title" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  CONSTRAINT "provider_message_receipts_status_check" CHECK ("status" IN ('delivered', 'read', 'failed')),
  CONSTRAINT "provider_message_receipts_message_status_key" UNIQUE ("provider_message_id", "status")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_message_receipts_pending" ON "provider_message_receipts" USING btree ("provider_message_id" text_ops) WHERE "applied_at" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_message_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "provider_message_receipts" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages provider message receipts" ON "provider_message_receipts";--> statement-breakpoint
CREATE POLICY "Service role manages provider message receipts" ON "provider_message_receipts" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
