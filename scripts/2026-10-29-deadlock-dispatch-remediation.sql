-- One-off remediation: initial dispatch salvaged after the 40P01 deadlock of
-- 2026-10-29 03:10:04 UTC (sendOnce.persistAcceptance).
--
-- Verification f52bb544-59c7-42ca-8f1b-1664cdd9c50c, dispatch
-- d8c03c04-d65a-4170-ab40-daa1d53a65e1 (initial, generation 1, periodic plan).
-- WhatsApp accepted the message (wamid ...RDIyQzM5...), then reported it
-- undeliverable (131026) before the acceptance committed. The receipt was
-- parked; the acceptance deadlocked while applying it and rolled back, and
-- the salvage parked the dispatch at `outcome_unknown` without applying the
-- receipt. The dispatch still holds one usage unit for a message that was
-- never delivered.
--
-- This applies the receipt the way the acceptance would have: the dispatch
-- becomes accepted and failed, the usage is released, and the receipt is
-- marked applied. The verification is already `no_whatsapp` (set by the
-- follow-up's failure receipt) and is left alone. The staff "resolve as
-- accepted" action is not used: on an initial dispatch it would add an
-- attempt and point `wa_message_id` back at this message.
--
-- Run with psql against the target database. Running the whole file is a dry
-- run: it previews, applies inside a transaction, shows the result, and then
-- ROLLS BACK. Replace the final ROLLBACK with COMMIT to apply. Every write is
-- guarded on the state it expects, so a second run changes nothing.

-- 1. Read-only preview.
SELECT d.id, d.state, d.usage_reserved, d.usage_period_start, d.provider_message_id,
  d.accepted_at, d.failed_at, d.last_error_code,
  u.consumed_count, r.id AS receipt_id, r.status AS receipt_status,
  r.error_code AS receipt_error_code, r.occurred_at AS receipt_occurred_at, r.applied_at
FROM public.verification_message_dispatches d
JOIN public.integration_monthly_usage u
  ON u.integration_id = d.integration_id AND u.period_start = d.usage_period_start
LEFT JOIN public.provider_message_receipts r ON r.provider_message_id = d.provider_message_id
WHERE d.id = 'd8c03c04-d65a-4170-ab40-daa1d53a65e1';

BEGIN;

-- 2. Release the usage unit, only while the dispatch still holds it.
UPDATE public.integration_monthly_usage u
SET consumed_count = GREATEST(u.consumed_count - 1, 0), updated_at = now()
FROM public.verification_message_dispatches d
WHERE d.id = 'd8c03c04-d65a-4170-ab40-daa1d53a65e1'
  AND d.state = 'outcome_unknown'
  AND d.last_error_code = 'acceptance_persistence_failed'
  AND d.usage_reserved
  AND d.accounting_mode = 'periodic_plan'
  AND u.integration_id = d.integration_id
  AND u.period_start = d.usage_period_start;

-- 3. Record the acceptance and the delivery failure on the ledger.
UPDATE public.verification_message_dispatches d
SET state = 'accepted',
    accepted_at = '2026-10-29 03:10:01.183+00',
    failed_at = r.occurred_at,
    usage_reserved = false,
    last_error_code = NULL,
    lease_until = NULL,
    resolved_at = now(),
    updated_at = now()
FROM public.provider_message_receipts r
WHERE d.id = 'd8c03c04-d65a-4170-ab40-daa1d53a65e1'
  AND d.state = 'outcome_unknown'
  AND d.last_error_code = 'acceptance_persistence_failed'
  AND r.id = 'ca42245c-7b41-48c3-9ca6-ac4a748936ff'
  AND r.provider_message_id = d.provider_message_id
  AND r.status = 'failed'
  AND r.applied_at IS NULL;

-- 4. Mark the parked receipt applied, once the ledger carries it.
UPDATE public.provider_message_receipts r
SET applied_at = now()
FROM public.verification_message_dispatches d
WHERE r.id = 'ca42245c-7b41-48c3-9ca6-ac4a748936ff'
  AND r.applied_at IS NULL
  AND d.id = 'd8c03c04-d65a-4170-ab40-daa1d53a65e1'
  AND d.provider_message_id = r.provider_message_id
  AND d.state = 'accepted'
  AND d.failed_at IS NOT NULL;

-- 5. Result.
SELECT d.id, d.state, d.usage_reserved, d.accepted_at, d.failed_at, d.last_error_code,
  u.consumed_count, r.applied_at, v.status AS verification_status
FROM public.verification_message_dispatches d
JOIN public.integration_monthly_usage u
  ON u.integration_id = d.integration_id AND u.period_start = d.usage_period_start
JOIN public.verifications v ON v.id = d.verification_id
LEFT JOIN public.provider_message_receipts r ON r.provider_message_id = d.provider_message_id
WHERE d.id = 'd8c03c04-d65a-4170-ab40-daa1d53a65e1';

ROLLBACK;
