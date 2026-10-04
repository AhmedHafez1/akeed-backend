-- Read-only reconciliation for the US-06-06 EasyOrders live pilot.
--
-- For one pilot organization it lists what Akeed holds: the connection (no
-- credential), accepted events, orders, verifications, sends, usage and what
-- was written back to EasyOrders. Nothing is modified.
--
-- It never selects an encrypted column, a token hash, a raw payload, a phone
-- number, a customer name or an address. Credential columns are reported only
-- as "set" or "not set".
--
-- Usage (PowerShell, against the pilot environment's database):
--   psql "$env:PILOT_DATABASE_URL" -v org_id="'<organization uuid>'" `
--     -f scripts/easyorders-pilot-reconcile.sql > .tmp/pilots/easyorders/reconcile-<step>.txt
--
-- The pilot script (docs/Epics/06-easyorders-integration/evidence/
-- US-06-06-live-pilot-script.md) says when to run it and what each section
-- must show.

\pset pager off
BEGIN TRANSACTION READ ONLY;

\echo '== 1. Source and connection (one row; no credential is selected) =='

SELECT
  i.id                                        AS integration_id,
  i.platform_type,
  i.is_active,
  i.onboarding_status,
  i.billing_status,
  i.billing_plan_id,
  c.store_id,
  c.store_verified_at IS NOT NULL             AS store_verified,
  c.health,
  c.currency,
  c.phone_country,
  c.api_key_encrypted IS NOT NULL             AS api_key_set,
  c.webhook_token_hash IS NOT NULL            AS webhook_address_set,
  c.orders_webhook_secret_encrypted IS NOT NULL AS orders_secret_set,
  c.status_webhook_secret_encrypted IS NOT NULL AS status_secret_set,
  c.rejected_deliveries,
  c.last_rejected_at,
  c.disconnected_at,
  c.created_at                                AS connected_at
FROM integrations AS i
LEFT JOIN easyorders_connections AS c ON c.integration_id = i.id
WHERE i.org_id = :org_id
ORDER BY i.created_at;

\echo '== 2. Every source of the organization must be this one (expect 1 row) =='

SELECT platform_type, is_active, count(*) AS sources
FROM integrations
WHERE org_id = :org_id
GROUP BY platform_type, is_active;

\echo '== 3. Accepted events by type and result =='

SELECT job_type, status, last_error, count(*) AS events,
       min(received_at) AS first_received, max(received_at) AS last_received
FROM webhook_events
WHERE org_id = :org_id
GROUP BY job_type, status, last_error
ORDER BY job_type, status, last_error;

\echo '== 4. Events still waiting for dispatch or processing (expect 0 rows at the end) =='

SELECT id, job_type, status, dispatch_attempts, last_dispatch_error, received_at
FROM webhook_events
WHERE org_id = :org_id
  AND status NOT IN ('completed', 'skipped')
ORDER BY received_at;

\echo '== 5. One line per order: event, order, verification, sends, store update =='

SELECT
  o.external_order_id,
  o.order_number,
  o.total_price,
  o.currency,
  o.payment_method,
  o.created_at                                AS order_created_at,
  e.status                                    AS event_status,
  v.id                                        AS verification_id,
  v.status                                    AS verification_status,
  v.cancellation_source,
  (SELECT count(*) FROM verification_message_dispatches AS d
    WHERE d.verification_id = v.id)           AS sends,
  (SELECT string_agg(d.kind::text || ':' || d.state::text || ':' || d.sender_kind, ', ' ORDER BY d.created_at)
     FROM verification_message_dispatches AS d
    WHERE d.verification_id = v.id)           AS send_detail,
  (SELECT string_agg(s.action || ':' || s.state || ':' || coalesce(s.provider_status, '-') || ':' || coalesce(s.error_code, '-'), ', ' ORDER BY s.created_at)
     FROM commerce_outcome_syncs AS s
    WHERE s.order_id = o.id)                  AS store_updates
FROM orders AS o
LEFT JOIN webhook_events AS e ON e.order_id = o.id
LEFT JOIN verifications AS v ON v.order_id = o.id AND v.org_id = o.org_id
WHERE o.org_id = :org_id
ORDER BY o.created_at;

\echo '== 6. Orders without exactly one event and one verification (expect 0 rows) =='

SELECT o.external_order_id,
       (SELECT count(*) FROM webhook_events AS e WHERE e.order_id = o.id)   AS events,
       (SELECT count(*) FROM verifications AS v WHERE v.order_id = o.id)    AS verifications
FROM orders AS o
WHERE o.org_id = :org_id
  AND ((SELECT count(*) FROM webhook_events AS e WHERE e.order_id = o.id) <> 1
    OR (SELECT count(*) FROM verifications AS v WHERE v.order_id = o.id) <> 1);

\echo '== 7. The same EasyOrders order held more than once (expect 0 rows) =='

SELECT integration_id, external_order_id, count(*) AS copies
FROM orders
WHERE org_id = :org_id
GROUP BY integration_id, external_order_id
HAVING count(*) > 1;

\echo '== 8. Usage: units consumed against accepted sends =='

SELECT
  (SELECT coalesce(sum(consumed_count), 0) FROM integration_monthly_usage
    WHERE org_id = :org_id)                                   AS usage_consumed,
  (SELECT coalesce(sum(blocked_count), 0) FROM integration_monthly_usage
    WHERE org_id = :org_id)                                   AS usage_blocked,
  (SELECT count(*) FROM verification_message_dispatches
    WHERE org_id = :org_id AND usage_reserved)                AS sends_that_reserved_usage,
  (SELECT count(*) FROM verification_message_dispatches
    WHERE org_id = :org_id AND accepted_at IS NOT NULL)       AS sends_accepted_by_meta,
  (SELECT count(*) FROM verification_message_dispatches
    WHERE org_id = :org_id AND sender_kind <> 'akeed_system') AS sends_not_from_akeed_sender;

\echo '== 9. Store updates by action and state =='

SELECT action, state, provider_status, error_code, requires_assistance,
       count(*) AS updates, max(attempts) AS max_attempts, max(deferrals) AS max_deferrals
FROM commerce_outcome_syncs
WHERE org_id = :org_id
GROUP BY action, state, provider_status, error_code, requires_assistance
ORDER BY action, state;

\echo '== 10. An automatic no-reply must never be a remote cancellation (expect 0 rows) =='

SELECT s.id, s.action, s.state, s.provider_status
FROM commerce_outcome_syncs AS s
WHERE s.org_id = :org_id
  AND s.action = 'automatic_no_reply_tagging'
  AND s.state <> 'unsupported';

\echo '== 11. Local result against what EasyOrders confirmed (expect 0 rows) =='

SELECT o.external_order_id, v.status AS local_status, s.action, s.state, s.provider_status
FROM verifications AS v
JOIN orders AS o ON o.id = v.order_id
JOIN commerce_outcome_syncs AS s ON s.order_id = o.id AND s.state = 'succeeded'
WHERE v.org_id = :org_id
  AND NOT (
    (v.status = 'confirmed' AND s.provider_status = 'confirmed')
    OR (v.status = 'canceled' AND s.provider_status = 'canceled')
  );

\echo '== 12. Rows of this organization attached to another organization (expect 0 rows) =='

SELECT 'order' AS kind, o.id::text AS id
FROM orders AS o JOIN integrations AS i ON i.id = o.integration_id
WHERE o.org_id = :org_id AND i.org_id <> o.org_id
UNION ALL
SELECT 'event', e.id::text
FROM webhook_events AS e JOIN integrations AS i ON i.id = e.integration_id
WHERE e.org_id = :org_id AND i.org_id <> e.org_id
UNION ALL
SELECT 'store_update', s.id::text
FROM commerce_outcome_syncs AS s JOIN orders AS o ON o.id = s.order_id
WHERE s.org_id = :org_id AND o.org_id <> s.org_id;

ROLLBACK;
