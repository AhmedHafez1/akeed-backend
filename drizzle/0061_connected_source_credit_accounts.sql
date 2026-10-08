-- EasyOrders and WooCommerce sources are now billed like Standalone: prepaid
-- credits with a one-time launch grant, opened when the store connects. Stores
-- connected before this change have no credit account, and would have every
-- send refused with CREDIT_ACCOUNT_NOT_PROVISIONED. This opens the account for
-- each of them, with the 30-credit default grant (`STANDALONE_FREE_GRANT`).
--
-- The member who connected the store is recorded as the actor, as a new
-- connect records it. Organizations that already have an account are left
-- alone, so the migration is safe to run again.
WITH connected AS (
  SELECT org_id, connected_by FROM "public"."easyorders_connections"
  UNION
  SELECT org_id, connected_by FROM "public"."woocommerce_connections"
),
opened AS (
  INSERT INTO "public"."credit_accounts" (org_id, status, posted_balance)
  SELECT DISTINCT connected.org_id, 'active'::"public"."credit_account_status", 30
  FROM connected
  ON CONFLICT (org_id) DO NOTHING
  RETURNING org_id
)
INSERT INTO "public"."credit_ledger_entries" (org_id, type, quantity, idempotency_key, actor_id, reason, posted_balance_before, posted_balance_after)
SELECT DISTINCT ON (opened.org_id)
  opened.org_id,
  'free_grant',
  30,
  'standalone-free-grant:' || opened.org_id::text || ':v1',
  connected.connected_by,
  'connected_source_backfill',
  0,
  30
FROM opened
JOIN connected ON connected.org_id = opened.org_id
ORDER BY opened.org_id;
