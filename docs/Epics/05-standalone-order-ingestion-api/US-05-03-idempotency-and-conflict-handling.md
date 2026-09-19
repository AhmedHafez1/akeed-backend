# US-05-03 — Make API retries idempotent and conflict-safe

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-05-02](../05-standalone-order-ingestion-api/US-05-02-authenticated-order-ingestion-endpoint.md)

## User story and value

As a API integrator, I want to retry uncertain requests safely, so that network failures cannot send duplicate customer messages or consume extra usage.

**Business value:** Network failures cannot send duplicate customer messages or consume extra usage.

## Scope

Mandatory Idempotency-Key, stable acceptance replay, payload conflicts and concurrent submission.

**Out of scope:** Exactly-once guarantees from Meta or treating a repeated create as an order update.

## Acceptance criteria

1. Missing/empty Idempotency-Key is rejected before creation; the key is scoped to integration and endpoint, not to a particular credential.
2. Same key and equivalent normalized business payload return the original acceptance identifiers with duplicate=true, including after credential rotation.
3. The same key with changed business content returns 409 conflict with no additional order/verification/reservation.
4. Concurrent equal requests resolve to one durable acceptance; database success followed by lost response remains recoverable.
5. A new idempotency key for an existing externalOrderId cannot duplicate or silently overwrite it; identical create is replayed, conflicting create is rejected.
6. All of the above is implemented **inside `StandaloneOrderIngestionService`**, not in the API layer, so manual, file import and API share one set of idempotency semantics:
   - key namespacing per channel (`api:<key>`);
   - fingerprinting via `fingerprintCanonicalOrder` over canonical business fields only, never the channel;
   - existing-external-ID replay or conflict with no new event on replay.
7. **Cross-channel identity:** an API create whose `ref:<normalized externalOrderId>` matches an order previously imported by file (or created by API) replays with `duplicate=true` when the canonical fingerprint matches and returns 409 `API_ORDER_EXTERNAL_ID_CONFLICT` otherwise. Either way it creates no second event, verification, message or credit hold.

## Implementation notes

- **Backend:** Reuse `fingerprintCanonicalOrder` and the shared idempotency-key validator (E04.6). Add the existing-external-ID replay and conflict branch to `acceptWithinTransaction` once, so all channels inherit it. Use transactional uniqueness and the common recoverable-dispatch path.
- **Frontend:** Display actionable duplicate/conflict explanations in API guidance; no special dashboard deduplication layer.
- **Data:** Retain idempotency identity while its accepted order is retained; privacy redaction must handle associated payloads consistently.
- **Operations:** Document stable retry behavior and no-edit semantics; do not expire deduplication silently while an order can still be replayed.

## Test requirements

- Concurrent identical/conflicting requests; reordered JSON keys; credential rotation; timeout after persistence.
- Same key/external ID in two integrations, and a new key targeting an existing order.
- The same order created by file import and then by API (identical and conflicting), and an API key string equal to a manual key string (no collision).
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Backfill no speculative client keys; release API only after concurrency and crash-recovery tests pass.

## Evidence and references

**VERIFIED FROM CODE:** Existing webhook events and orders already have uniqueness foundations, but API-specific request identity/replay records do not exist.

- [akeed-backend/src/infrastructure/database/schema.ts](../../../src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../../src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../../src/infrastructure/database/repositories/webhook-events.repository.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../../src/infrastructure/database/repositories/orders.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

