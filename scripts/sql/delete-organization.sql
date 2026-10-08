-- Delete one organization and everything linked to it.
--
-- Run in the Supabase SQL editor as the default postgres role. Set the two
-- values under SETTINGS, run with v_dry_run = true first and read the result,
-- then set it to false and run again. Any error rolls everything back.
--
-- What it removes: the organization, its memberships, integrations, orders,
-- verifications, dispatches, imports, API keys, store connections, credit
-- account, purchases, ledger, webhook events, free-plan claims and every
-- other row carrying its org_id.
--
-- What it does not touch: auth.users (use delete-user.sql), the store at
-- Shopify / EasyOrders / WooCommerce, and queued jobs in Redis.
--
-- See README.md in this folder before changing it.

DROP TABLE IF EXISTS akeed_delete_report;
CREATE TEMP TABLE akeed_delete_report (
  seq integer GENERATED ALWAYS AS IDENTITY,
  scope text NOT NULL,
  item text NOT NULL,
  row_count bigint
);

DO $$
DECLARE
  -- SETTINGS ---------------------------------------------------------------
  v_target  text    := 'PUT-ORG-UUID-OR-SLUG-HERE';
  v_dry_run boolean := true;  -- true = report only, nothing is changed
  ---------------------------------------------------------------------------

  v_uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_org_id uuid;
  v_org_name text;
  v_org_slug text;
  v_scope text;
  v_matches integer;
  v_integration_ids uuid[];
  v_store_urls text[];
  v_table text;
  v_count bigint;
  v_report jsonb := '[]'::jsonb;
