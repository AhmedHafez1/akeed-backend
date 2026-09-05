# US-08-01 — Validate EasyOrders authorization and event semantics

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Validation spike
- **Status:** Backlog
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md)

## User story and value

As a product owner, I want verified EasyOrders integration behavior, so that the adapter is designed around tested contracts instead of assumptions.

**Business value:** The adapter is designed around tested contracts instead of assumptions.

## Scope

Authorized-app callback, API-key verification, webhook authenticity/replay, payload completeness and status side effects.

**Out of scope:** Production connection before authentication is proven or treating the documented secret header as a payload HMAC.

## Acceptance criteria

1. A dated contract record confirms installation parameters, callback payload and a one-time tenant-bound installation correlation method.
2. The spike proves how API credentials/store ownership and webhook authenticity are validated; unresolved authenticity blocks live onboarding.
3. Capture sanitized order-created/status fixtures and determine delivery-ID, duplicate, retry and ordering behavior.
4. Record authoritative currency/phone-country sources and the meaning/side effects of confirmed/canceled updates.
5. Approve a mapping for customer confirmation/cancellation and merchant no-reply cancellation; automatic no_reply must not become automatic remote cancellation.

## Implementation notes

- **Backend:** Use official docs and authorized test-store requests; record actual headers/statuses without secrets.
- **Frontend:** Identify required store/currency/country setup inputs and consent text for later onboarding.
- **Data:** Keep synthetic fixtures and redacted evidence with source/version/date; do not store live credentials in the spike record.
- **Operations:** Confirm rate limits, revocation and support escalation; classify supported, unsupported and unknown cases.

## Test requirements

- Install/deny/replay callback, wrong secret/store, duplicate order event and API-key revocation.
- Observe approved status transitions and any triggered notifications/fulfillment effects.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

US-08-02 through release are blocked if secure binding or required status behavior remains unknown.

## Evidence and references

**VERIFIED FROM CODE:** EasyOrders is absent from the current platform union/registered normalizers, so all provider integration behavior is new work.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts)
- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Authentication](https://public-api-docs.easy-orders.net/docs/authentication)
- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

