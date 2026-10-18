-- The store logo header is on for every store.
--
-- "integrations"."logo_header_enabled" stays as the staff switch that stops one
-- store sending its banner, but it is now on unless staff switch it off: the
-- default becomes true and every store is switched on. A store still sends its
-- banner only when it has saved a logo and the template has an active image
-- twin; every other message goes out as text, as before.

ALTER TABLE "integrations" ALTER COLUMN "logo_header_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "integrations" SET "logo_header_enabled" = true WHERE "logo_header_enabled" = false;
