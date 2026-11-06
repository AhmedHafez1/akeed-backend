CREATE TABLE IF NOT EXISTS whatsapp_sender_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  signup_generation bigint NOT NULL CONSTRAINT whatsapp_sender_alerts_generation_check CHECK (signup_generation >= 1),
  kind text NOT NULL CONSTRAINT whatsapp_sender_alerts_kind_check CHECK (kind IN ('fallback','disconnect','template_rejection','quality_drop','payment')),
  reason text NOT NULL,
  dedupe_key text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  email_status text NOT NULL DEFAULT 'pending' CONSTRAINT whatsapp_sender_alerts_email_status_check CHECK (email_status IN ('pending','sending','sent','skipped','failed')),
  email_error text,
  email_claimed_at timestamptz,
  emailed_at timestamptz,
  CONSTRAINT whatsapp_sender_alerts_connection_fkey FOREIGN KEY (connection_id,org_id) REFERENCES whatsapp_connections(id,org_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_sender_alerts_open_key ON whatsapp_sender_alerts(org_id,connection_id,signup_generation,kind) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS whatsapp_sender_alerts_fallback_claim ON whatsapp_sender_alerts(org_id,email_claimed_at DESC) WHERE kind = 'fallback' AND email_claimed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS whatsapp_sender_alerts_pending ON whatsapp_sender_alerts(org_id) WHERE email_status = 'pending' AND resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispatch_sender_alert_activity ON verification_message_dispatches(org_id,accepted_at DESC) WHERE state = 'accepted' AND failed_at IS NULL;
--> statement-breakpoint
ALTER TABLE whatsapp_sender_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON whatsapp_sender_alerts FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_sender_alerts TO service_role;
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp sender alerts" ON whatsapp_sender_alerts;
--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp sender alerts" ON whatsapp_sender_alerts AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
