# US-05-06 — Verify API tenant isolation and failure recovery

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-05-05](../05-standalone-order-ingestion-api/US-05-05-server-integration-guide.md)

## User story and value

As a product owner, I want proof that the public ingestion API is safe to pilot, so that customers can trust it with real orders and credentials.

**Business value:** Customers can trust it with real orders and credentials.

## Scope

E05 security, concurrency, documentation and production-like failure acceptance.

**Out of scope:** Broad public rollout or bespoke client implementation.

## Acceptance criteria

1. Two-tenant tests prove credentials, idempotency responses, orders, usage and errors cannot cross organizations.
2. Revocation takes effect for new requests while previously accepted work remains auditable and controlled by source state.
3. Concurrent duplicates, conflicting payloads, database/Redis outage and lost responses recover without duplicate business effects.
4. All documented examples pass; the end-to-end API order reaches dashboard and a valid customer outcome.
5. Existing manual/Shopify workflows and both-mode frontend checks remain green.

## Implementation notes

- **Backend:** Compose guard/controller/repository/worker tests and inject failures at persistence/queue boundaries.
- **Frontend:** Verify key lifecycle, localized errors and API-created order visibility.
- **Data:** Reconcile order, verification, usage and request counts after each fault test.
- **Operations:** Record go/no-go evidence and disable new acceptance, not historical data, if rollback is needed.

## Test requirements

- Run API contract/security suite, E04 journey regression and E01 baseline gates.
- Conduct an authorized pilot with synthetic orders and documented support/recovery steps.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

E08 may reuse the common ingestion boundary only after this gate is complete.

## Evidence and references

**VERIFIED FROM CODE:** Existing tests cover pieces of queues, auth and verification; the cross-boundary API acceptance suite is new work.

- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/orders.repository.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-frontend/src/features/dashboard](../../akeed-frontend/src/features/dashboard)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

