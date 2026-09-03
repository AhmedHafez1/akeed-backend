DO $$
DECLARE
  conflicting_org_count bigint;
  conflicting_org_ids text;
BEGIN
  SELECT count(*), COALESCE(string_agg(org_id::text, ', ' ORDER BY org_id::text), '')
  INTO conflicting_org_count, conflicting_org_ids
  FROM (
    SELECT org_id
    FROM integrations
    WHERE is_active = true
    GROUP BY org_id
    HAVING count(*) > 1
  ) conflicts;

  IF conflicting_org_count > 0 THEN
    RAISE EXCEPTION
      'Active source preflight failed: conflicting_org_count=%, org_ids=%; resolve explicitly before applying US-03-01',
      conflicting_org_count,
      conflicting_org_ids;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN assume_cod_when_payment_missing boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX integrations_one_active_source_per_org_idx ON integrations USING btree (org_id) WHERE is_active = true;
