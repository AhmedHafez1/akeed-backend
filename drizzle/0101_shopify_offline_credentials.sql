-- The renewal half of a Shopify offline credential. The access token itself
-- stays encrypted in "integrations"."access_token" with its expiry in
-- "integrations"."expires_at"; this table keeps what only the backend may
-- read: the encrypted rotating refresh token, both expiries and the state of
-- the move from a non-expiring token.
--
-- 'legacy'   the store still holds a non-expiring token (no row means the
--            same thing for stores installed before this table existed).
-- 'expiring' the store holds a 1-hour access token and a refresh token.
--
-- Rollback: deploy the previous release, then DROP TABLE. Stores already on
-- expiring tokens keep working only while that release could refresh them,
-- so rolling back after migration needs the merchants to reopen the app.
CREATE TABLE IF NOT EXISTS shopify_offline_credentials (
  integration_id uuid PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  credential_kind text NOT NULL CHECK (credential_kind IN ('legacy','expiring')),
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reauth_required')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_refreshed_at timestamptz,
  migrated_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_offline_credentials_expiring_check CHECK (
    credential_kind <> 'expiring'
    OR (refresh_token IS NOT NULL
        AND access_token_expires_at IS NOT NULL
        AND refresh_token_expires_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shopify_offline_credentials_refresh_due_idx
  ON shopify_offline_credentials (refresh_token_expires_at)
  WHERE credential_kind = 'expiring' AND status = 'active';
--> statement-breakpoint
ALTER TABLE shopify_offline_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON shopify_offline_credentials FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages shopify offline credentials" ON shopify_offline_credentials;
--> statement-breakpoint
CREATE POLICY "Service role manages shopify offline credentials" ON shopify_offline_credentials FOR ALL TO service_role USING (true) WITH CHECK (true);
