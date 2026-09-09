ALTER TABLE "public"."verification_message_dispatches"
  ADD COLUMN accounting_mode text NOT NULL DEFAULT 'periodic_plan';
--> statement-breakpoint
ALTER TABLE "public"."verification_message_dispatches"
  ADD CONSTRAINT dispatch_accounting_mode_check CHECK (accounting_mode IN ('periodic_plan', 'prepaid_credit'));
--> statement-breakpoint
CREATE FUNCTION "public".protect_dispatch_accounting_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.org_id, NEW.integration_id, NEW.verification_id, NEW.kind, NEW.generation, NEW.dispatch_key)
      IS DISTINCT FROM ROW(OLD.org_id, OLD.integration_id, OLD.verification_id, OLD.kind, OLD.generation, OLD.dispatch_key)
    OR (NEW.accounting_mode IS DISTINCT FROM OLD.accounting_mode AND
      NOT (OLD.state = 'ready' AND OLD.attempt_count = 0 AND NOT OLD.usage_reserved AND OLD.usage_period_start IS NULL)) THEN
    RAISE EXCEPTION 'Dispatch accounting identity is immutable after claim';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_accounting_identity_immutable BEFORE UPDATE ON "public"."verification_message_dispatches"
  FOR EACH ROW EXECUTE FUNCTION "public".protect_dispatch_accounting_identity();
