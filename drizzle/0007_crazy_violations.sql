CREATE TYPE "public"."webhook_event_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"platform" text NOT NULL,
	"job_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"store_domain" text NOT NULL,
	"org_id" uuid,
	"integration_id" uuid,
	"status" "webhook_event_status" DEFAULT 'pending' NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "webhook_events_platform_idempotency_key" UNIQUE("platform","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_events_platform_idempotency" ON "webhook_events" USING btree ("platform" text_ops,"idempotency_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_webhook_events_status" ON "webhook_events" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_webhook_events_org_id" ON "webhook_events" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_webhook_events_store_domain" ON "webhook_events" USING btree ("store_domain" text_ops);--> statement-breakpoint
CREATE POLICY "Service role manages webhook events" ON "webhook_events" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);