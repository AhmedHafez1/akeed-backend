-- Fill the first-answer milestones of current store lifecycles from the
-- orders they already resolved. Customer answers given with cycle buttons
-- were not recorded on the lifecycle, so working stores read as installed.
-- Only empty milestones are filled and only from real (non-test) orders
-- resolved since that install, so a rerun changes nothing.
WITH resolutions AS (
  SELECT
    l.id AS lifecycle_id,
    MIN(COALESCE(v.confirmed_at, v.canceled_at)) AS first_resolved_at,
    MIN(COALESCE(v.confirmed_at, v.canceled_at)) FILTER (
      WHERE v.confirmation_source = 'customer'
        OR v.cancellation_source = 'customer'
    ) AS first_customer_response_at,
    MIN(v.confirmed_at) FILTER (
      WHERE v.status = 'confirmed' AND v.confirmation_source = 'customer'
    ) AS first_real_confirmed_at
  FROM admin_store_lifecycles l
  INNER JOIN orders o ON o.integration_id = l.integration_id AND NOT o.is_test
  INNER JOIN verifications v ON v.order_id = o.id
  WHERE l.uninstalled_at IS NULL
    AND v.status IN ('confirmed', 'canceled')
    AND COALESCE(v.confirmed_at, v.canceled_at) >= l.installed_at
    AND (
      l.first_resolved_at IS NULL
      OR l.first_customer_response_at IS NULL
      OR l.first_real_confirmed_at IS NULL
    )
  GROUP BY l.id
)
UPDATE admin_store_lifecycles l
SET
  first_resolved_at = COALESCE(l.first_resolved_at, r.first_resolved_at),
  first_customer_response_at = COALESCE(
    l.first_customer_response_at,
    r.first_customer_response_at
  ),
  first_real_confirmed_at = COALESCE(
    l.first_real_confirmed_at,
    r.first_real_confirmed_at
  ),
  provenance = COALESCE(l.provenance, '{}'::jsonb)
    || CASE WHEN l.first_resolved_at IS NULL
      THEN '{"activation":"backfilled"}'::jsonb ELSE '{}'::jsonb END,
  updated_at = now()
FROM resolutions r
WHERE l.id = r.lifecycle_id
  AND (
    (l.first_resolved_at IS NULL AND r.first_resolved_at IS NOT NULL)
    OR (l.first_customer_response_at IS NULL AND r.first_customer_response_at IS NOT NULL)
    OR (l.first_real_confirmed_at IS NULL AND r.first_real_confirmed_at IS NOT NULL)
  );
