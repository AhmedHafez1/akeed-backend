-- Commerce outcome synchronization state (US-06-04).
--
-- One row per order and outcome action, for sources whose outcome adapter
-- tracks synchronization. It keeps what the store was asked to do apart from
-- what the customer or merchant decided locally: the verification row holds
-- the decision, this row holds whether the store has it yet.
--
-- "provider_status" and "error_code" are short opaque codes, never provider
-- text, customer data or a credential. "correlation_id" is the id the caller
-- dispatched with (the verification id).
--
-- Rollback: DROP TABLE "commerce_outcome_syncs". No existing row is rewritten
-- and nothing else references the table; verification results are unaffected.
CREATE TABLE IF NOT EXISTS "commerce_outcome_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_order_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"action" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"retry_in_background" boolean DEFAULT false NOT NULL,
	"requires_assistance" boolean DEFAULT false NOT NULL,
	"provider_status" text,
	"error_code" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_outcome_syncs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "commerce_outcome_syncs_integration_id_fkey" FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "commerce_outcome_syncs_order_id_fkey" FOREIGN KEY ("order_id", "org_id") REFERENCES "orders"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "commerce_outcome_syncs_source_order_action_key" UNIQUE ("integration_id", "order_id", "action"),
	CONSTRAINT "commerce_outcome_syncs_action_check" CHECK ("action" = ANY (ARRAY['customer_confirmation'::text, 'customer_cancellation'::text, 'merchant_no_reply_cancellation'::text, 'merchant_cancellation_tagging'::text, 'automatic_no_reply_tagging'::text])),
	CONSTRAINT "commerce_outcome_syncs_state_check" CHECK ("state" = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'unsupported'::text])),
	CONSTRAINT "commerce_outcome_syncs_attempts_check" CHECK ("attempts" >= 0 AND "deferrals" >= 0),
	CONSTRAINT "commerce_outcome_syncs_provider_status_check" CHECK ("provider_status" IS NULL OR char_length("provider_status") BETWEEN 1 AND 64),
	CONSTRAINT "commerce_outcome_syncs_error_code_check" CHECK ("error_code" IS NULL OR char_length("error_code") BETWEEN 1 AND 64)
);--> statement-breakpoint
-- The dashboard reads the rows of one page of verifications; also covers the
-- organization foreign key.
CREATE INDEX IF NOT EXISTS "idx_commerce_outcome_syncs_org_correlation" ON "commerce_outcome_syncs" USING btree ("org_id", "correlation_id");--> statement-breakpoint
-- The order foreign key, and the status-event lookup by order.
CREATE INDEX IF NOT EXISTS "idx_commerce_outcome_syncs_order" ON "commerce_outcome_syncs" USING btree ("order_id");--> statement-breakpoint
-- Read and written only by the API. Supabase grants new tables to anon and
-- authenticated by default, so those grants are withdrawn and no policy is
-- created.
ALTER TABLE "commerce_outcome_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "commerce_outcome_syncs" FROM PUBLIC, anon, authenticated;
