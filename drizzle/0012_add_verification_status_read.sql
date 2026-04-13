DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'read'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'verification_status')
  ) THEN
    ALTER TYPE "public"."verification_status" ADD VALUE 'read' AFTER 'delivered';
  END IF;
END
$$;
