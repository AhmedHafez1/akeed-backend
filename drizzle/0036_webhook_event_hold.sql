-- US-04.6-01: a source-neutral hold on the durable ingestion event.
--
-- A held event exists (its order is visible to the merchant) but no dispatcher,
-- reconciler or retry may send it until it is explicitly released or withdrawn.
-- Every existing row reads as 'none', so behaviour is unchanged. Additive only:
-- the constant default does not rewrite the table (PostgreSQL 11+).
--
-- Rollback: leave the columns in place. Withdraw every 'held' row before
-- reverting the code that honours the hold in the dispatch predicate.
ALTER TABLE "webhook_events" ADD COLUMN "hold_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "hold_group_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_hold_state_check" CHECK ("hold_state" IN ('none', 'held', 'released', 'withdrawn'));--> statement-breakpoint
-- A held event must never be dispatchable, even if a later write sets the flag
-- by mistake. Release flips both columns in one statement.
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_held_not_dispatchable_check" CHECK ("hold_state" <> 'held' OR "dispatch_required" = false);--> statement-breakpoint
CREATE INDEX "idx_webhook_events_hold_group" ON "webhook_events" USING btree ("hold_group_id","hold_state") WHERE "hold_group_id" IS NOT NULL;
