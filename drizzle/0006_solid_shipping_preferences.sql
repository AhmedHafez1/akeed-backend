ALTER TABLE "integrations"
ADD COLUMN "shipping_currency" text DEFAULT 'USD' NOT NULL;
--> statement-breakpoint
ALTER TABLE "integrations"
ADD COLUMN "avg_shipping_cost" numeric(10, 2) DEFAULT '3' NOT NULL;
