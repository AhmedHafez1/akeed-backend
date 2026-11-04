-- An account subscription belongs to one organization. Never guess an owner.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_connections WHERE state <> 'disconnected' GROUP BY waba_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'WHATSAPP_LIVE_WABA_OWNERSHIP_CONFLICT';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS lifecycle_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_event_key text,
  ADD COLUMN IF NOT EXISTS disconnect_cleanup_until timestamptz,
  ADD COLUMN IF NOT EXISTS provider_cleanup text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_live_waba_key ON whatsapp_connections (waba_id)
  WHERE state <> 'disconnected' OR disconnect_cleanup_until IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid,
  verification_id uuid,
  provider_message_id text NOT NULL UNIQUE,
  customer_phone text,
  customer_user_id text,
  message_type text NOT NULL,
  body text,
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  redacted_at timestamptz,
  CONSTRAINT customer_messages_connection_fkey FOREIGN KEY (connection_id, org_id) REFERENCES whatsapp_connections(id, org_id),
  CONSTRAINT customer_messages_verification_fkey FOREIGN KEY (verification_id, org_id) REFERENCES verifications(id, org_id) ON DELETE CASCADE,
  CONSTRAINT customer_messages_redaction_check CHECK (redacted_at IS NULL OR (body IS NULL AND customer_phone IS NULL AND customer_user_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_messages_org_phone_idx ON customer_messages(org_id, customer_phone);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_messages_verification_idx ON customer_messages(org_id, verification_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_messages_expiry_idx ON customer_messages(expires_at);
--> statement-breakpoint
ALTER TABLE customer_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON customer_messages FROM PUBLIC, anon, authenticated;
