# US-07-03 — Ingest signed WooCommerce order webhooks

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Done (2026-10-04), shipped disabled behind `WOOCOMMERCE_INGESTION_ENABLED`; real-store proof is owed to US-07-06 — [evidence](../../US-07-03-WOOCOMMERCE-INGESTION-EVIDENCE.md)
- **Dependencies:** [US-07-02](US-07-02-connect-woocommerce-through-application-authentication.md)

## User story and value

As a WooCommerce merchant, I want new COD orders verified automatically, so that my WooCommerce workflow benefits from Akeed without manual order copying.

**Business value:** My WooCommerce workflow benefits from Akeed without manual order copying.

## Scope

Signed webhook acceptance for `order.created` and `order.updated`, status-aware start of a verification, normalization, COD eligibility and durable deduplication. Shipped behind `WOOCOMMERCE_INGESTION_ENABLED`.

**Out of scope:** polling, historical import and backfill; order lookups to complete a payload; custom gateways and custom statuses; acting on store-side status changes (US-07-04).

## Acceptance criteria

1. Before any business work the handler checks three things: the per-install delivery URL token (looked up by hash), the raw-body HMAC against that install's webhook secret in constant time, and `X-WC-Webhook-Source` against the bound store. A failure stores nothing and answers `401`; a refused delivery on a valid token is counted.
2. A verification starts at the first delivery, on either topic, where `payment_method` is `cod` and the status is one the contract record lists as placed. A checkout draft or a `pending` order is recorded as skipped with a stable reason and starts nothing. An order created before the source was connected never starts a verification.
3. The idempotency key is semantic and source-scoped (`order.create:<integrationId>:<orderId>`). Repeated, concurrent or cross-topic deliveries of one order produce one logical order and one verification. `X-WC-Webhook-Delivery-ID` is stored for audit only. The same order id from two stores stays apart.
4. Order id and number, customer name, billing phone, decimal total and currency normalize from the payload. Phone country comes from the order's billing country. A missing currency or an unparsable phone is a recorded ineligibility reason, never a guess.
5. A non-COD or custom-gateway order and a custom status produce explicit skip or ineligibility reasons. Nothing falls through to Shopify behavior.
6. The answer is 2xx only after the event is durably written, and it is fast: a queue outage still answers 2xx and is recovered by the dispatcher; a database failure answers 5xx and is logged as a possibly lost event. A ping answers 2xx and stores nothing. An inactive, disconnected or not-ready source sends nothing.

## Implementation notes

- **Backend:** Add the webhook controller and service, a `WebhookOrderNormalizer` and an `OrderEligibilityStrategy` for `woocommerce`, and register them next to the existing ones. Reuse `WebhookQueueProducer.ingest` and the dispatch reconciler. No order lookup and no rate budget: the payload is complete and WooCommerce documents no rate limit. No platform name is added to the processor or to verification core.
- **Frontend:** Add the WooCommerce source label and messages for any new reason codes through the existing label and reason maps, in Arabic and English.
- **Data:** Keep source, topic and delivery identifiers and only the payload needed under the common retention policy. No secret, token or key in an event row.
- **Operations:** Akeed's own non-2xx answers count toward WooCommerce's 5-failure disable. Log a refused delivery and an unpersisted event distinctly.

## Test requirements

- Valid and invalid signature, altered bytes, wrong source header, another tenant's token or secret, unknown and rotated token, switch off.
- Draft then placed (one verification), created and updated arriving together, duplicate and concurrent delivery, the same order id across two stores, an order older than the connection, ping.
- COD and non-COD, missing currency, local and international phone, custom status, queue outage, database failure, inactive and not-ready source.
- Driven from the US-07-01 fixtures.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Ships with `WOOCOMMERCE_INGESTION_ENABLED=false`; while off the delivery URL answers `404`. Orders placed while ingestion is off, the source is not ready or a webhook is disabled are not imported later (epic decision 7).

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** Normalizers for Shopify, Standalone and EasyOrders are registered; the normalizer interface is async and can return a skip reason; `RetryAfterError` reschedules a job. The EasyOrders webhook service is the model for acceptance and authentication. A raw-body HMAC guard exists for Shopify.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.module.ts](../../../src/modules/webhook-queue/webhook-queue.module.ts)
- [akeed-backend/src/modules/webhook-queue/interfaces/webhook-normalizer.interface.ts](../../../src/modules/webhook-queue/interfaces/webhook-normalizer.interface.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../../src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/modules/verification-core/strategies/order-eligibility.strategy.ts](../../../src/modules/verification-core/strategies/order-eligibility.strategy.ts)
- [akeed-backend/src/app.module.ts](../../../src/app.module.ts) (eligibility strategies are bound here)
- [akeed-backend/src/infrastructure/spokes/easyorders/easyorders-webhook.service.ts](../../../src/infrastructure/spokes/easyorders/easyorders-webhook.service.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/guards/shopify-hmac.guard.ts](../../../src/infrastructure/spokes/shopify/guards/shopify-hmac.guard.ts)
- [US-06-03 evidence](../../US-06-03-EASYORDERS-INGESTION-EVIDENCE.md)

**ASSUMPTION / REQUIRES VALIDATION:** The status a placed COD order carries, and the ping body, come from the contract record's rules and are confirmed at the gate on classic checkout and on the Checkout block.

**EXTERNAL PLATFORM DEPENDENCY:** WooCommerce behavior comes from the US-07-01 contract record. These are its sources.

- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — Working with webhooks](https://developer.woocommerce.com/docs/working-with-webhooks-in-woocommerce/)
- [WooCommerce issue #37958 — when "Order created" fires](https://github.com/woocommerce/woocommerce/issues/37958)
