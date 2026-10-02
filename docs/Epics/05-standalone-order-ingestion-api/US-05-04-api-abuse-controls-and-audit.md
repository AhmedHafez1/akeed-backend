# US-05-04 — Add API abuse controls and safe operational errors

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Implemented locally (2026-10-02) — release blocked until US-05-05 and US-05-06; see [evidence](../../US-05-04-API-ABUSE-CONTROLS-EVIDENCE.md)
- **Dependencies:** [US-05-03](US-05-03-idempotency-and-conflict-handling.md)

## User story and value

As an operations owner, I want bounded API load and traceable, safe failures, so that one faulty client cannot exhaust shared verification resources and support can follow any request without seeing secrets or customer data.

**Business value:** The minimum protection needed to pilot a public API safely, without building an operations platform first.

## Scope

MVP controls only: per-integration and global rate limits, a body-size limit, one error envelope with a correlation ID, and structured redacted logs. Everything else is deferred (see below), matching the minimal-operations approach of E04.6 US-04.6-09.

**Out of scope:** An API gateway product, an enterprise SLA, billing for API requests, and the deferred items below.

## Acceptance criteria

1. **Rate limits before ingestion.** A guard on the API route throttles by `integrationId` (not by key, so rotating keys cannot bypass it) and by a global key. Limits are env-configurable (validated in `env-validation.ts`, listed in `.env.example` and `docs/ENVIRONMENT.md`). Throttled requests return 429 `API_RATE_LIMITED` with `Retry-After`, and never reach `StandaloneOrderIngestionService`: no order, event or credit use.
2. **Body-size limit.** The `/api/v1` route has its own body limit (env, default 32 KB) and answers 413 `API_PAYLOAD_TOO_LARGE` before validation or ingestion.
3. **One error envelope.** Auth, validation, conflict, throttle and server errors share `{code, message, correlationId}` with stable codes; no SQL, stack traces or other-tenant data.
4. **Correlation ID.** Every API response carries a correlation ID header (an accepted client-supplied value is echoed only if it matches a safe pattern; otherwise one is generated), and the same ID appears in the logs.
5. **Safe logs as the audit trail.** Each request logs one `buildBackendLog` line with integrationId, key prefix, correlationId, outcome code, duration and orderId when present. No key, hash, phone, name or payload. `npm run log:check` passes.
6. **Frontend.** The API keys tab shows last-used and revoked metadata; key-management errors are localized (AR/EN).

## Implementation notes

- **Backend:** Copy the `OrderImportUploadThrottleGuard` pattern (the shared `ThrottlerStorage`, `storage.increment` with a per-principal key and a named throttler), keyed `order-api:<integrationId>` plus `order-api:global`. The app-wide IP throttler is skipped on this route, as the import upload route does. Keep request limits separate from verification usage, which stays owned by the readiness gates.
- **Storage note:** The MVP uses the default in-memory throttler storage, which is correct for one backend instance. Moving to more than one API instance requires Redis-backed throttler storage first (deferred).
- **Frontend:** Existing `api.*` helpers and semantic tokens only.
- **Data:** No new tables.
- **Operations:** Document the effective limits, the body limit and the client-support triage path ("send us the correlation ID") in the guide (US-05-05).

## Deferred (post-pilot, not in this story)

- A persistent `api_request_log` table, its retention setting and purge job.
- Metrics (rejection rate by code, acceptance latency, queue age) and alerts (sustained 5xx, per-source 429 spikes).
- A tenant-safe correlation-ID lookup endpoint.
- Redis-backed throttler storage.

## Test requirements

- Burst and concurrent load; a rotated-key bypass attempt; oversized bodies; a retry after throttling succeeds.
- Throttled and oversized requests create no order, event or credit use (the ingestion service spy is never called).
- Redaction checks across the auth, validation, conflict and database error paths; the envelope never leaks another tenant's identifiers.
- Satisfy the applicable [shared Definition of Done](../README.md).

## Migration and rollout

Start with documented pilot limits and tune configuration from observed traffic without changing the public contract.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):** The app-wide throttler keys by IP with in-memory storage; the import upload route already uses a per-principal guard on the same storage.

- [akeed-backend/src/app.module.ts](../../../src/app.module.ts) (`ThrottlerModule.forRoot`)
- [akeed-backend/src/modules/order-imports/guards/order-import-upload-throttle.guard.ts](../../../src/modules/order-imports/guards/order-import-upload-throttle.guard.ts)
- [akeed-backend/src/main.ts](../../../src/main.ts) (body parsing, `rawBody`)
- [akeed-backend/src/shared/logging/backend-log.util.ts](../../../src/shared/logging/backend-log.util.ts)
- [akeed-backend/src/shared/config/env-validation.ts](../../../src/shared/config/env-validation.ts)
- [akeed-frontend/src/features/settings](../../../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** The pilot runs the API on a single backend instance (product decision, 2026-10-02).

**EXTERNAL PLATFORM DEPENDENCY:** None.
