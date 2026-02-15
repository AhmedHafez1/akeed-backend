CREATE TABLE "integration_monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"included_limit" integer NOT NULL,
	"consumed_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "integration_monthly_usage_integration_id_period_start_key" UNIQUE("integration_id","period_start"),
	CONSTRAINT "integration_monthly_usage_included_limit_check" CHECK (included_limit > 0),
	CONSTRAINT "integration_monthly_usage_consumed_count_check" CHECK (consumed_count >= 0),
	CONSTRAINT "integration_monthly_usage_blocked_count_check" CHECK (blocked_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "integration_monthly_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_monthly_usage" ADD CONSTRAINT "integration_monthly_usage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_monthly_usage" ADD CONSTRAINT "integration_monthly_usage_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_monthly_usage_org_id" ON "integration_monthly_usage" USING btree ("org_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_integration_monthly_usage_integration_id" ON "integration_monthly_usage" USING btree ("integration_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_integration_monthly_usage_period_start" ON "integration_monthly_usage" USING btree ("period_start" date_ops);--> statement-breakpoint
CREATE POLICY "Service role updates integration monthly usage" ON "integration_monthly_usage" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Multi-tenant integration monthly usage" ON "integration_monthly_usage" AS PERMISSIVE FOR ALL TO "authenticated" USING ((org_id = get_user_org_id())) WITH CHECK ((org_id = get_user_org_id()));