CREATE TABLE IF NOT EXISTS "shopify_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "org_id" uuid,
  "integration_id" uuid,
  "webhook_id" text NOT NULL,
  "topic" text,
  "shop_domain" text,
  "received_at" timestamp with time zone DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shopify_webhook_events_webhook_id_key'
  ) THEN
    ALTER TABLE "shopify_webhook_events"
      ADD CONSTRAINT "shopify_webhook_events_webhook_id_key" UNIQUE ("webhook_id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_shopify_webhook_events_org_id"
  ON "shopify_webhook_events" USING btree ("org_id");

CREATE INDEX IF NOT EXISTS "idx_shopify_webhook_events_integration_id"
  ON "shopify_webhook_events" USING btree ("integration_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shopify_webhook_events_org_id_fkey'
  ) THEN
    ALTER TABLE "shopify_webhook_events"
      ADD CONSTRAINT "shopify_webhook_events_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shopify_webhook_events_integration_id_fkey'
  ) THEN
    ALTER TABLE "shopify_webhook_events"
      ADD CONSTRAINT "shopify_webhook_events_integration_id_fkey"
      FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL;
  END IF;
END $$;
