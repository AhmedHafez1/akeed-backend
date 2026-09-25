-- Payment-value classification remembered per store, whatever the file's
-- headers. Upload consults the exact-headers mapping profile first, then this
-- table, then the automatic guess; saving a mapping upserts the choices for
-- the values that file showed.
--
-- Rollback: DROP TABLE "order_import_payment_classifications".
-- No existing data is rewritten.
CREATE TABLE IF NOT EXISTS "order_import_payment_classifications" (
	"org_id" uuid NOT NULL,
	"normalized_value" text NOT NULL,
	"classification" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_payment_classifications_pkey" PRIMARY KEY ("org_id", "normalized_value"),
	CONSTRAINT "order_import_payment_classifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "order_import_payment_classifications_classification_check" CHECK ("classification" IN ('cod', 'not_cod')),
	CONSTRAINT "order_import_payment_classifications_value_check" CHECK (char_length("normalized_value") BETWEEN 1 AND 255)
);--> statement-breakpoint
-- Row-level security matches the other import tables; the API still scopes
-- every query by org_id.
ALTER TABLE "order_import_payment_classifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "Multi-tenant order import payment classifications" ON "order_import_payment_classifications";--> statement-breakpoint
CREATE POLICY "Multi-tenant order import payment classifications" ON "order_import_payment_classifications" AS PERMISSIVE FOR ALL TO authenticated USING (org_id = get_user_org_id()) WITH CHECK (org_id = get_user_org_id());
