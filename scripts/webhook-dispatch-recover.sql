-- Safe manual recovery for one terminal dispatch failure.
-- Usage: psql "$DATABASE_URL" -v webhook_event_id='<uuid>' -f scripts/webhook-dispatch-recover.sql
-- The status predicate prevents completed/skipped/processing events from replaying.
BEGIN;

UPDATE public.webhook_events
SET
  status = 'pending',
  dispatch_attempts = 0,
  last_error = NULL,
  last_dispatch_error = NULL,
  next_dispatch_at = NOW(),
  dispatch_lease_until = NULL,
  dispatched_at = NULL,
  processing_lease_until = NULL,
  updated_at = NOW()
WHERE id = :'webhook_event_id'::uuid
  AND dispatch_required = true
  AND status = 'failed'
  AND last_error LIKE 'dispatch_terminal:%'
RETURNING id, platform, job_type, store_domain, status, next_dispatch_at;

COMMIT;
