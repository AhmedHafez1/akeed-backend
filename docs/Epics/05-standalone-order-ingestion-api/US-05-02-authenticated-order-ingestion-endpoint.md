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

POST /api/v1/orders using Authorization: Bearer <integration-key>, implemented as an `ApiOrderChannelAdapter` over the E04.6 `StandaloneOrderIngestionService.acceptOne` command.

**Out of scope:** Browser calls with embedded secrets, order updates, a batch/bulk API endpoint (file import is E04.6) and outbound status callbacks.

## Acceptance criteria

1. The endpoint accepts externalOrderId, optional orderNumber/customerName, customerPhone, decimal-string totalPrice, currency and paymentMethod.
2. Identity comes exclusively from the validated integration key; supplied orgId/integrationId/platform cannot retarget the request.
3. Valid orders are durably accepted through `StandaloneOrderIngestionService.acceptOne(ctx, input, {channel: 'api', idempotencyKey})` and return orderId, optional verificationId, status and duplicate; acceptance is not delivery confirmation. The controller and `ApiOrderChannelAdapter` contain no persistence, envelope, fingerprint, dispatch, credit or eligibility code.
4. Invalid fields, inactive/unready sources and authentication failure return stable safe errors with no partial business effects.
5. Known non-COD orders follow the manual/API visibility policy and never send; eligible orders use the same entitlement and automation as manual orders.
6. Field validation uses the shared `canonical-order.rules.ts` (E04.6 US-04.6-04) and phone parsing uses the shared `PhoneService.parse` core. Limits, patterns and the currency list are imported, never re-declared. `externalOrderId` is normalized by the shared reference normalizer to `ref:<normalized>`.
7. `'api'` is added to the shared `STANDALONE_INGESTION_CHANNELS`. The Standalone normalizer accepts it with no other change, and no code in `verification-core`, the normalizers or the eligibility strategies reads the channel.
8. Source and readiness failures come from `StandaloneSourceResolver` and `StandaloneSendReadinessService` through an `API_*` code map (for example `API_SOURCE_UNAVAILABLE`, `API_SETUP_INCOMPLETE`, `API_AUTO_VERIFY_DISABLED`), plus the unchanged E04.5 credit codes.

## Implementation notes

- **Backend:** Use a dedicated API-key guard and thin versioned controller. The only new business-facing code is `ApiOrderChannelAdapter` (request DTO → `CanonicalOrderInput`). Everything else is the E04.6 command and its shared services.
- **Frontend:** No order-submission UI; keep key-management/support views compatible with acceptance identifiers.
- **Data:** Use integration-scoped external order identity and persist the acceptance/processing intent consistently.
- **Operations:** Require HTTPS in deployment, do not accept keys in query strings, and emit a correlation ID for accepted/failed requests.

## Test requirements

- Schema validation, source state, bad key, tenant spoofing and non-COD acceptance.
- Verify equivalent manual, file-import and API payloads produce the same normalized values, fingerprints and lifecycle rules.
- An architecture test: the `order-api` module imports only the key guard, the adapter and `StandaloneOrderIngestionService` from the ingestion side.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Keep endpoint restricted to Standalone integrations and pilot clients; idempotency in US-05-03 is required before external release.

## Evidence and references

**VERIFIED FROM CODE:** NormalizedOrder and the shared verification pipeline provide the ingestion core; existing OrdersController only reads orders.

- [akeed-backend/src/modules/orders/orders.controller.ts](../../../src/modules/orders/orders.controller.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../../src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../../src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../../src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../../src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../../src/infrastructure/database/repositories/orders.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

