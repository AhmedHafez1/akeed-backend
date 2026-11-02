-- Tips & updates campaigns gain a display switch: with `show_as_banner` on,
-- merchants also see the campaign as a slim banner on the dashboard and the
-- confirmations list, beside its card in the Tips & updates menu. Admins flip
-- it at any time before archiving; it is not content, so it never changes
-- the campaign's revision or its review.
--
-- Rollback: deploy the previous release and run:
--   ALTER TABLE "tips_campaigns" DROP COLUMN IF EXISTS "show_as_banner";
ALTER TABLE "tips_campaigns" ADD COLUMN IF NOT EXISTS "show_as_banner" boolean DEFAULT false NOT NULL;
