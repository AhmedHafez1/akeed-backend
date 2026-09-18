-- One-off remediation: Starter usage that rolled into later 30-day periods.
--
-- Before the one-time Starter fix, a Starter source's usage row was keyed by a
-- 30-day rolling period, so every 30 days it received a fresh 30 confirmations.
-- Starter now records all usage under one period keyed by the activation date
-- (UTC), or 2000-01-01 when there is none (see getOneTimePeriodStart).
--
-- This script folds every other Starter usage row into that canonical row,
-- repoints dispatches that reference the old periods, and deletes them.
--
-- Run with psql against the target database. Running the whole file is a dry
-- run: it previews, applies inside a transaction, shows the result, and then
-- ROLLS BACK. Replace the final ROLLBACK with COMMIT to apply.

-- 1. Read-only preview: Starter sources with usage outside their canonical period.
WITH starter AS (
  SELECT
    i.id AS integration_id,
    i.org_id,
    i.platform_type,
    i.platform_store_url,
    COALESCE((i.billing_activated_at AT TIME ZONE 'UTC')::date, DATE '2000-01-01')
      AS canonical_period_start
  FROM public.integrations i
  WHERE i.billing_plan_id = 'starter'
     OR (i.platform_type = 'shopify' AND i.billing_plan_id IS NULL)
)
SELECT
  s.platform_type,
  s.platform_store_url,
  s.integration_id,
  s.canonical_period_start,
  u.period_start,
  u.included_limit,
  u.consumed_count,
  u.blocked_count,
  (u.period_start = s.canonical_period_start) AS is_canonical
FROM starter s
JOIN public.integration_monthly_usage u ON u.integration_id = s.integration_id
WHERE s.integration_id IN (
  SELECT u2.integration_id
  FROM public.integration_monthly_usage u2
  JOIN starter s2 ON s2.integration_id = u2.integration_id
  WHERE u2.period_start <> s2.canonical_period_start
)
ORDER BY s.platform_store_url, u.period_start;

-- 2. Apply.
BEGIN;

CREATE TEMP TABLE starter_canonical ON COMMIT DROP AS
SELECT
  i.id AS integration_id,
  i.org_id,
  COALESCE((i.billing_activated_at AT TIME ZONE 'UTC')::date, DATE '2000-01-01')
    AS canonical_period_start
FROM public.integrations i
WHERE (i.billing_plan_id = 'starter'
    OR (i.platform_type = 'shopify' AND i.billing_plan_id IS NULL))
  AND EXISTS (
    SELECT 1
    FROM public.integration_monthly_usage u
    WHERE u.integration_id = i.id
      AND u.period_start <> COALESCE(
        (i.billing_activated_at AT TIME ZONE 'UTC')::date, DATE '2000-01-01')
  );

-- Lifetime totals per source, capped at the Starter allowance.
CREATE TEMP TABLE starter_totals ON COMMIT DROP AS
SELECT
  c.integration_id,
  c.org_id,
  c.canonical_period_start,
  LEAST(SUM(u.consumed_count), 30)::int AS consumed_count,
  SUM(u.blocked_count)::int AS blocked_count
FROM starter_canonical c
JOIN public.integration_monthly_usage u ON u.integration_id = c.integration_id
GROUP BY c.integration_id, c.org_id, c.canonical_period_start;

INSERT INTO public.integration_monthly_usage
  (org_id, integration_id, period_start, included_limit, consumed_count, blocked_count)
SELECT t.org_id, t.integration_id, t.canonical_period_start, 30, t.consumed_count, t.blocked_count
FROM starter_totals t
ON CONFLICT (integration_id, period_start) DO UPDATE
SET included_limit = 30,
    consumed_count = EXCLUDED.consumed_count,
    blocked_count = EXCLUDED.blocked_count,
    updated_at = NOW();

-- Keep refunds and restores of in-flight sends pointing at a row that exists.
UPDATE public.verification_message_dispatches d
SET usage_period_start = c.canonical_period_start
FROM starter_canonical c
WHERE d.integration_id = c.integration_id
  AND d.usage_period_start IS NOT NULL
  AND d.usage_period_start <> c.canonical_period_start;

DELETE FROM public.integration_monthly_usage u
USING starter_canonical c
WHERE u.integration_id = c.integration_id
  AND u.period_start <> c.canonical_period_start;

-- Result: exactly one usage row per remediated Starter source.
SELECT u.integration_id, u.period_start, u.included_limit, u.consumed_count, u.blocked_count
FROM public.integration_monthly_usage u
JOIN starter_canonical c ON c.integration_id = u.integration_id
ORDER BY u.integration_id;

ROLLBACK; -- change to COMMIT after reviewing the output above
