-- Read-only pilot reconciliation. No credential, provider message id, customer
-- identity, message body or raw payload is returned. Costs on prepaid dispatches
-- are displayed credits; ledger quantities and reservations are stored credits.
--
-- psql "$env:PILOT_DATABASE_URL" -X -qAt -v org_id='<uuid>' `
--   -v pilot_start='2026-11-05T00:00:00Z' -f scripts/own-number-pilot-reconcile.sql
-- Exit 0: no contradictions; 3: contradictions, missing input, or SQL error.
-- Expected unknown-outcome duplicate risks remain visible even on exit 0.
\set ON_ERROR_STOP on
\pset pager off
\if :{?org_id}
\else
  SELECT 'org_id_required'::uuid;
\endif
\if :{?pilot_start}
\else
  SELECT 'pilot_start_required'::timestamptz;
\endif

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

WITH input AS (
  SELECT :'org_id'::uuid AS org_id, :'pilot_start'::timestamptz AS pilot_start
), lifetime AS (
  SELECT d.id, d.org_id, d.integration_id, d.verification_id, d.kind, d.state,
         d.generation, d.sender_kind, d.sender_connection_id,
         d.sender_phone_number_id, d.sender_reason, d.accounting_mode,
         d.billing_pool, d.billing_cost, d.billing_refunded_at, d.usage_reserved,
         d.attempt_count, d.provider_message_id, d.accepted_at, d.failed_at,
         d.last_error_code, d.sender_recovery_state, d.fallback_for_dispatch_id,
         d.created_at, d.metadata -> 'billingExempt' = 'true'::jsonb AS exempt
  FROM verification_message_dispatches d
  JOIN input p ON p.org_id = d.org_id
), pilot AS (
  SELECT d.* FROM lifetime d CROSS JOIN input p
  WHERE d.created_at >= p.pilot_start
), sent AS (
  SELECT * FROM pilot WHERE attempt_count > 0 OR state <> 'ready'
), ledger AS (
  SELECT e.id, e.org_id, e.type, e.quantity, e.dispatch_id,
         e.reservation_id, e.source_ledger_entry_id
  FROM credit_ledger_entries e JOIN input p ON p.org_id = e.org_id
), reservations AS (
  SELECT r.id, r.org_id, r.dispatch_id, r.status, r.quantity
  FROM credit_reservations r JOIN input p ON p.org_id = r.org_id
), account AS (
  SELECT a.org_id, a.posted_balance, a.held_credits, a.spare_credit,
         (SELECT coalesce(sum(e.quantity), 0) FROM ledger e) AS ledger_balance,
         (SELECT coalesce(sum(r.quantity), 0) FROM reservations r WHERE r.status = 'held') AS reservation_holds,
         (SELECT coalesce(-sum(e.quantity), 0) FROM ledger e
          WHERE e.type::text IN ('own_number_pack', 'own_number_pack_reversal')) AS net_packs,
         (SELECT count(*) FROM lifetime d WHERE d.accounting_mode = 'prepaid_credit'
          AND d.billing_pool = 'credits' AND d.billing_cost = 1
          AND d.billing_refunded_at IS NULL) AS open_one_credit_charges
  FROM credit_accounts a JOIN input p ON p.org_id = a.org_id
), physical AS (
  -- A logical acceptance and its physical attempt describe the same send.
  -- Count the attempt once, and exclude confirmed failed delivery attempts.
  SELECT a.dispatch_id, d.verification_id, d.kind, a.provider_message_id
  FROM verification_sender_attempts a
  JOIN lifetime d ON d.id = a.dispatch_id AND d.org_id = a.org_id
  WHERE a.accepted_at IS NOT NULL AND a.failed_at IS NULL
    AND a.provider_message_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM pilot p WHERE p.verification_id = d.verification_id AND p.kind = d.kind)
  UNION
  SELECT d.id, d.verification_id, d.kind, d.provider_message_id
  FROM lifetime d
  WHERE d.accepted_at IS NOT NULL AND d.failed_at IS NULL
    AND d.provider_message_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM pilot p WHERE p.verification_id = d.verification_id AND p.kind = d.kind)
    AND NOT EXISTS (SELECT 1 FROM verification_sender_attempts a
                    WHERE a.dispatch_id = d.id AND a.org_id = d.org_id
                      AND a.provider_message_id = d.provider_message_id)
), duplicate_groups AS (
  SELECT verification_id, kind, count(DISTINCT provider_message_id) AS accepted_sends
  FROM physical GROUP BY verification_id, kind
  HAVING count(DISTINCT provider_message_id) > 1
), d3 AS (
  -- The dispatch retains outcome_unknown even if a late receipt changes the
  -- attempt's failure. The original charge must already have been returned.
  SELECT original.id AS original_id, fallback.id AS fallback_id,
         original.verification_id, original.kind,
         CASE WHEN EXISTS (SELECT 1 FROM physical x WHERE x.dispatch_id = original.id)
              THEN 'confirmed' ELSE 'possible' END AS classification
  FROM lifetime original
  JOIN pilot fallback ON fallback.fallback_for_dispatch_id = original.id
    AND fallback.verification_id = original.verification_id AND fallback.kind = original.kind
  WHERE original.sender_kind = 'merchant_own' AND fallback.sender_kind = 'akeed_system'
    AND original.last_error_code = 'outcome_unknown'
    AND original.sender_recovery_state = 'fallback'
    AND original.billing_refunded_at IS NOT NULL AND NOT original.usage_reserved
    AND fallback.accepted_at IS NOT NULL AND fallback.failed_at IS NULL
    AND EXISTS (SELECT 1 FROM verification_sender_attempts a
                WHERE a.dispatch_id = original.id AND a.org_id = original.org_id
                  AND (a.failure ->> 'class' = 'outcome_unknown' OR a.accepted_at IS NOT NULL))
), violations AS (
  SELECT 'organization_missing' AS code, p.org_id AS record_id FROM input p
  WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p.org_id)
  UNION ALL
  SELECT 'invalid_pilot_start', p.org_id FROM input p
  WHERE NOT isfinite(p.pilot_start) OR p.pilot_start > CURRENT_TIMESTAMP
  UNION ALL
  SELECT 'sender_identity', d.id FROM sent d
  WHERE d.sender_kind NOT IN ('merchant_own', 'akeed_system')
     OR nullif(trim(d.sender_reason), '') IS NULL
     OR (d.sender_kind = 'merchant_own' AND
         (d.sender_phone_number_id IS NULL OR NOT EXISTS
          (SELECT 1 FROM whatsapp_connections c WHERE c.id = d.sender_connection_id AND c.org_id = d.org_id)))
     OR (d.sender_kind = 'akeed_system' AND d.sender_connection_id IS NOT NULL)
  UNION ALL
  SELECT 'dispatch_tenant_identity', d.id FROM sent d
  WHERE NOT EXISTS (SELECT 1 FROM integrations i WHERE i.id = d.integration_id AND i.org_id = d.org_id)
     OR NOT EXISTS (SELECT 1 FROM verifications v WHERE v.id = d.verification_id AND v.org_id = d.org_id)
  UNION ALL
  SELECT 'billing_snapshot', d.id FROM sent d
  WHERE NOT coalesce(d.exempt, false) AND NOT coalesce(
    CASE WHEN d.accounting_mode = 'prepaid_credit' THEN
      d.billing_pool = 'credits' AND CASE
        WHEN d.sender_kind = 'merchant_own' THEN d.billing_cost = 1
        WHEN d.fallback_for_dispatch_id IS NOT NULL THEN d.billing_cost BETWEEN 0 AND 2
        ELSE d.billing_cost = 2 END
    WHEN d.accounting_mode = 'periodic_plan' THEN CASE
      WHEN d.sender_kind = 'merchant_own' THEN d.billing_pool IN ('akeed', 'own_number') AND d.billing_cost = 1
      WHEN d.fallback_for_dispatch_id IS NOT NULL THEN
        (d.billing_pool = 'akeed' AND d.billing_cost = 1)
        OR (d.billing_pool = 'own_number' AND d.billing_cost BETWEEN 0 AND 3)
      ELSE d.billing_pool = 'akeed' AND d.billing_cost = 1 END
    ELSE false END, false)
  UNION ALL
  SELECT 'exempt_charge', d.id FROM sent d WHERE coalesce(d.exempt, false) AND
    (coalesce(d.billing_cost, 0) <> 0 OR d.usage_reserved
     OR EXISTS (SELECT 1 FROM ledger e WHERE e.dispatch_id = d.id)
     OR EXISTS (SELECT 1 FROM reservations r WHERE r.dispatch_id = d.id))
  UNION ALL
  SELECT 'fallback_identity_or_unreturned_charge', d.id FROM sent d
  WHERE d.fallback_for_dispatch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM lifetime original WHERE original.id = d.fallback_for_dispatch_id
      AND original.verification_id = d.verification_id AND original.kind = d.kind
      AND original.generation + 1 = d.generation AND original.sender_kind = 'merchant_own'
      AND d.sender_kind = 'akeed_system' AND original.sender_recovery_state = 'fallback'
      AND NOT original.usage_reserved AND original.billing_refunded_at IS NOT NULL)
  UNION ALL
  SELECT 'posted_balance_mismatch', org_id FROM account WHERE posted_balance <> ledger_balance
  UNION ALL
  SELECT 'held_balance_mismatch', org_id FROM account WHERE held_credits <> reservation_holds
  UNION ALL
  SELECT 'spare_credit_mismatch', org_id FROM account
  WHERE spare_credit <> 2 * net_packs - open_one_credit_charges
     OR spare_credit NOT IN (0, 1)
  UNION ALL
  SELECT 'credit_account_missing', p.org_id FROM input p
  WHERE EXISTS (SELECT 1 FROM sent d WHERE d.accounting_mode = 'prepaid_credit' AND NOT coalesce(d.exempt, false))
    AND NOT EXISTS (SELECT 1 FROM account)
  UNION ALL
  SELECT 'reservation_ledger_mismatch', r.id FROM reservations r
  WHERE NOT EXISTS (SELECT 1 FROM lifetime d WHERE d.id = r.dispatch_id)
     OR r.quantity <> 1
     OR (r.status = 'held' AND EXISTS (SELECT 1 FROM ledger e WHERE e.reservation_id = r.id))
     OR (r.status = 'consumed' AND
         (SELECT coalesce(sum(e.quantity), 0) FROM ledger e WHERE e.reservation_id = r.id) <> -1)
     OR (r.status = 'released' AND
         (SELECT coalesce(sum(e.quantity), 0) FROM ledger e WHERE e.reservation_id = r.id) <> 0)
  UNION ALL
  SELECT 'dispatch_ledger_mismatch', d.id FROM sent d
  WHERE d.accounting_mode = 'prepaid_credit' AND NOT coalesce(d.exempt, false) AND (
    (d.billing_cost = 2 AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.dispatch_id = d.id))
    OR (d.billing_cost IN (0, 1) AND EXISTS (SELECT 1 FROM reservations r WHERE r.dispatch_id = d.id))
    OR (d.billing_cost = 0 AND EXISTS (SELECT 1 FROM ledger e WHERE e.dispatch_id = d.id))
    OR (d.billing_cost = 1 AND EXISTS (SELECT 1 FROM ledger e WHERE e.dispatch_id = d.id
        AND e.type::text NOT IN ('own_number_pack', 'own_number_pack_reversal'))))
  UNION ALL
  SELECT 'reservation_state_mismatch', d.id FROM sent d
  JOIN reservations r ON r.dispatch_id = d.id
  WHERE d.accounting_mode = 'prepaid_credit' AND d.billing_cost = 2 AND (
    (d.state = 'accepted' AND d.failed_at IS NULL AND r.status <> 'consumed')
    OR ((d.state = 'rejected' OR d.failed_at IS NOT NULL) AND r.status <> 'released'))
  UNION ALL
  SELECT 'attempt_identity', d.id FROM sent d
  WHERE EXISTS (SELECT 1 FROM verification_sender_attempts a WHERE a.dispatch_id = d.id
    AND (a.org_id <> d.org_id OR a.connection_id IS DISTINCT FROM d.sender_connection_id
         OR a.phone_number_id IS DISTINCT FROM d.sender_phone_number_id))
  UNION ALL
  SELECT 'ledger_dispatch_ownership', e.id FROM ledger e
  WHERE e.dispatch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lifetime d WHERE d.id = e.dispatch_id)
  UNION ALL
  SELECT 'refund_missing', d.id FROM sent d
  WHERE d.sender_kind = 'merchant_own' AND d.failed_at IS NOT NULL
    AND d.sender_recovery_state IN ('fallback', 'complete', 'canceled')
    AND d.billing_refunded_at IS NULL AND NOT coalesce(d.exempt, false)
  UNION ALL
  SELECT 'unexpected_duplicate', g.verification_id FROM duplicate_groups g
  WHERE NOT (g.accepted_sends = 2 AND EXISTS (
    SELECT 1 FROM d3 expected WHERE expected.verification_id = g.verification_id
      AND expected.kind = g.kind AND expected.classification = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM physical x WHERE x.verification_id = g.verification_id
        AND x.kind = g.kind AND x.dispatch_id NOT IN (expected.original_id, expected.fallback_id))))
), result AS (
  SELECT jsonb_build_object(
    'orgId', p.org_id, 'pilotStart', p.pilot_start, 'observedAt', CURRENT_TIMESTAMP,
    'consistent', NOT EXISTS (SELECT 1 FROM violations),
    'pilotDispatches', (SELECT count(*) FROM pilot),
    'unclaimedDispatches', (SELECT count(*) FROM pilot WHERE attempt_count = 0 AND state = 'ready'),
    'historicalRowsWithoutBillingSnapshot', (SELECT count(*) FROM lifetime WHERE created_at < p.pilot_start AND billing_pool IS NULL),
    'account', (SELECT jsonb_build_object('postedBalance', posted_balance, 'ledgerBalance', ledger_balance,
      'heldCredits', held_credits, 'reservationHolds', reservation_holds, 'spareCredit', spare_credit,
      'expectedSpare', 2 * net_packs - open_one_credit_charges) FROM account),
    'billing', coalesce((SELECT jsonb_agg(t) FROM (SELECT accounting_mode, sender_kind, billing_pool,
      count(*) AS dispatches, sum(billing_cost) AS recorded_cost,
      sum(billing_cost) FILTER (WHERE billing_refunded_at IS NULL) AS unrefunded_cost
      FROM sent GROUP BY accounting_mode, sender_kind, billing_pool) t), '[]'::jsonb),
    'planPools', coalesce((SELECT jsonb_agg(jsonb_build_object('integrationId', u.integration_id,
      'periodStart', u.period_start, 'akeedUsed', u.consumed_count, 'ownNumberUsed', u.own_number_consumed,
      'akeedLimit', u.included_limit)) FROM integration_monthly_usage u WHERE u.org_id = p.org_id), '[]'::jsonb),
    'poolNote', 'Persisted pool counters are informational: plan changes reset counters; summing all historical dispatches would give a false mismatch.',
    'expectedDuplicateRisks', coalesce((SELECT jsonb_agg(jsonb_build_object('originalDispatchId', original_id,
      'fallbackDispatchId', fallback_id, 'verificationId', verification_id, 'kind', kind,
      'classification', classification)) FROM d3), '[]'::jsonb),
    'confirmedDuplicateGroups', coalesce((SELECT jsonb_agg(jsonb_build_object('verificationId', verification_id,
      'kind', kind, 'acceptedSends', accepted_sends)) FROM duplicate_groups), '[]'::jsonb),
    'violations', coalesce((SELECT jsonb_agg(jsonb_build_object('code', code, 'recordId', record_id)
      ORDER BY code, record_id) FROM violations), '[]'::jsonb)
  ) AS report, NOT EXISTS (SELECT 1 FROM violations) AS clean FROM input p
)
SELECT report, clean FROM result
\gset
COMMIT;
\echo :report
\if :clean
\else
  -- PostgreSQL 17's \quit ignores a numeric argument. Use ON_ERROR_STOP's
  -- documented nonzero SQL-error exit after emitting the diagnostic report.
  SELECT 'pilot_reconciliation_contradictions'::integer;
\endif
