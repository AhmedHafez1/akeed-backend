-- Tips and updates: admin-published dashboard cards.
--
-- An admin writes a campaign (a tip or a feature update), picks an audience
-- of organizations with an active store, reviews it and publishes it. The
-- recipient list is frozen at publication: one row per campaign and
-- organization, which also holds that account's first view, first click and
-- permanent dismissal. Visibility is read at request time from the campaign's
-- status and expiry; nothing is scheduled. "Expired" is never stored.
--
-- Rollback (drops every campaign, translation and recipient):
--   DROP TABLE IF EXISTS "tips_campaign_recipients";
--   DROP TABLE IF EXISTS "tips_campaign_translations";
--   DROP TABLE IF EXISTS "tips_campaigns";
CREATE TABLE IF NOT EXISTS "tips_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "action_kind" text,
  "action_route" text,
  "action_url" text,
  "expires_at" timestamp with time zone,
  "targeting_mode" text DEFAULT 'filters' NOT NULL,
  "audience_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "selected_org_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "excluded_org_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "reviewed_revision" integer,
  "reviewed_audience_hash" text,
  "reviewed_recipient_count" integer,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" uuid,
  "published_at" timestamp with time zone,
  "published_by" uuid,
  "published_review_token" text,
  "recipient_count" integer,
  "paused_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "created_by" uuid NOT NULL,
  "updated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tips_campaigns_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "tips_campaigns_type_check" CHECK ("type" IN ('tip', 'update')),
  CONSTRAINT "tips_campaigns_status_check" CHECK ("status" IN ('draft', 'published', 'paused', 'archived')),
  CONSTRAINT "tips_campaigns_targeting_mode_check" CHECK ("targeting_mode" IN ('direct', 'filters')),
  CONSTRAINT "tips_campaigns_action_check" CHECK (
    ("action_kind" IS NULL AND "action_route" IS NULL AND "action_url" IS NULL)
    OR ("action_kind" = 'internal' AND "action_route" ~ '^[a-z_]{1,64}$' AND "action_url" IS NULL)
    OR ("action_kind" = 'external' AND "action_route" IS NULL AND "action_url" LIKE 'https://%' AND char_length("action_url") <= 2048)
  ),
  CONSTRAINT "tips_campaigns_org_lists_check" CHECK (cardinality("selected_org_ids") <= 500 AND cardinality("excluded_org_ids") <= 500),
  CONSTRAINT "tips_campaigns_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "tips_campaigns_published_check" CHECK ("status" IN ('draft', 'archived') OR ("published_at" IS NOT NULL AND "recipient_count" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tips_campaigns_status_published" ON "tips_campaigns" USING btree ("status", "published_at" DESC, "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tips_campaigns_created" ON "tips_campaigns" USING btree ("created_at" DESC, "id");--> statement-breakpoint
ALTER TABLE "tips_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "tips_campaigns" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages tips campaigns" ON "tips_campaigns";--> statement-breakpoint
CREATE POLICY "Service role manages tips campaigns" ON "tips_campaigns" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tips_campaign_translations" (
  "campaign_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "action_label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tips_campaign_translations_pkey" PRIMARY KEY ("campaign_id", "locale"),
  CONSTRAINT "tips_campaign_translations_campaign_fkey" FOREIGN KEY ("campaign_id") REFERENCES "tips_campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "tips_campaign_translations_locale_check" CHECK ("locale" IN ('ar', 'en', 'ur', 'es', 'fr', 'tr')),
  CONSTRAINT "tips_campaign_translations_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 80),
  CONSTRAINT "tips_campaign_translations_description_check" CHECK (char_length(btrim("description")) BETWEEN 1 AND 500),
  CONSTRAINT "tips_campaign_translations_action_label_check" CHECK ("action_label" IS NULL OR char_length(btrim("action_label")) BETWEEN 1 AND 30)
);--> statement-breakpoint
ALTER TABLE "tips_campaign_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "tips_campaign_translations" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages tips campaign translations" ON "tips_campaign_translations";--> statement-breakpoint
CREATE POLICY "Service role manages tips campaign translations" ON "tips_campaign_translations" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tips_campaign_recipients" (
  "campaign_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "first_viewed_at" timestamp with time zone,
  "first_clicked_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  CONSTRAINT "tips_campaign_recipients_pkey" PRIMARY KEY ("campaign_id", "org_id"),
  CONSTRAINT "tips_campaign_recipients_campaign_fkey" FOREIGN KEY ("campaign_id") REFERENCES "tips_campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "tips_campaign_recipients_org_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tips_campaign_recipients_org_open" ON "tips_campaign_recipients" USING btree ("org_id", "campaign_id") WHERE "dismissed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tips_campaign_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "tips_campaign_recipients" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP POLICY IF EXISTS "Service role manages tips campaign recipients" ON "tips_campaign_recipients";--> statement-breakpoint
CREATE POLICY "Service role manages tips campaign recipients" ON "tips_campaign_recipients" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
