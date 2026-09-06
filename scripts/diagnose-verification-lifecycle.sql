-- Read-only diagnostic for the terminal-status overwrite defect.
--
-- Before the dispatch ledger applied terminal-status protection, provider
-- acceptance (and the admin `outcome_unknown` resolution) wrote `status`
-- unconditionally. A verification the customer had already answered could
-- therefore be walked backwards to 'sent' or 'failed' while keeping the
-- `confirmed_at` / `canceled_at` timestamp that proves the reply happened.
--
-- Rows returned here are that signature. Nothing is modified.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/diagnose-verification-lifecycle.sql

\echo '== Affected rows by current status =='

SELECT
  v.status                                   AS current_status,
  count(*)                                   AS affected_rows,
  count(*) FILTER (WHERE v.confirmed_at IS NOT NULL) AS lost_confirmations,
  count(*) FILTER (WHERE v.canceled_at IS NOT NULL)  AS lost_cancellations,
  min(v.updated_at)                          AS earliest,
  max(v.updated_at)                          AS latest
FROM verifications AS v
WHERE (v.confirmed_at IS NOT NULL AND v.status <> 'confirmed')
   OR (v.canceled_at IS NOT NULL AND v.status NOT IN ('canceled', 'confirmed'))
GROUP BY v.status
ORDER BY affected_rows DESC;

\echo '== Split by commerce platform =='

SELECT
  i.platform_type,
  v.status AS current_status,
  count(*) AS affected_rows
FROM verifications AS v
JOIN orders       AS o ON o.id = v.order_id
JOIN integrations AS i ON i.id = o.integration_id
WHERE (v.confirmed_at IS NOT NULL AND v.status <> 'confirmed')
   OR (v.canceled_at IS NOT NULL AND v.status NOT IN ('canceled', 'confirmed'))
GROUP BY i.platform_type, v.status
ORDER BY affected_rows DESC;

\echo '== Sample rows for manual review (most recent 50) =='

SELECT
  v.id            AS verification_id,
  v.org_id,
  v.status        AS current_status,
  v.confirmed_at,
  v.canceled_at,
  v.last_sent_at,
  v.updated_at,
  o.external_order_id,
  i.platform_type
FROM verifications AS v
JOIN orders       AS o ON o.id = v.order_id
JOIN integrations AS i ON i.id = o.integration_id
WHERE (v.confirmed_at IS NOT NULL AND v.status <> 'confirmed')
   OR (v.canceled_at IS NOT NULL AND v.status NOT IN ('canceled', 'confirmed'))
ORDER BY v.updated_at DESC
LIMIT 50;
