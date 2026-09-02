SELECT 'orders_missing_source' AS exception_type, count(*) AS row_count
FROM orders
WHERE integration_id IS NULL
UNION ALL
SELECT 'orders_ambiguous_source', count(*)
FROM orders o
WHERE o.integration_id IS NULL
  AND 1 < (SELECT count(*) FROM integrations i WHERE i.org_id = o.org_id)
UNION ALL
SELECT 'orders_orphaned_source', count(*)
FROM orders o
WHERE o.integration_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.org_id = o.org_id)
UNION ALL
SELECT 'orders_source_org_mismatch', count(*)
FROM orders o
JOIN integrations i ON i.id = o.integration_id
WHERE o.org_id <> i.org_id
UNION ALL
SELECT 'usage_source_org_mismatch', count(*)
FROM integration_monthly_usage u
JOIN integrations i ON i.id = u.integration_id
WHERE u.org_id <> i.org_id
UNION ALL
SELECT 'verification_order_org_mismatch', count(*)
FROM verifications v
JOIN orders o ON o.id = v.order_id
WHERE v.org_id <> o.org_id
UNION ALL
SELECT 'webhook_partial_source_identity', count(*)
FROM webhook_events
WHERE (org_id IS NULL) <> (integration_id IS NULL)
UNION ALL
SELECT 'webhook_source_org_mismatch', count(*)
FROM webhook_events w
JOIN integrations i ON i.id = w.integration_id
WHERE w.org_id IS NOT NULL AND w.org_id <> i.org_id
UNION ALL
SELECT 'lifecycle_source_org_mismatch', count(*)
FROM admin_store_lifecycles l
JOIN integrations i ON i.id = l.integration_id
WHERE l.org_id <> i.org_id
ORDER BY exception_type;

SELECT o.id, o.org_id, o.external_order_id,
       array_agg(i.id ORDER BY i.created_at) AS candidate_integration_ids
FROM orders o
LEFT JOIN integrations i ON i.org_id = o.org_id
WHERE o.integration_id IS NULL
GROUP BY o.id, o.org_id, o.external_order_id
ORDER BY o.created_at, o.id;

SELECT w.id, w.org_id, w.integration_id,
       array_agg(i.id ORDER BY i.created_at) FILTER (WHERE i.id IS NOT NULL) AS candidate_integration_ids
FROM webhook_events w
LEFT JOIN integrations i
  ON i.id = w.integration_id
  OR (w.integration_id IS NULL AND i.org_id = w.org_id)
WHERE (w.org_id IS NULL) <> (w.integration_id IS NULL)
GROUP BY w.id, w.org_id, w.integration_id
ORDER BY w.id;
