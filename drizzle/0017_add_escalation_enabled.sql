ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "escalation_enabled" boolean DEFAULT true NOT NULL;
