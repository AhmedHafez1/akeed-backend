-- A merchant's own WhatsApp number.
--
-- "whatsapp_connections" holds an organization's one connected number: the
-- WhatsApp Business Account and phone number Meta reported, how it was
-- connected, its lifecycle state and health, and the AES-256-GCM ciphertext of
-- the business token and registration PIN. States:
--   connecting   -> token stored, setup not finished
--   verifying    -> setup done or reconnected, health not yet confirmed
--   active       -> may send (health is "degraded_class", not a state)
--   offboarded   -> Meta offboarded the account; credentials kept
--   disconnected -> credentials cleared; the ids stay for history
-- Every state but "disconnected" holds the phone number, so the same number
-- cannot be in progress or live for two organizations at once.
--
-- "whatsapp_connect_tickets" is the single-use, expiring hand-off from a
-- signed-in member to the signup page. Only the ticket's SHA-256 is stored.
--
-- "whatsapp_connection_templates" is the per-number copy of each registry
-- template submitted to the merchant's account. "org_id" travels with
-- "connection_id" in one foreign key, so a row can never name another
-- organization's connection.
--
-- Every statement can run twice.
--
-- Rollback: DROP TABLE "whatsapp_connection_templates"; DROP TABLE
-- "whatsapp_connect_tickets"; DROP TABLE "whatsapp_connections". No existing
-- data is rewritten.
CREATE TABLE IF NOT EXISTS "whatsapp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"signup_path" text NOT NULL,
	"state" text NOT NULL,
	"state_reason" text,
	"business_token_encrypted" text,
	"registration_pin_encrypted" text,
	"degraded_class" text,
	"degraded_since" timestamp with time zone,
	"quality_rating" text,
	"name_status" text,
	"last_health_at" timestamp with time zone,
	"thank_you_enabled" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "whatsapp_connections_org_id_key" UNIQUE ("org_id"),
	CONSTRAINT "whatsapp_connections_id_org_id_key" UNIQUE ("id", "org_id"),
	CONSTRAINT "whatsapp_connections_waba_id_check" CHECK ("waba_id" ~ '^[0-9]{1,32}$'),
	CONSTRAINT "whatsapp_connections_phone_number_id_check" CHECK ("phone_number_id" ~ '^[0-9]{1,32}$'),
	CONSTRAINT "whatsapp_connections_display_phone_number_check" CHECK ("display_phone_number" IS NULL OR char_length("display_phone_number") BETWEEN 1 AND 32),
	CONSTRAINT "whatsapp_connections_signup_path_check" CHECK ("signup_path" IN ('coexistence', 'new_number')),
	CONSTRAINT "whatsapp_connections_state_check" CHECK ("state" IN ('connecting', 'verifying', 'active', 'offboarded', 'disconnected')),
	CONSTRAINT "whatsapp_connections_degraded_class_check" CHECK ("degraded_class" IS NULL OR "degraded_class" IN ('credentials', 'payment', 'restricted')),
	CONSTRAINT "whatsapp_connections_degraded_since_check" CHECK (("degraded_class" IS NULL) = ("degraded_since" IS NULL)),
	-- Ciphertext only: the `v1:` envelope written by encryptToken.
	CONSTRAINT "whatsapp_connections_business_token_encrypted_check" CHECK ("business_token_encrypted" IS NULL OR "business_token_encrypted" LIKE 'v1:%'),
	CONSTRAINT "whatsapp_connections_registration_pin_encrypted_check" CHECK ("registration_pin_encrypted" IS NULL OR "registration_pin_encrypted" LIKE 'v1:%'),
	-- A disconnect clears every credential; any other state holds the token.
	CONSTRAINT "whatsapp_connections_credentials_check" CHECK (
		CASE WHEN "state" = 'disconnected'
			THEN "business_token_encrypted" IS NULL AND "registration_pin_encrypted" IS NULL AND "disconnected_at" IS NOT NULL
			ELSE "business_token_encrypted" IS NOT NULL
		END
	)
);--> statement-breakpoint
-- One number, one organization, from the first stored token until disconnect.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_connections_live_phone_number_key" ON "whatsapp_connections" USING btree ("phone_number_id") WHERE "state" <> 'disconnected';--> statement-breakpoint
-- Account-level webhooks are routed by WABA id.
CREATE INDEX IF NOT EXISTS "idx_whatsapp_connections_waba" ON "whatsapp_connections" USING btree ("waba_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_connect_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_connect_tickets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "whatsapp_connect_tickets_token_hash_key" UNIQUE ("token_hash"),
	CONSTRAINT "whatsapp_connect_tickets_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "whatsapp_connect_tickets_expiry_check" CHECK ("expires_at" > "created_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_connect_tickets_org_created" ON "whatsapp_connect_tickets" USING btree ("org_id", "created_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_connection_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"meta_template_id" text,
	"meta_language_code" text NOT NULL,
	"status" text DEFAULT 'not_submitted' NOT NULL,
	"category" text,
	"quality" text,
	"rejection_reason" text,
	"submitted_at" timestamp with time zone,
	"status_event_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_connection_templates_connection_fkey" FOREIGN KEY ("connection_id", "org_id") REFERENCES "whatsapp_connections"("id", "org_id") ON DELETE CASCADE,
	CONSTRAINT "whatsapp_connection_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id"),
	CONSTRAINT "whatsapp_connection_templates_connection_template_key" UNIQUE ("connection_id", "template_id"),
	CONSTRAINT "whatsapp_connection_templates_meta_template_id_check" CHECK ("meta_template_id" IS NULL OR "meta_template_id" ~ '^[0-9]{1,32}$'),
	CONSTRAINT "whatsapp_connection_templates_status_check" CHECK (char_length("status") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_connection_templates_template" ON "whatsapp_connection_templates" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whatsapp_connection_templates_org" ON "whatsapp_connection_templates" USING btree ("org_id");--> statement-breakpoint
-- All three tables hold credentials, ticket hashes or per-merchant provider
-- state and are read and written only by the API. Supabase grants new tables
-- to anon and authenticated by default, so those grants are withdrawn.
ALTER TABLE "whatsapp_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_connections" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
ALTER TABLE "whatsapp_connect_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_connect_tickets" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
ALTER TABLE "whatsapp_connection_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "whatsapp_connection_templates" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages whatsapp connection templates" ON "whatsapp_connection_templates";--> statement-breakpoint
CREATE POLICY "Service role manages whatsapp connection templates" ON "whatsapp_connection_templates" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
