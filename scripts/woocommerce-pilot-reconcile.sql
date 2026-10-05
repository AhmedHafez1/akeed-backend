-- Read-only reconciliation for the US-07-06 WooCommerce live pilot.
--
-- For one pilot organization it lists what Akeed holds: the connection (no
-- credential), install attempts, accepted deliveries, orders, verifications,
-- sends, usage and what was written to the store. Nothing is modified.
--
-- It never selects an encrypted column, a token hash, a stored payload, a
-- phone number, a customer name, an email or an address. Credential columns
-- are reported only as "set" or "not set". From a stored delivery it reads
-- four named values and nothing else: the topic, the order's status, its
-- payment method and whether it carries Akeed's own marker. The store address
-- in section 1 is the address the merchant typed to connect.
--
-- Usage (PowerShell, against the pilot environment's database):
--   psql "$env:PILOT_DATABASE_URL" -v org_id="'<organization uuid>'" `
--     -f scripts/woocommerce-pilot-reconcile.sql > .tmp/pilots/woocommerce/reconcile-<step>.txt
--
-- The pilot script (docs/Epics/07-woocommerce-integration/evidence/
-- US-07-06-live-pilot-script.md) says when to run it and what each section
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
  c.store_url,
  c.store_verified_at IS NOT NULL             AS store_verified,
  c.woo_version,
  c.health,
  c.consumer_key_encrypted IS NOT NULL        AS consumer_key_set,
  c.consumer_secret_encrypted IS NOT NULL     AS consumer_secret_set,
  c.webhook_secret_encrypted IS NOT NULL      AS webhook_secret_set,
  c.webhook_token_hash IS NOT NULL            AS webhook_address_set,
  c.order_created_webhook_id IS NOT NULL      AS order_created_webhook_known,
  c.order_updated_webhook_id IS NOT NULL      AS order_updated_webhook_known,
  c.order_created_webhook_state,
  c.order_updated_webhook_state,
  c.webhooks_checked_at,
  c.rejected_deliveries,
  c.last_rejected_at,
  c.connected_at,
  c.disconnected_at
FROM integrations AS i
LEFT JOIN woocommerce_connections AS c ON c.integration_id = i.id
WHERE i.org_id = :org_id
ORDER BY i.created_at;

\echo '== 2. Every source of the organization must be this one (expect 1 row) =='

SELECT platform_type, is_active, count(*) AS sources
FROM integrations
WHERE org_id = :org_id
GROUP BY platform_type, is_active;

\echo '== 3. Install attempts (no token and no hash is selected) =='

SELECT
  created_at,
  expires_at,
  consumed_at IS NOT NULL                     AS consumed,
  superseded_at IS NOT NULL                   AS superseded,
  attempts,
  last_error_code
FROM woocommerce_pending_installs
WHERE org_id = :org_id
ORDER BY created_at;

\echo '== 4. Accepted deliveries by type and result =='

SELECT job_type, status, last_error, count(*) AS events,
       min(received_at) AS first_received, max(received_at) AS last_received
FROM webhook_events
WHERE org_id = :org_id
GROUP BY job_type, status, last_error
ORDER BY job_type, status, last_error;

\echo '== 5. Every accepted delivery in the order it arrived: topic, route, order status and payment method =='

-- The route is the first part of the idempotency key: order.create,
-- order.update or order.skip. The key holds no customer data.
SELECT
  e.received_at,
  e.raw_payload ->> 'topic'                              AS topic,
  split_part(e.idempotency_key, ':', 1)                  AS route,
  split_part(e.idempotency_key, ':', 3)                  AS store_order_id,
  e.raw_payload -> 'order' ->> 'status'                  AS order_status,
  e.raw_payload -> 'order' ->> 'payment_method'          AS payment_method,
  jsonb_array_length(
    coalesce(e.raw_payload -> 'order' -> 'meta_data', '[]'::jsonb)
  )                                                      AS akeed_markers,
  e.status                                               AS event_status,
  e.last_error
FROM webhook_events AS e
WHERE e.org_id = :org_id
ORDER BY e.received_at, e.created_at, e.id;

\echo '== 6. Deliveries still waiting for dispatch or processing (expect 0 rows at the end) =='

SELECT id, job_type, status, dispatch_attempts, last_dispatch_error, received_at
FROM webhook_events
WHERE org_id = :org_id
  AND status NOT IN ('completed', 'skipped')
ORDER BY received_at;

\echo '== 7. One line per order: event, order, verification, sends, store update =='

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

\echo '== 8. Orders without exactly one create event and one verification (expect 0 rows) =='

SELECT o.external_order_id,
       (SELECT count(*) FROM webhook_events AS e WHERE e.order_id = o.id)   AS create_events,
       (SELECT count(*) FROM verifications AS v WHERE v.order_id = o.id)    AS verifications
FROM orders AS o
WHERE o.org_id = :org_id
  AND ((SELECT count(*) FROM webhook_events AS e WHERE e.order_id = o.id) <> 1
    OR (SELECT count(*) FROM verifications AS v WHERE v.order_id = o.id) <> 1);

\echo '== 9. The same store order held more than once (expect 0 rows) =='

SELECT integration_id, external_order_id, count(*) AS copies
FROM orders
WHERE org_id = :org_id
GROUP BY integration_id, external_order_id
HAVING count(*) > 1;

\echo '== 10. Usage: units consumed against accepted sends =='

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

\echo '== 11. Store updates by action and state =='

SELECT action, state, provider_status, error_code, requires_assistance,
       count(*) AS updates, max(attempts) AS max_attempts, max(deferrals) AS max_deferrals
FROM commerce_outcome_syncs
WHERE org_id = :org_id
GROUP BY action, state, provider_status, error_code, requires_assistance
ORDER BY action, state;

\echo '== 12. An automatic no-reply must never be written to the store (expect 0 rows) =='

SELECT s.id, s.action, s.state, s.provider_status
FROM commerce_outcome_syncs AS s
WHERE s.org_id = :org_id
  AND s.action = 'automatic_no_reply_tagging'
  AND s.state <> 'unsupported';

\echo '== 13. Local result against what the store confirmed (expect 0 rows) =='

-- A confirmation leaves the status as it was (processing or on-hold); the two
-- cancellations leave cancelled.
SELECT o.external_order_id, v.status AS local_status, s.action, s.state, s.provider_status
FROM verifications AS v
JOIN orders AS o ON o.id = v.order_id
JOIN commerce_outcome_syncs AS s ON s.order_id = o.id AND s.state = 'succeeded'
WHERE v.org_id = :org_id
  AND NOT (
    (v.status = 'confirmed'
      AND s.action = 'customer_confirmation'
      AND s.provider_status IN ('processing', 'on-hold'))
    OR (v.status = 'canceled'
      AND s.action IN ('customer_cancellation', 'merchant_no_reply_cancellation')
      AND s.provider_status = 'cancelled')
  );

\echo '== 14. Rows of this organization attached to another organization (expect 0 rows) =='

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
