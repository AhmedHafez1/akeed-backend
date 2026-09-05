# US-05-04 — Add API abuse controls and safe operational errors

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-05-03](../05-standalone-order-ingestion-api/US-05-03-idempotency-and-conflict-handling.md)

## User story and value

As a operations owner, I want bounded ingestion load and traceable failures, so that one faulty client cannot exhaust shared verification resources.

**Business value:** One faulty client cannot exhaust shared verification resources.

## Scope

Rate/payload limits, structured errors, request auditing and secret/PII minimization.

**Out of scope:** An API gateway product, enterprise SLA or billing for API requests.

## Acceptance criteria

1. Configured per-integration and broader abuse limits are enforced; rotating keys cannot bypass the source-level quota.
2. Throttled requests return 429 and retry guidance without creating orders or consuming verification usage.
3. Validation/auth/conflict/server errors use stable machine-readable codes and a correlation ID without leaking another tenant's data.
4. Audit records contain safe source/key-prefix/request identifiers, outcome and timing; tokens and full customer payloads are excluded.
5. Payload-size limits, retention settings and effective rate configuration are documented and covered by tests.

## Implementation notes

- **Backend:** Apply controls before expensive normalization/queue work and distinguish API request limits from verification plan usage.
- **Frontend:** Render key last-used/revoked metadata and readable errors in localized management/support surfaces.
- **Data:** Store only minimum audit metadata with a configurable retention policy; do not duplicate raw customer payload in logs.
- **Operations:** Monitor rejection rate, queue age and acceptance failures; publish configuration and a client-support triage procedure.

## Test requirements

- Burst/concurrent load, rotated-key bypass attempts, oversized bodies and retry after throttling.
- Redaction checks across auth, provider and database error paths; tenant-safe correlation lookup.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Start with documented pilot limits and adjust configuration based on observed traffic without changing the public contract.

## Evidence and references

**VERIFIED FROM CODE:** Existing queue/repository infrastructure supports asynchronous work and structured logs; the proposed API needs its own controls.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

