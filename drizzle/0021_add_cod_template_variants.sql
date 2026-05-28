ALTER TABLE "integrations" ADD COLUMN "cod_template_ar_variant" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "cod_template_en_variant" text DEFAULT 'friendly' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_ar_variant_check" CHECK ("cod_template_ar_variant" = ANY (ARRAY['standard'::text, 'egyptian'::text, 'gulf'::text, 'short'::text]));--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cod_template_en_variant_check" CHECK ("cod_template_en_variant" = ANY (ARRAY['friendly'::text, 'professional'::text, 'direct'::text, 'short'::text]));
