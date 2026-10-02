# US-05-03 — Extend shared idempotency to external order identity

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler (core)
- **Status:** Backlog
- **Dependencies:** [US-05-02](US-05-02-authenticated-order-ingestion-endpoint.md)

## User story and value

As an API integrator, I want to retry uncertain requests and resend orders Akeed already has, so that network failures and re-syncs never send a customer a second message or consume extra usage.

**Business value:** Safe retries for every channel, from one implementation in the shared core.

## Scope

Extend the **existing** idempotency primitives in the ingestion core so that an order identity which already exists is replayed or rejected instead of failing. All work is in `StandaloneOrderIngestionService` and `ManualOrderIngestionRepository.acceptWithinTransaction`; the API module only maps the resulting errors to `API_*` codes.

**Out of scope:** Exactly-once delivery from Meta, treating a repeated create as an order update, and a separate API idempotency store.

## What the core already guarantees (do not rebuild)

Verified in code on 2026-10-02. These become **regression assertions** for the API channel, not build items:

| Guarantee | Where |
| --- | --- |
| Same namespaced key + same fingerprint → original identifiers, `duplicate=true` | `acceptWithinTransaction`: event insert `onConflictDoNothing` on `(platform, store_domain, idempotency_key)`, then reload |
| Same key + different fingerprint → conflict | `ManualOrderPayloadConflictError` → `StandaloneIngestionConflictError` → channel code |
| Scope is the source, not the credential (survives key rotation) | The event key is unique per `storeDomain` |
| Channel key spaces cannot collide | `namespaceIdempotencyKey` (manual unprefixed, `import:`, and `api:` from US-05-02) |
| Concurrent equal requests → one acceptance | Unique indexes on `webhook_events` and `orders(integration_id, external_order_id)` |
| Commit followed by a lost response is recoverable | Retry takes the duplicate branch and re-dispatches the same event; `assertPersisted` turns a silent rollback into a retryable 503 |
| Fingerprint excludes the channel | `fingerprintCanonicalOrder` hashes only the canonical order; channel metadata sits beside it in `rawPayload` |

## The gap this story closes

A **new** idempotency key whose order identity (`ref:<normalized externalOrderId>`) already exists for the source:

- on the non-held path (`acceptOne`) throws `ManualOrderAcceptanceStateError` today → `…ACCEPTANCE_FAILED` 503, which a client retries forever;
- on the held path (`acceptMany`) returns `already_imported`, which file import reports per row (unchanged by this story).

Even with a replay, `acceptOne` always re-dispatches a duplicate; for an order owned by a held or withdrawn import event that dispatch is not claimed and surfaces as `…DISPATCH_FAILED`.

## Acceptance criteria

1. **External-ID replay (core).** In `acceptWithinTransaction`, when a non-held acceptance finds the order identity already owned by an existing order of the same source, it compares the stored order's `rawPayload.submissionFingerprint` with the incoming fingerprint using the **existing strict fingerprint**. Equal → return the existing order with `duplicate=true`. The just-inserted event is rolled back (savepoint or pre-check), so no new `webhook_events` row remains.
2. **External-ID conflict (core).** Different fingerprint → a new channel-neutral `StandaloneIngestionExternalIdConflictError`, with nothing written. The API maps it to 409 `API_ORDER_EXTERNAL_ID_CONFLICT`.
3. **No dispatch on external-ID replay.** `acceptOne` returns the replay without calling `dispatchById`: no new verification, message or credit hold. An order owned by a **held** import batch stays held until the merchant starts it; a **withdrawn** one stays withdrawn; a released or manual-origin order keeps its lifecycle. The response is the same `duplicate=true` shape in every case.
4. **Existing semantics preserved.** Same-key replay keeps re-dispatching its own event (the lost-response recovery path). Same key with different content keeps returning a conflict: `API_ORDER_IDEMPOTENCY_CONFLICT` for the API, `MANUAL_ORDER_IDEMPOTENCY_CONFLICT` unchanged for manual.
5. **Other channels inherit or are untouched.** Manual cannot reach the new branch (its `externalOrderId` is derived from its key), and its suites are unchanged. `acceptMany` keeps mapping the collision to `already_imported`; the E04.6 contract suite and `standalone-order-ingestion.accept-many.spec.ts` are unchanged.
6. **Cross-channel identity.** An API create whose `ref:` matches an order previously imported by file (or created by API) replays when the canonical orders are identical and returns 409 otherwise — including when only the extras or an import-generated `IMP-…` order number differ.

## Implementation notes

- **Backend:** One branch in `acceptWithinTransaction`, one new error in `standalone-order-ingestion.errors.ts`, and a replay marker on the internal acceptance result so `acceptOne` can skip dispatch. No API-specific code outside the adapter's error mapping.
- **Frontend:** None; the explanation lives in the integration guide (US-05-05).
- **Data:** No migration and no speculative backfill. Idempotency identity lives as long as its order.
- **Operations:** Log the replay kind (`event_key` / `external_id`) through `buildBackendLog`; no payload.

## Test requirements

- Concurrent identical and conflicting requests; reordered JSON keys; credential rotation; a fault injected after commit and before the response.
- The same key or external ID in two integrations (isolated); an API key string equal to an existing manual key (no collision).
- File import then API, for an order whose batch is **held**, **released** and **withdrawn**: identical → `duplicate=true` with the order's state untouched; different (extras or order number) → 409.
- Assert zero extra events, verifications, dispatches and credit holds in every replay and conflict case.
- Manual and E04.6 suites unchanged before and after.
- Satisfy the applicable [shared Definition of Done](../README.md).

## Migration and rollout

Release the API externally only after the concurrency and crash-recovery tests pass.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):**

- [akeed-backend/src/infrastructure/database/repositories/manual-order-ingestion.repository.ts](../../../src/infrastructure/database/repositories/manual-order-ingestion.repository.ts) (`acceptWithinTransaction`, `already_imported`, `assertPersisted`)
- [akeed-backend/src/modules/order-ingestion/standalone-order-ingestion.service.ts](../../../src/modules/order-ingestion/standalone-order-ingestion.service.ts) (duplicate → `dispatchById`)
- [akeed-backend/src/modules/order-ingestion/standalone-ingestion-keys.ts](../../../src/modules/order-ingestion/standalone-ingestion-keys.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-order-ingestion.errors.ts](../../../src/modules/order-ingestion/standalone-order-ingestion.errors.ts)
- [akeed-backend/src/shared/commerce/standalone-order-envelope.ts](../../../src/shared/commerce/standalone-order-envelope.ts) (`fingerprintCanonicalOrder`)
- [akeed-backend/src/modules/order-imports/file-import.channel-adapter.ts](../../../src/modules/order-imports/file-import.channel-adapter.ts) (`IMP-…` order numbers, extras)
- [akeed-backend/src/infrastructure/database/schema.ts](../../../src/infrastructure/database/schema.ts) (unique indexes, `hold_state`)

**ASSUMPTION / REQUIRES VALIDATION:** The acceptance criteria describe approved proposed work, not completed functionality.

**EXTERNAL PLATFORM DEPENDENCY:** None.
