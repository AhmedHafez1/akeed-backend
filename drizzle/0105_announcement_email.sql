ALTER TABLE tips_campaigns ADD COLUMN IF NOT EXISTS announcement_email jsonb;
--> statement-breakpoint
ALTER TABLE tips_campaigns ADD COLUMN IF NOT EXISTS email_stopped_at timestamptz;
--> statement-breakpoint
ALTER TABLE tips_campaigns ADD COLUMN IF NOT EXISTS secondary_action jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS announcement_email_preferences (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  unsubscribed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS announcement_email_deliveries (
  campaign_id uuid NOT NULL REFERENCES tips_campaigns(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed')),
  reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid,
  first_attempt_at timestamptz,
  email_payload jsonb,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, org_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_announcement_email_due ON announcement_email_deliveries(next_attempt_at, campaign_id, org_id) WHERE status IN ('pending', 'processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_announcement_email_org ON announcement_email_deliveries(org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS announcement_email_dispatch_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_batch_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid
);
--> statement-breakpoint
INSERT INTO announcement_email_dispatch_state (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE announcement_email_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE announcement_email_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE announcement_email_dispatch_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages announcement preferences" ON announcement_email_preferences;
--> statement-breakpoint
CREATE POLICY "Service role manages announcement preferences" ON announcement_email_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages announcement deliveries" ON announcement_email_deliveries;
--> statement-breakpoint
CREATE POLICY "Service role manages announcement deliveries" ON announcement_email_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages announcement dispatch" ON announcement_email_dispatch_state;
--> statement-breakpoint
CREATE POLICY "Service role manages announcement dispatch" ON announcement_email_dispatch_state FOR ALL TO service_role USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON announcement_email_preferences, announcement_email_deliveries, announcement_email_dispatch_state FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT ALL ON announcement_email_preferences, announcement_email_deliveries, announcement_email_dispatch_state TO service_role;
