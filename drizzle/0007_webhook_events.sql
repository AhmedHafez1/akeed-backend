-- Create webhook event status enum
DO $$ BEGIN
  CREATE TYPE "public"."webhook_event_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create generic webhook_events table (platform-agnostic)
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"               uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  "platform"         text NOT NULL,
  "job_type"         text NOT NULL,
  "idempotency_key"  text NOT NULL,
  "store_domain"     text NOT NULL,
  "org_id"           uuid,
  "integration_id"   uuid,
  "status"           "webhook_event_status" DEFAULT 'pending' NOT NULL,
  "raw_payload"      jsonb NOT NULL,
  "attempts"         integer DEFAULT 0 NOT NULL,
  "last_error"       text,
  "processed_at"     timestamp with time zone,
  "received_at"      timestamp with time zone DEFAULT now(),
  "created_at"       timestamp with time zone DEFAULT now(),
  "updated_at"       timestamp with time zone DEFAULT now()
);

-- Unique constraint: one event per (platform, idempotency_key)
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_platform_idempotency_key"
  UNIQUE ("platform", "idempotency_key");

-- Foreign keys
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL;

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_webhook_events_platform_idempotency"
  ON "webhook_events" USING btree ("platform", "idempotency_key");

CREATE INDEX IF NOT EXISTS "idx_webhook_events_status"
  ON "webhook_events" USING btree ("status");

CREATE INDEX IF NOT EXISTS "idx_webhook_events_org_id"
  ON "webhook_events" USING btree ("org_id");

CREATE INDEX IF NOT EXISTS "idx_webhook_events_store_domain"
  ON "webhook_events" USING btree ("store_domain");

-- RLS policy: only service_role can manage webhook events
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages webhook events"
  ON "webhook_events" AS PERMISSIVE FOR ALL
  TO "service_role"
  USING (true) WITH CHECK (true);
