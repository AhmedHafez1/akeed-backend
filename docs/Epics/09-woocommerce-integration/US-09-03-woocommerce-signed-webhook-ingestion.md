# US-09-03 — Ingest signed WooCommerce order webhooks

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** LATER
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-09-02](../09-woocommerce-integration/US-09-02-woocommerce-application-auth-connection.md)

## User story and value

As a WooCommerce merchant, I want new COD orders verified automatically, so that my WooCommerce workflow benefits from Akeed without manual order copying.

**Business value:** My WooCommerce workflow benefits from Akeed without manual order copying.

## Scope

Core order-created webhook registration/validation, normalization and durable deduplication.

**Out of scope:** Unbounded polling, full historical import and arbitrary plugin event schemas.

## Acceptance criteria

1. The handler validates the raw-body HMAC using the store webhook secret and verifies the request belongs to the bound source before business work.
2. Order fields, billing phone/name, decimal total/currency and COD payment signals normalize using the approved fixture contract.
3. Delivery identifiers are namespaced by source; repeated or concurrent deliveries produce one logical order/verification.
4. Unsupported/custom payment or status cases produce explicit eligibility/unsupported outcomes, not Shopify fallback behavior.
5. Durable acceptance is fast; queue failure remains recoverable and inactive/disconnected stores do not send.

## Implementation notes

- **Backend:** Add and register the WooCommerce normalizer/eligibility strategy; reuse the common queue and source identity logic.
- **Frontend:** Expose safe source/eligibility/processing reasons in current localized dashboard views.
- **Data:** Retain source/delivery/topic identifiers and only required raw payload under the common retention policy.
- **Operations:** Follow validated webhook retry/disable behavior and document health checks; do not return success for unpersisted events.

## Test requirements

- Valid/invalid signature, altered bytes, wrong source, duplicate delivery ID across stores and missing fields.
- COD/non-COD, concurrent webhook, Redis outage and inactive connection.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable only supported topics/configurations; order-updated events cannot accidentally create duplicate verification flows.

## Evidence and references

**VERIFIED FROM CODE:** Queue normalizer registration is reusable but currently only Shopify is supplied.

- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts](../../akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

