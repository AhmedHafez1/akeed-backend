REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE integrations, integration_monthly_usage, admin_access_audit
FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DO $$
DECLARE
  protected_table text;
  protected_columns text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY['integrations', 'integration_monthly_usage', 'admin_access_audit']
  LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO protected_columns
    FROM pg_attribute
    WHERE attrelid = to_regclass(protected_table) AND attnum > 0 AND NOT attisdropped;
    EXECUTE format(
      'REVOKE INSERT (%s), UPDATE (%s), REFERENCES (%s) ON TABLE %I FROM PUBLIC, anon, authenticated',
      protected_columns, protected_columns, protected_columns, protected_table
    );
  END LOOP;
END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE integrations, integration_monthly_usage, admin_access_audit
TO service_role;
