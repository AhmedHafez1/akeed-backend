# US-06-01 — Validate EasyOrders authorization and event semantics

- **Epic:** [E06 — EasyOrders Integration](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Validation spike
- **Status:** In progress — interim [contract record](evidence/US-06-01-contract-record.md) written 2026-10-03; live verification on an active store pending
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md) (satisfied: E05 is Done, shipped to production 2026-10-02 and validated 2026-10-03, product-owner-reported)

## User story and value

As a product owner, I want verified EasyOrders integration behavior, so that the adapter is designed around tested contracts instead of assumptions.

**Business value:** The adapter is designed around tested contracts instead of assumptions.

## Scope

Authorized-app callback, API-key verification, webhook authenticity/replay, tenant resolution for order-status webhooks, delivery of the webhook secret, rate-limit budget, payload completeness and status side effects.

**Out of scope:** Production connection before authentication is proven or treating the documented secret header as a payload HMAC.

## Acceptance criteria

1. A dated contract record confirms installation parameters, callback payload and a one-time tenant-bound installation correlation method.
2. The spike proves how API credentials/store ownership and webhook authenticity are validated; unresolved authenticity blocks live onboarding.
3. Capture sanitized order-created/status fixtures and determine delivery-ID, duplicate, retry and ordering behavior.
4. Record authoritative currency/phone-country sources and the meaning/side effects of confirmed/canceled updates.
5. Approve a mapping for customer confirmation/cancellation and merchant no-reply cancellation; automatic no_reply must not become automatic remote cancellation.
6. **Tenant resolution for order-status webhooks.** Order-status webhooks carry no `store_id` or delivery ID (confirm against captured payloads). Record how Akeed attributes such a webhook to one tenant, for example a per-install unguessable webhook URL token set through the authorized-app link. Prove the token cannot be guessed, reused across tenants or accepted after revocation or reconnect. Unresolved attribution blocks live status-webhook ingestion.
7. **Webhook secret delivery.** Record whether the webhook secret reaches Akeed during the authorized-app install or the seller must copy it from EasyOrders into Akeed. If it must be copied, specify the setup step, the missing/wrong-secret failure behavior and the guidance US-06-02 and US-06-05 must show. Unresolved authenticity still blocks live onboarding (AC2).
8. **Rate limit budget.** Confirm whether the 40 requests/minute limit applies per API key (or per store, app or IP). Record the request budget Akeed may spend on order lookups and on status updates, the 429/retry signals returned, and the resulting backoff and queueing rules for US-06-03 and US-06-04.

## Implementation notes

- **Backend:** Use official docs and authorized test-store requests; record actual headers/statuses without secrets.
- **Frontend:** Identify required store/currency/country setup inputs and consent text for later onboarding.
- **Data:** Keep synthetic fixtures and redacted evidence with source/version/date; do not store live credentials in the spike record.
- **Operations:** Confirm rate limits, revocation and support escalation; classify supported, unsupported and unknown cases.

## Test requirements

- Install/deny/replay callback, wrong secret/store, duplicate order event and API-key revocation.
- Status webhook with a valid, a wrong, a revoked and another tenant's URL token; install with and without a delivered webhook secret; a burst against the 40 requests/minute limit across two keys, if the provider allows a second key.
- Observe approved status transitions and any triggered notifications/fulfillment effects.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

US-06-02 through release are blocked if secure binding, tenant resolution for status webhooks, webhook-secret handling or required status behavior remains unknown.

## Evidence and references

**VERIFIED FROM CODE:** EasyOrders is absent from the current platform union/registered normalizers, so all provider integration behavior is new work.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts](../../../src/modules/webhook-queue/webhook-queue.constants.ts)
- [akeed-backend/src/modules/webhook-queue](../../../src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../../src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../../src/infrastructure/spokes/shopify/services/shopify-api.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Authentication](https://public-api-docs.easy-orders.net/docs/authentication)
- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

