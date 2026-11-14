-- Count installed Shopify stores by offline-credential state, to watch the
-- move from non-expiring to expiring tokens. Read-only.
--
-- Run in the Supabase SQL editor. No tokens are selected.
--
--   credential_kind  legacy: still on a non-expiring token (no row counts here)
--                    expiring: 1-hour access token plus refresh token
--   status           reauth_required: the merchant must open Akeed again
--   last_error_code  the most recent failure that left the credential usable

SELECT
  COALESCE(c.credential_kind, 'legacy') AS credential_kind,
  COALESCE(c.status, 'active') AS status,
  c.last_error_code,
  count(*) AS stores,
  min(c.refresh_token_expires_at) AS earliest_refresh_expiry,
  max(c.last_error_at) AS latest_error_at
FROM integrations i
LEFT JOIN shopify_offline_credentials c ON c.integration_id = i.id
WHERE i.platform_type = 'shopify'
  AND i.is_active = true
  AND i.uninstalled_at IS NULL
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- Stores that need the merchant to reopen Akeed:
--
-- SELECT i.platform_store_url, c.last_error_code, c.last_error_at
-- FROM shopify_offline_credentials c
-- JOIN integrations i ON i.id = c.integration_id
-- WHERE c.status = 'reauth_required' AND i.is_active = true
-- ORDER BY c.last_error_at DESC;
