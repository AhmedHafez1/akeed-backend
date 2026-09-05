DO $$ BEGIN
  CREATE TYPE "public"."verification_dispatch_kind" AS ENUM('initial', 'follow_up', 'legacy_unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."verification_dispatch_state" AS ENUM('ready', 'sending', 'accepted', 'rejected', 'outcome_unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$
DECLARE
  manual_event_count bigint;
  unlinked_manual_event_count bigint;
  legacy_message_count bigint;
BEGIN
  SELECT count(*) INTO manual_event_count
  FROM "public"."webhook_events"
  WHERE "platform" = 'standalone' AND "job_type" = 'order.create';
  SELECT count(*) INTO unlinked_manual_event_count
  FROM "public"."webhook_events"
  WHERE "platform" = 'standalone' AND "job_type" = 'order.create';
  SELECT count(*) INTO legacy_message_count
  FROM "public"."verifications"
  WHERE "wa_message_id" IS NOT NULL;
  RAISE NOTICE 'US-04-03 preflight: manual_events=%, unlinked_candidates=%, legacy_messages=%',
    manual_event_count, unlinked_manual_event_count, legacy_message_count;
END $$;--> statement-breakpoint

ALTER TABLE "public"."webhook_events"
  ADD COLUMN IF NOT EXISTS "order_id" uuid;--> statement-breakpoint

UPDATE "public"."webhook_events" AS event
SET "order_id" = matched_order."id"
FROM "public"."orders" AS matched_order
WHERE event."platform" = 'standalone'
  AND event."job_type" = 'order.create'
  AND event."org_id" = matched_order."org_id"
  AND event."integration_id" = matched_order."integration_id"
  AND event."raw_payload"->'order'->>'externalOrderId' = matched_order."external_order_id"
  AND event."order_id" IS NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_events_order_id_fkey'
  ) THEN
    ALTER TABLE "public"."webhook_events"
      ADD CONSTRAINT "webhook_events_order_id_fkey"
      FOREIGN KEY ("order_id", "org_id")
      REFERENCES "public"."orders"("id", "org_id");
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_order_id_key"
  ON "public"."webhook_events" ("order_id")
  WHERE "order_id" IS NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verifications_id_org_id_key'
  ) THEN
    ALTER TABLE "public"."verifications"
      ADD CONSTRAINT "verifications_id_org_id_key" UNIQUE("id", "org_id");
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."verification_message_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "org_id" uuid NOT NULL,
  "integration_id" uuid NOT NULL,
  "verification_id" uuid NOT NULL,
  "dispatch_key" text NOT NULL,
  "kind" "verification_dispatch_kind" NOT NULL,
  "state" "verification_dispatch_state" DEFAULT 'ready' NOT NULL,
  "sender_kind" text DEFAULT 'akeed_system' NOT NULL,
  "template_name" text,
  "language_code" text,
  "provider_message_id" text,
  "usage_period_start" date,
  "usage_reserved" boolean DEFAULT false NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "lease_until" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "verification_message_dispatches_dispatch_key_key" UNIQUE("dispatch_key"),
  CONSTRAINT "verification_message_dispatches_verification_id_fkey"
    FOREIGN KEY ("verification_id", "org_id") REFERENCES "public"."verifications"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "verification_message_dispatches_integration_id_fkey"
    FOREIGN KEY ("integration_id", "org_id") REFERENCES "public"."integrations"("id", "org_id"),
  CONSTRAINT "verification_message_dispatches_sender_kind_check" CHECK ("sender_kind" = 'akeed_system'),
  CONSTRAINT "verification_message_dispatches_attempt_count_check" CHECK ("attempt_count" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "verification_message_dispatches_provider_message_id_key"
  ON "public"."verification_message_dispatches" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_message_dispatches_verification"
  ON "public"."verification_message_dispatches" ("verification_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verification_message_dispatches_unknown"
  ON "public"."verification_message_dispatches" ("state", "updated_at");--> statement-breakpoint

ALTER TABLE "public"."verification_message_dispatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'verification_message_dispatches'
      AND policyname = 'Service role manages verification message dispatches'
  ) THEN
    CREATE POLICY "Service role manages verification message dispatches"
      ON "public"."verification_message_dispatches"
      AS PERMISSIVE FOR ALL TO "service_role"
      USING (true) WITH CHECK (true);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'verification_message_dispatches'
      AND policyname = 'Multi-tenant verification message dispatches'
  ) THEN
    CREATE POLICY "Multi-tenant verification message dispatches"
      ON "public"."verification_message_dispatches"
      AS PERMISSIVE FOR SELECT TO "authenticated"
      USING (org_id = get_user_org_id());
  END IF;
END $$;--> statement-breakpoint

INSERT INTO "public"."verification_message_dispatches" (
  "org_id",
  "integration_id",
  "verification_id",
  "dispatch_key",
  "kind",
  "state",
  "provider_message_id",
  "accepted_at",
  "metadata"
)
SELECT
  verification."org_id",
  matched_order."integration_id",
  verification."id",
  verification."id"::text || ':legacy:1',
  'legacy_unknown',
  'accepted',
  verification."wa_message_id",
  COALESCE(verification."last_sent_at", verification."updated_at", verification."created_at", now()),
  jsonb_build_object('backfilled', true)
FROM "public"."verifications" AS verification
JOIN "public"."orders" AS matched_order ON matched_order."id" = verification."order_id"
WHERE verification."wa_message_id" IS NOT NULL
ON CONFLICT ("dispatch_key") DO NOTHING;--> statement-breakpoint

UPDATE "public"."webhook_events"
SET
  "status" = 'pending',
  "processed_at" = NULL,
  "processing_lease_until" = NULL,
  "dispatched_at" = NULL,
  "dispatch_lease_until" = NULL,
  "next_dispatch_at" = now(),
  "last_error" = NULL,
  "updated_at" = now()
WHERE "platform" = 'standalone'
  AND "job_type" = 'order.create'
  AND "status" = 'skipped'
  AND "last_error" = 'no_normalizer:standalone'
  AND "order_id" IS NOT NULL;--> statement-breakpoint

DO $$
DECLARE
  linked_manual_event_count bigint;
  unlinked_manual_event_count bigint;
  backfilled_dispatch_count bigint;
BEGIN
  SELECT count(*) FILTER (WHERE "order_id" IS NOT NULL),
         count(*) FILTER (WHERE "order_id" IS NULL)
    INTO linked_manual_event_count, unlinked_manual_event_count
  FROM "public"."webhook_events"
  WHERE "platform" = 'standalone' AND "job_type" = 'order.create';
  SELECT count(*) INTO backfilled_dispatch_count
  FROM "public"."verification_message_dispatches"
  WHERE "kind" = 'legacy_unknown' AND "metadata"->>'backfilled' = 'true';
  RAISE NOTICE 'US-04-03 backfill: linked_manual_events=%, unlinked_manual_events=%, legacy_dispatches=%',
    linked_manual_event_count, unlinked_manual_event_count, backfilled_dispatch_count;
END $$;
