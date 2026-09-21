-- US-04.6-07: start confirmation and paced release of imported orders.
--
-- Additive only: three nullable-or-defaulted columns, one unique constraint,
-- one partial index and one guard trigger on order_import_batches.
--   quiet_hours_until  when a releasing batch is waiting out the store's quiet
--                      hours, the instant sending resumes (display only).
--   stopped_at         when the merchant stopped the remaining orders.
--   events             append-only log of batch transitions (started, paused,
--                      resumed, stopped, completed, not_started).
-- The attestation columns already exist (0037). Once a batch is attested they
-- are the policy record of the merchant's consent, so the trigger refuses to
-- change them afterwards.
--
-- Rollback: turn STANDALONE_BULK_IMPORT_ENABLED off. The columns can stay;
-- drop the trigger before any manual repair that must rewrite attestation.
ALTER TABLE "order_import_batches" ADD COLUMN IF NOT EXISTS "quiet_hours_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD COLUMN IF NOT EXISTS "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD COLUMN IF NOT EXISTS "events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'order_import_batches_start_key'
	) THEN
		ALTER TABLE "order_import_batches"
			ADD CONSTRAINT "order_import_batches_start_key" UNIQUE ("org_id", "start_idempotency_key");
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_import_batches_releasing" ON "order_import_batches" USING btree ("org_id") WHERE "status" = 'releasing';--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_order_import_attestation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.attested_at IS NOT NULL AND (
		NEW.attested_at IS DISTINCT FROM OLD.attested_at
		OR NEW.attested_by IS DISTINCT FROM OLD.attested_by
		OR NEW.attestation_version IS DISTINCT FROM OLD.attestation_version
		OR NEW.start_idempotency_key IS DISTINCT FROM OLD.start_idempotency_key
	) THEN
		RAISE EXCEPTION 'order_import_attestation_immutable' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS order_import_attestation_immutable ON "order_import_batches";--> statement-breakpoint
CREATE TRIGGER order_import_attestation_immutable BEFORE UPDATE ON "order_import_batches" FOR EACH ROW EXECUTE FUNCTION protect_order_import_attestation();
