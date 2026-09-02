DO $$
DECLARE
  ambiguous_orders bigint;
  orphaned_orders bigint;
  ownership_mismatches bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM orders o WHERE o.integration_id IS NULL AND 1 < (SELECT count(*) FROM integrations i WHERE i.org_id = o.org_id)) +
    (SELECT count(*) FROM webhook_events w WHERE w.integration_id IS NULL AND w.org_id IS NOT NULL AND 1 < (SELECT count(*) FROM integrations i WHERE i.org_id = w.org_id))
  INTO ambiguous_orders;

  SELECT
    (SELECT count(*) FROM orders o WHERE o.integration_id IS NULL AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.org_id = o.org_id)) +
    (SELECT count(*) FROM webhook_events w WHERE w.integration_id IS NULL AND w.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM integrations i WHERE i.org_id = w.org_id))
  INTO orphaned_orders;

  SELECT
    (SELECT count(*) FROM orders o JOIN integrations i ON i.id = o.integration_id WHERE o.org_id <> i.org_id) +
    (SELECT count(*) FROM integration_monthly_usage u JOIN integrations i ON i.id = u.integration_id WHERE u.org_id <> i.org_id) +
    (SELECT count(*) FROM verifications v JOIN orders o ON o.id = v.order_id WHERE v.org_id <> o.org_id) +
    (SELECT count(*) FROM webhook_events w JOIN integrations i ON i.id = w.integration_id WHERE w.org_id IS NOT NULL AND w.org_id <> i.org_id) +
    (SELECT count(*) FROM admin_store_lifecycles l JOIN integrations i ON i.id = l.integration_id WHERE l.org_id <> i.org_id)
  INTO ownership_mismatches;

  IF ambiguous_orders > 0 OR orphaned_orders > 0 OR ownership_mismatches > 0 THEN
    RAISE EXCEPTION
      'Source identity preflight failed: ambiguous_orders=%, orphaned_orders=%, ownership_mismatches=%; run scripts/preflight-source-identity.sql and repair evidence-backed rows only',
      ambiguous_orders,
      orphaned_orders,
      ownership_mismatches;
  END IF;
END $$;--> statement-breakpoint
UPDATE orders o
SET integration_id = candidate.integration_id,
    updated_at = now()
FROM (
  SELECT o2.id AS order_id, (array_agg(i.id))[1] AS integration_id
  FROM orders o2
  JOIN integrations i ON i.org_id = o2.org_id
  WHERE o2.integration_id IS NULL
  GROUP BY o2.id
  HAVING count(*) = 1
) candidate
WHERE o.id = candidate.order_id;--> statement-breakpoint
UPDATE webhook_events w
SET integration_id = candidate.integration_id,
    updated_at = now()
FROM (
  SELECT w2.id AS webhook_event_id, (array_agg(i.id))[1] AS integration_id
  FROM webhook_events w2
  JOIN integrations i ON i.org_id = w2.org_id
  WHERE w2.integration_id IS NULL
    AND w2.org_id IS NOT NULL
  GROUP BY w2.id
  HAVING count(*) = 1
) candidate
WHERE w.id = candidate.webhook_event_id;--> statement-breakpoint
UPDATE webhook_events w
SET org_id = i.org_id,
    updated_at = now()
FROM integrations i
WHERE w.integration_id = i.id
  AND w.org_id IS NULL;--> statement-breakpoint
ALTER TABLE integrations ADD CONSTRAINT integrations_id_org_id_key UNIQUE(id, org_id);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_id_org_id_key UNIQUE(id, org_id);--> statement-breakpoint
ALTER TABLE orders ALTER COLUMN integration_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE integration_monthly_usage DROP CONSTRAINT integration_monthly_usage_integration_id_fkey;--> statement-breakpoint
ALTER TABLE integration_monthly_usage ADD CONSTRAINT integration_monthly_usage_integration_id_fkey FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id) NOT VALID;--> statement-breakpoint
ALTER TABLE integration_monthly_usage VALIDATE CONSTRAINT integration_monthly_usage_integration_id_fkey;--> statement-breakpoint
ALTER TABLE orders DROP CONSTRAINT orders_integration_id_fkey;--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_integration_id_fkey FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id) NOT VALID;--> statement-breakpoint
ALTER TABLE orders VALIDATE CONSTRAINT orders_integration_id_fkey;--> statement-breakpoint
ALTER TABLE verifications DROP CONSTRAINT verifications_order_id_fkey;--> statement-breakpoint
ALTER TABLE verifications ADD CONSTRAINT verifications_order_id_fkey FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id) NOT VALID;--> statement-breakpoint
ALTER TABLE verifications VALIDATE CONSTRAINT verifications_order_id_fkey;--> statement-breakpoint
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_integration_id_fkey;--> statement-breakpoint
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_integration_id_fkey FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id) NOT VALID;--> statement-breakpoint
ALTER TABLE webhook_events VALIDATE CONSTRAINT webhook_events_integration_id_fkey;--> statement-breakpoint
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_source_identity_pair_check CHECK ((org_id IS NULL) = (integration_id IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE webhook_events VALIDATE CONSTRAINT webhook_events_source_identity_pair_check;--> statement-breakpoint
ALTER TABLE admin_store_lifecycles DROP CONSTRAINT admin_store_lifecycles_integration_id_fkey;--> statement-breakpoint
ALTER TABLE admin_store_lifecycles ADD CONSTRAINT admin_store_lifecycles_integration_id_fkey FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id) ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE admin_store_lifecycles VALIDATE CONSTRAINT admin_store_lifecycles_integration_id_fkey;
