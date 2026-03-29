ALTER TABLE "shopify_webhook_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "shopify_webhook_events" CASCADE;--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_integration_id_fkey";
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_integration_id_fkey";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;