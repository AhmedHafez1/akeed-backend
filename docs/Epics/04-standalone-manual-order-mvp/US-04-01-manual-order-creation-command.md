# US-04-01 — Add session-authenticated manual order creation

- **Epic:** [E04 — Standalone Manual Order MVP](README.md)
- **Delivery rank:** 1 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented locally — release blocked (2026-09-04)
- **Dependencies:** [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md)

## User story and value

As a Standalone merchant, I want to create an order directly in Akeed, so that I can verify customer intent without a commerce-platform integration.

**Business value:** I can verify customer intent without a commerce-platform integration.

## Scope

POST /api/orders, input validation, source selection from session and durable creation acceptance.

**Out of scope:** Public API authentication, CSV, order editing and arbitrary organization selection.

## Acceptance criteria

1. Owner/admin sessions can POST customerPhone, optional customerName/orderNumber, totalPrice, currency and paymentMethod for their ready Standalone source.
2. The server derives orgId/integrationId; caller-provided tenant/source IDs are rejected or ignored without changing authority.
3. Phone/amount/currency/payment inputs normalize through the canonical contract; invalid inputs produce field errors before creation.
4. A client-generated stable submission token is reused across retries; repeated matching submission returns the original order while changed content conflicts.
5. Success exposes orderId, optional verificationId, acceptance status and duplicate flag; acceptance never claims that WhatsApp delivery already succeeded.

## Implementation notes

- **Backend:** Use a thin controller and shared ingestion command; generate a source-scoped external ID for manual orders when absent.
- **Frontend:** Define the response/error DTO for the manual form and reuse authenticated API helpers.
- **Data:** Persist the order and durable processing intent consistently; do not create a second manual-only order schema.
- **Operations:** Respect onboarding, inactive-source and entitlement readiness; return actionable blocked reasons.

## Test requirements

- Authorized create, invalid input, forged org/source, viewer denial and repeated/concurrent submission.
- Database/queue failure before and after durable acceptance.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Keep the endpoint restricted to Standalone sources until other platform manual-entry behavior is explicitly approved.

## Evidence and references

**IMPLEMENTED LOCALLY — 2026-09-04:** Owner/admin sessions can durably accept a validated Standalone manual order through `POST /api/orders`. The API requires a source-scoped `Idempotency-Key`, derives tenant/source authority from authentication, returns stable field/readiness/role errors, atomically stores the order and recoverable event, and safely replays concurrent retries. The ignored Next route declarations are regenerated before the inherited frontend gate checks. Local gates pass; the Standalone worker lifecycle, entry UI, target-environment identities, and live provider flow remain release blockers.

- [US-04-01 implementation and validation evidence](../../akeed-backend/docs/US-04-01-MANUAL-ORDER-CREATION-EVIDENCE.md)
- [Manual order API and recovery contract](../../akeed-backend/docs/MANUAL_ORDER_CREATION.md)
- [Manual order command service](../../akeed-backend/src/modules/orders/orders.service.ts)
- [Atomic manual order ingestion repository](../../akeed-backend/src/infrastructure/database/repositories/manual-order-ingestion.repository.ts)
- [PostgreSQL concurrency contract](../../akeed-backend/test/manual-order-ingestion.contract-spec.ts)
- [Frontend manual order API contract](../../akeed-frontend/src/features/orders/api/manualOrderApi.ts)

**VERIFIED FROM CODE:** OrdersController now exposes authenticated reads and manual creation; the shared order schema, durable event schema, and repositories contain the required normalized fields and source-scoped uniqueness constraints.

- [akeed-backend/src/modules/orders/orders.controller.ts](../../akeed-backend/src/modules/orders/orders.controller.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/orders.repository.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Durable acceptance is implemented, but US-04-03 still owns Standalone normalization and verification processing. Do not interpret `status: accepted` as a delivery claim or release the endpoint to merchants before the remaining E04 gates pass.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