BEGIN
  v_target := btrim(v_target);

  IF v_target ~ v_uuid_pattern THEN
    SELECT count(*), min(id::text)::uuid INTO v_matches, v_org_id
    FROM public.organizations
    WHERE id = v_target::uuid;
  ELSE
    SELECT count(*), min(id::text)::uuid INTO v_matches, v_org_id
    FROM public.organizations
    WHERE slug = v_target;
  END IF;

  IF v_matches <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one organization for "%", found %. Nothing was changed.',
      v_target, v_matches;
  END IF;

  SELECT name, slug INTO v_org_name, v_org_slug
  FROM public.organizations
  WHERE id = v_org_id;
  v_scope := format('org %s (%s)', v_org_slug, v_org_id);

  -- The work runs in a sub-block so a dry run can undo it and still report.
  BEGIN
    -- Read before anything is deleted: later steps match on these.
    SELECT coalesce(array_agg(id), '{}'), coalesce(array_agg(platform_store_url), '{}')
    INTO v_integration_ids, v_store_urls
    FROM public.integrations
    WHERE org_id = v_org_id;

    v_report := v_report || jsonb_build_object(
      'scope', v_scope, 'item', format('organizations: %s', v_org_name), 'rows', 1);
    v_report := v_report || jsonb_build_object(
      'scope', v_scope,
      'item', format('stores: %s', coalesce(nullif(array_to_string(v_store_urls, ', '), ''), 'none')),
      'rows', cardinality(v_store_urls));

    -- Count every table that carries org_id, so the report also covers the
    -- rows the cascade removes.
    FOR v_table IN
      SELECT c.relname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND a.attname = 'org_id'
        AND NOT a.attisdropped
      ORDER BY c.relname
    LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE org_id = $1', v_table)
        INTO v_count USING v_org_id;
      IF v_count > 0 THEN
        v_report := v_report || jsonb_build_object(
          'scope', v_scope, 'item', v_table, 'rows', v_count);
      END IF;
    END LOOP;

    -- 1. Rows that no foreign key reaches.
    DELETE FROM public.provider_message_receipts r
    WHERE r.provider_message_id IN (
      SELECT d.provider_message_id
      FROM public.verification_message_dispatches d
      WHERE d.org_id = v_org_id AND d.provider_message_id IS NOT NULL
      UNION ALL
      SELECT m.provider_message_id
      FROM public.verification_service_messages m
      WHERE m.org_id = v_org_id AND m.provider_message_id IS NOT NULL
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_report := v_report || jsonb_build_object(
      'scope', v_scope, 'item', 'provider_message_receipts (matched by message id)', 'rows', v_count);

    DELETE FROM public.webhook_events
    WHERE org_id IS NULL AND store_domain = ANY (v_store_urls);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_report := v_report || jsonb_build_object(
      'scope', v_scope, 'item', 'webhook_events (no org_id, matched by store)', 'rows', v_count);

    DELETE FROM public.admin_access_audit
    WHERE target_integration_id = ANY (v_integration_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_report := v_report || jsonb_build_object(
      'scope', v_scope, 'item', 'admin_access_audit (matched by integration)', 'rows', v_count);

    -- The claim's FK is SET NULL so it normally outlives the org. A full wipe
    -- removes it, and with it the block on a second free plan for the store.
    DELETE FROM public.billing_free_plan_claims c
    WHERE c.org_id IS DISTINCT FROM v_org_id
      AND EXISTS (
        SELECT 1
        FROM public.integrations i
        WHERE i.org_id = v_org_id
          AND i.platform_type = c.platform_type
          AND i.platform_store_url = c.shop_domain
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_report := v_report || jsonb_build_object(
      'scope', v_scope, 'item', 'billing_free_plan_claims (other org_id, matched by store)', 'rows', v_count);

    DELETE FROM public.billing_free_plan_claims WHERE org_id = v_org_id;

    -- 2. Credit and billing rows. Their foreign keys do not cascade, and two
    -- triggers refuse deletes. The triggers are off only inside this
    -- transaction; other sessions wait on the table lock until it ends.
    ALTER TABLE public.credit_ledger_entries DISABLE TRIGGER credit_ledger_immutable;
    ALTER TABLE public.payment_purchases DISABLE TRIGGER payment_purchase_no_delete;

    DELETE FROM public.credit_ledger_entries WHERE org_id = v_org_id;
    DELETE FROM public.billing_reconciliation_attempts WHERE org_id = v_org_id;
    DELETE FROM public.billing_reconciliation_findings WHERE org_id = v_org_id;
    DELETE FROM public.payment_provider_events WHERE org_id = v_org_id;
    DELETE FROM public.credit_reservations WHERE org_id = v_org_id;
    DELETE FROM public.payment_purchases WHERE org_id = v_org_id;
    DELETE FROM public.credit_accounts WHERE org_id = v_org_id;

    ALTER TABLE public.credit_ledger_entries ENABLE TRIGGER credit_ledger_immutable;
    ALTER TABLE public.payment_purchases ENABLE TRIGGER payment_purchase_no_delete;

    -- 3. Order data, children first. These tables point at orders or
    -- integrations without a cascade, and Postgres checks those links before
    -- the organization's own cascade has finished, so the order matters.
    DELETE FROM public.verification_message_dispatches WHERE org_id = v_org_id;
    DELETE FROM public.webhook_events WHERE org_id = v_org_id;
    DELETE FROM public.verifications WHERE org_id = v_org_id;
    DELETE FROM public.order_import_batches WHERE org_id = v_org_id;
    DELETE FROM public.orders WHERE org_id = v_org_id;
    DELETE FROM public.integration_monthly_usage WHERE org_id = v_org_id;
    DELETE FROM public.integrations WHERE org_id = v_org_id;

    -- 4. The organization. What is left (memberships, settings, pending
    -- installs) cascades from it.
    DELETE FROM public.organizations WHERE id = v_org_id;

    -- 5. Safety net: a table added later without a cascade must fail here
    -- instead of leaving orphans.
    FOR v_table IN
      SELECT c.relname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND a.attname = 'org_id'
        AND NOT a.attisdropped
    LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE org_id = $1', v_table)
        INTO v_count USING v_org_id;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'Table % still has % row(s) for organization %. Add it to this script. Nothing was changed.',
          v_table, v_count, v_org_id;
      END IF;
    END LOOP;

    IF v_dry_run THEN
      RAISE EXCEPTION 'dry run' USING ERRCODE = 'AK001';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'AK001' THEN
      NULL;  -- the sub-block's changes are rolled back; v_report is kept
  END;

  INSERT INTO akeed_delete_report (scope, item, row_count)
  VALUES (
    'RESULT',
    CASE WHEN v_dry_run
      THEN 'DRY RUN: nothing was changed. Set v_dry_run to false to delete.'
      ELSE 'DELETED. The rows below are gone.'
    END,
    NULL
  );

  INSERT INTO akeed_delete_report (scope, item, row_count)
  SELECT e.value ->> 'scope', e.value ->> 'item', (e.value ->> 'rows')::bigint
  FROM jsonb_array_elements(v_report) WITH ORDINALITY AS e(value, position)
  ORDER BY e.position;
END $$;

SELECT scope, item, row_count FROM akeed_delete_report ORDER BY seq;
