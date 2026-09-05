# US-08-03 — Ingest and normalize EasyOrders order webhooks

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-08-02](../08-easyorders-integration/US-08-02-easyorders-authorized-connection.md)

## User story and value

As a EasyOrders merchant, I want new COD orders verified automatically, so that I do not need to copy orders into Akeed.

**Business value:** I do not need to copy orders into Akeed.

## Scope

Authenticated order-created ingress, durable acceptance, normalization and source-scoped duplicate handling.

**Out of scope:** Catalog/shipping sync and unvalidated status-event behavior.

## Acceptance criteria

1. The endpoint verifies the agreed provider secret/authentication before processing and checks payload store_id against the bound integration.
2. Order ID, reference, customer, amount, payment and currency normalize from verified payload/API/store settings; missing currency is not silently guessed.
3. Repeated order-created deliveries produce one logical order/verification using source-scoped identity, even if the provider has no delivery ID.
4. Incomplete payloads use authorized order lookup only when required; rate-limited/transient retrieval failures retry through the common durable pipeline.
5. Unknown event types and status events cannot enter the create path; inactive/unready sources do not send.

## Implementation notes

- **Backend:** Implement the EasyOrders normalizer/eligibility strategy and register it; reuse E02 queue recovery and E05 identity semantics.
- **Frontend:** Show source and safe ingestion/eligibility reasons through the existing dashboard without adapter-specific core logic.
- **Data:** Use provider event ID when validated, otherwise a documented order-created semantic key; namespace it by integration and event type.
- **Operations:** Acknowledge after durable authenticated acceptance, redact secrets and respect the verified provider rate ceiling.

## Test requirements

- COD/non-COD, local/international phone, missing fields, wrong store/secret and malformed event.
- Duplicate/concurrent delivery, fetch throttling, queue outage and disconnected source.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Start with captured synthetic fixtures and qualified pilot stores; keep unsupported topics disabled.

## Evidence and references

**VERIFIED FROM CODE:** The existing queue accepts registered normalizers but currently registers only Shopify; NormalizedOrder already carries the target fields.

- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts](../../akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Get order by ID](https://public-api-docs.easy-orders.net/docs/get-order-by-id)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

