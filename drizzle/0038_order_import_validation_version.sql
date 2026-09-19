-- US-04.6-04: records which row rules last judged an import batch, so a
-- batch's outcomes stay reproducible when the rules change.
--
-- Additive only: one nullable column. NULL means never validated.
--
-- Rollback: nothing reads it outside order imports; it can stay.
ALTER TABLE "order_import_batches" ADD COLUMN IF NOT EXISTS "validation_version" integer;
