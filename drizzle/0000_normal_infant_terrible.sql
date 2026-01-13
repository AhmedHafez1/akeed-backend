-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'sent', 'delivered', 'confirmed', 'canceled', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan_type" text DEFAULT 'free',
	"wa_phone_number_id" text,
	"wa_business_account_id" text,
	"wa_access_token" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "organizations_slug_key" UNIQUE("slug"),
	CONSTRAINT "organizations_plan_type_check" CHECK (plan_type = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text]))
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "memberships_org_id_user_id_key" UNIQUE("org_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text]))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform_type" text NOT NULL,
	"platform_store_url" text NOT NULL,
	"access_token" text,
	"webhook_secret" text,
	"is_active" boolean DEFAULT true,
	"last_synced_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "integrations_platform_type_platform_store_url_key" UNIQUE("platform_type","platform_store_url"),
	CONSTRAINT "integrations_platform_type_check" CHECK (platform_type = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text]))
);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid,
	"external_order_id" text NOT NULL,
	"order_number" text,
	"customer_phone" text NOT NULL,
	"customer_name" text,
	"customer_email" text,
	"total_price" numeric(12, 2),
	"currency" text DEFAULT 'SAR',
	"payment_method" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_external_order_per_integration" UNIQUE("integration_id","external_order_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'pending',
	"wa_message_id" text,
	"template_name" text DEFAULT 'cod_verification',
	"language_code" text DEFAULT 'ar',
	"attempts" integer DEFAULT 0,
	"last_sent_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_active_verification_per_order" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memberships_org_id" ON "memberships" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_memberships_user_id" ON "memberships" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_integrations_org_id" ON "integrations" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_integrations_platform" ON "integrations" USING btree ("platform_type" bool_ops,"is_active" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_orders_created_at" ON "orders" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_orders_external_id" ON "orders" USING btree ("external_order_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_orders_org_id" ON "orders" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_orders_phone" ON "orders" USING btree ("customer_phone" text_ops);--> statement-breakpoint
CREATE INDEX "idx_verifications_next_retry" ON "verifications" USING btree ("next_retry_at" timestamptz_ops) WHERE (status = ANY (ARRAY['pending'::verification_status, 'sent'::verification_status]));--> statement-breakpoint
CREATE INDEX "idx_verifications_org_id" ON "verifications" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_verifications_status" ON "verifications" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_verifications_wa_id" ON "verifications" USING btree ("wa_message_id" text_ops);--> statement-breakpoint
CREATE POLICY "Owners update organizations" ON "organizations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.role = 'owner'::text))))) WITH CHECK ((id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.role = 'owner'::text)))));--> statement-breakpoint
CREATE POLICY "Users see their organizations" ON "organizations" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Owners manage memberships" ON "memberships" AS PERMISSIVE FOR ALL TO "authenticated" USING ((org_id IN ( SELECT memberships_1.org_id
   FROM memberships memberships_1
  WHERE ((memberships_1.user_id = auth.uid()) AND (memberships_1.role = 'owner'::text))))) WITH CHECK ((org_id IN ( SELECT memberships_1.org_id
   FROM memberships memberships_1
  WHERE ((memberships_1.user_id = auth.uid()) AND (memberships_1.role = 'owner'::text)))));--> statement-breakpoint
CREATE POLICY "Users see own memberships" ON "memberships" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Multi-tenant integrations" ON "integrations" AS PERMISSIVE FOR ALL TO "authenticated" USING ((org_id = get_user_org_id())) WITH CHECK ((org_id = get_user_org_id()));--> statement-breakpoint
CREATE POLICY "Service role inserts orders" ON "orders" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Multi-tenant orders" ON "orders" AS PERMISSIVE FOR ALL TO "authenticated";--> statement-breakpoint
CREATE POLICY "Service role updates verifications" ON "verifications" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Multi-tenant verifications" ON "verifications" AS PERMISSIVE FOR ALL TO "authenticated";
*/