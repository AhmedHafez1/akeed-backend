# US-09-01 — Validate WooCommerce hosting, authentication and mappings

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** LATER
- **Story type:** Validation spike
- **Status:** Backlog
- **Dependencies:** [US-08-06](../08-easyorders-integration/US-08-06-easyorders-contract-and-pilot-release-gate.md)

## User story and value

As a product owner, I want a bounded supported WooCommerce configuration, so that the adapter can be operated without promising compatibility with every WordPress site.

**Business value:** The adapter can be operated without promising compatibility with every WordPress site.

## Scope

Core REST/application-auth/webhook feasibility, supported store matrix and merchant-approved status semantics.

**Out of scope:** WordPress plugin development and arbitrary extension/custom-status support.

## Acceptance criteria

1. A dated matrix records qualified WooCommerce/WordPress/API versions, HTTPS, permalink/subdirectory setup and representative hosting/security configurations.
2. An authorized store demonstrates application-auth credential callback, REST order access and signed webhook delivery.
3. The spike verifies credential-callback association, webhook signature/headers, retry/disable behavior and a source-scoped delivery identity.
4. A mapping records confirmation, customer cancellation and merchant no-reply cancellation side effects; confirmation is not assumed equivalent to paid/completed.
5. Unsupported hosts/extensions/states and required merchant actions are explicit; unresolved authentication/security issues block connection implementation.

## Implementation notes

- **Backend:** Use core WooCommerce API documentation and authorized test stores; collect sanitized fixtures and response evidence.
- **Frontend:** Identify required setup diagnostics and truthful compatibility copy for the connection journey.
- **Data:** Store synthetic order/status fixtures and safe configuration descriptors, never consumer secrets.
- **Operations:** Define the support boundary and rate/time-out expectations from qualified stores; record provider/hosting variability.

## Test requirements

- Happy authorization/webhook path plus denied auth, blocked REST, bad permalinks and disabled webhook.
- Observe approved status side effects and unknown/custom state behavior.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

US-09-02 depends on this gate; a store outside the supported matrix is not silently enrolled.

## Evidence and references

**VERIFIED FROM CODE:** WooCommerce exists in the platform type but no registered normalizer or concrete adapter is present.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts)
- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

