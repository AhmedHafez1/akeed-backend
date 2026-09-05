# US-05-02 — Accept orders through the Standalone ingestion API

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-05-01](../05-standalone-order-ingestion-api/US-05-01-integration-api-key-lifecycle.md)

## User story and value

As a custom website or delivery-system integrator, I want one authenticated order-submission endpoint, so that I can verify orders without a platform-specific adapter.

**Business value:** I can verify orders without a platform-specific adapter.

## Scope

POST /api/v1/orders using Authorization: Bearer <integration-key> and the canonical order command.

**Out of scope:** Browser calls with embedded secrets, order updates, bulk import and outbound status callbacks.

## Acceptance criteria

1. The endpoint accepts externalOrderId, optional orderNumber/customerName, customerPhone, decimal-string totalPrice, currency and paymentMethod.
2. Identity comes exclusively from the validated integration key; supplied orgId/integrationId/platform cannot retarget the request.
3. Valid orders are durably accepted through shared ingestion and return orderId, optional verificationId, status and duplicate; acceptance is not delivery confirmation.
4. Invalid fields, inactive/unready sources and authentication failure return stable safe errors with no partial business effects.
5. Known non-COD orders follow the manual/API visibility policy and never send; eligible orders use the same entitlement and automation as manual orders.

## Implementation notes

- **Backend:** Use a dedicated API-key guard and thin versioned controller; reuse normalization/command logic from E04.
- **Frontend:** No order-submission UI; keep key-management/support views compatible with acceptance identifiers.
- **Data:** Use integration-scoped external order identity and persist the acceptance/processing intent consistently.
- **Operations:** Require HTTPS in deployment, do not accept keys in query strings, and emit a correlation ID for accepted/failed requests.

## Test requirements

- Schema validation, source state, bad key, tenant spoofing and non-COD acceptance.
- Verify equivalent manual and API payloads produce the same normalized values and lifecycle rules.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Keep endpoint restricted to Standalone integrations and pilot clients; idempotency in US-05-03 is required before external release.

## Evidence and references

**VERIFIED FROM CODE:** NormalizedOrder and the shared verification pipeline provide the ingestion core; existing OrdersController only reads orders.

- [akeed-backend/src/modules/orders/orders.controller.ts](../../akeed-backend/src/modules/orders/orders.controller.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/orders.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

