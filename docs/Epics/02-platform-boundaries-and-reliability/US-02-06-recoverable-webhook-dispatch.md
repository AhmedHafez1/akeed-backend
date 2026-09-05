# US-02-06 — Recover events after queue dispatch failure

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 6 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented — staging migration and Redis outage drill pending 2026-09-03
- **Dependencies:** [US-02-05](../02-platform-boundaries-and-reliability/US-02-05-source-identity-and-safe-disconnect.md)

## User story and value

As a operations owner, I want every durably accepted event to remain recoverable, so that a Redis outage cannot silently lose merchant orders.

**Business value:** A Redis outage cannot silently lose merchant orders.

## Scope

Persisted-event dispatch recovery, stable deduplication and operational visibility.

**Out of scope:** Kafka, microservices, or claiming exactly-once provider delivery.

## Acceptance criteria

1. If database persistence succeeds and queue.add fails, a retry/reconciler can dispatch the existing pending event.
2. Concurrent recovery attempts use a claim/lease or equivalent atomic guard and cannot create multiple verifications or quota charges.
3. Completed events remain replay-safe; stale processing events are diagnosed/recovered without repeating completed business effects.
4. Missing provider delivery IDs use a documented deterministic source/event identity where available; malformed unidentifiable events are rejected/quarantined instead of timestamp-only deduplication.
5. Pending age, retries and terminal failures are visible with a safe manual recovery procedure.

## Implementation notes

- **Backend:** Use existing PostgreSQL event persistence and BullMQ as the outbox/reconciliation foundation.
- **Frontend:** No new merchant page required; preserve current ingress response contracts.
- **Data:** Migration preserves existing event IDs/statuses and expands source-scoped uniqueness where required without collapsing unrelated tenants.
- **Operations:** Acknowledge success only after durable acceptance; add reconciliation health/error reporting with bounded retries.

## Test requirements

- Crash/queue failure after insert, retry collision, Redis recovery and already-completed replay.
- Multiple tenants using identical idempotency strings; deterministic missing-header fallback.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable reconciliation cautiously on a bounded existing pending-event set; dry-run and report counts first.

## Evidence and references

**Implementation evidence (2026-09-03):** [US-02-06 evidence](../../akeed-backend/docs/US-02-06-RECOVERABLE-WEBHOOK-DISPATCH-EVIDENCE.md) records the PostgreSQL outbox fields, atomic dispatch/processing claims, deterministic missing-header identity, bounded reconciliation, operational SQL, and verification results.

**Reproduced E01 defect (2026-08-31):** [E01 evidence](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md) and the isolated PostgreSQL contract demonstrate a durable pending event after `queue.add` rejection, followed by duplicate redelivery that does not enqueue it. **Owner: E02 backend reliability implementer.** Keep this P0 recovery work prominent; E01 characterization does not repair lost dispatch.

**VERIFIED FROM CODE:** The producer inserts an event before queue.add and exits early on duplicate insertion, leaving a recovery gap.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts)
- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Shopify — Webhooks](https://shopify.dev/docs/apps/build/webhooks)
