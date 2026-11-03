-- Setup and template provisioning for a merchant's own WhatsApp number.
--
-- After signup stores a connection as "connecting", a background job subscribes
-- Akeed's app to the merchant's WhatsApp Business Account, confirms the number
-- with Meta, registers it on the new-number path, and submits the registry's
-- templates. The row is the record of that work; a queue job only nudges it.
--
-- "whatsapp_connections" gains:
--   signup_generation -> raised by every signup that replaces the row, which
--                        keeps its id; a job carries the generation it was
--                        queued for, and an older one changes nothing
--   setup_*           -> where setup is, its lease, retries and last error code
--   *_at              -> when each step finished
--   provider_*        -> what Meta reported about the number
-- setup_status:
--   pending   -> waiting for its next attempt
--   running   -> claimed by a worker until setup_lease_until
--   failed    -> the last attempt failed; retried at setup_next_attempt_at
--   exhausted -> stopped; needs staff
--   complete  -> every step done
--
-- "whatsapp_connection_templates" gains a claim and retry schedule per
-- template, the hash of the text Akeed submitted, and drift marks for staff.
--
-- Every statement can run twice. Existing rows start as pending at the first
-- step, so a connection saved before this migration is set up by the sweep.
--
-- Rollback: drop the added columns, constraints and index. No existing data is
-- rewritten.
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "signup_generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_step" text DEFAULT 'subscribe' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_error_code" text;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "subscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "number_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "provider_is_on_biz_app" boolean;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD COLUMN IF NOT EXISTS "provider_platform_type" text;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_status_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_status_check" CHECK ("setup_status" IN ('pending', 'running', 'failed', 'exhausted', 'complete'));--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_step_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_step_check" CHECK ("setup_step" IN ('subscribe', 'verify_number', 'register', 'provision', 'done'));--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_attempts_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_attempts_check" CHECK ("setup_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_signup_generation_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_signup_generation_check" CHECK ("signup_generation" >= 1);--> statement-breakpoint
-- A running claim always has a lease; a finished setup is at its last step.
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_lease_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_lease_check" CHECK ("setup_status" <> 'running' OR "setup_lease_until" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_complete_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_complete_check" CHECK (("setup_status" = 'complete') = ("setup_step" = 'done'));--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_setup_error_code_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_setup_error_code_check" CHECK ("setup_error_code" IS NULL OR "setup_error_code" ~ '^[a-z0-9_]{1,64}$');--> statement-breakpoint
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_provider_platform_type_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_provider_platform_type_check" CHECK ("provider_platform_type" IS NULL OR "provider_platform_type" ~ '^[A-Z_]{1,32}$');--> statement-breakpoint
-- The sweep reads only setups that still have work.
CREATE INDEX IF NOT EXISTS "idx_whatsapp_connections_setup_due" ON "whatsapp_connections" USING btree ("setup_next_attempt_at") WHERE "setup_status" IN ('pending', 'failed', 'running');--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "submitted_components_hash" text;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "drift_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "drift_reason" text;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD COLUMN IF NOT EXISTS "last_error_code" text;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" DROP CONSTRAINT IF EXISTS "whatsapp_connection_templates_attempts_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD CONSTRAINT "whatsapp_connection_templates_attempts_check" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" DROP CONSTRAINT IF EXISTS "whatsapp_connection_templates_components_hash_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD CONSTRAINT "whatsapp_connection_templates_components_hash_check" CHECK ("submitted_components_hash" IS NULL OR "submitted_components_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" DROP CONSTRAINT IF EXISTS "whatsapp_connection_templates_drift_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD CONSTRAINT "whatsapp_connection_templates_drift_check" CHECK ((("drift_at" IS NULL) = ("drift_reason" IS NULL)) AND ("drift_reason" IS NULL OR "drift_reason" IN ('registry_edited', 'provider_differs')));--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" DROP CONSTRAINT IF EXISTS "whatsapp_connection_templates_last_error_code_check";--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ADD CONSTRAINT "whatsapp_connection_templates_last_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z0-9_]{1,64}$');
