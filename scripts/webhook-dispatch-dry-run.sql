-- Read-only pre-rollout inventory. Run with psql against the target database.
-- It intentionally excludes raw_payload and all integration credentials.
SELECT
  platform,
  job_type,
  store_domain,
  COUNT(*)::int AS recoverable_count,
  MIN(received_at) AS oldest_received_at,
  MAX(dispatch_attempts)::int AS max_dispatch_attempts
FROM public.webhook_events
WHERE dispatch_required = true
  AND (
    (status = 'pending' AND dispatched_at IS NULL)
    OR (status = 'processing'
      AND ((processing_lease_until IS NOT NULL AND processing_lease_until <= NOW())
        OR (processing_lease_until IS NULL AND updated_at <= NOW() - INTERVAL '10 minutes')))
  )
GROUP BY platform, job_type, store_domain
ORDER BY oldest_received_at ASC;
