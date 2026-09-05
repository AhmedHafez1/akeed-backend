# US-08-06 — Qualify the EasyOrders adapter for pilot release

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-08-05](../08-easyorders-integration/US-08-05-easyorders-onboarding-health-and-disconnect.md)

## User story and value

As a product owner, I want end-to-end proof of the first native expansion adapter, so that EasyOrders growth does not compromise existing merchants.

**Business value:** EasyOrders growth does not compromise existing merchants.

## Scope

Adapter contracts, installation/ingestion/outcome journey, fault recovery and live-pilot evidence.

**Out of scope:** Broad rollout, E07 completion as a prerequisite, and unsupported provider guarantees.

## Acceptance criteria

1. An authorized pilot store installs, ingests a COD order, sends through Akeed, receives a customer outcome and applies the approved EasyOrders status.
2. Shared adapter contracts plus EasyOrders-specific authentication/mapping fixtures all pass.
3. Duplicate/replayed webhooks, wrong-store credentials, key revocation, rate limits and queue/provider outages cannot cross tenants or duplicate business effects.
4. Disconnect/reconnect preserves history and no automatic no_reply cancellation occurs.
5. E01/E04/E05 regression gates pass and unresolved US-08-01 platform questions block release.

## Implementation notes

- **Backend:** Run provider-fake contracts plus a small authorized live sequence; record actual API responses with secrets removed.
- **Frontend:** Complete localized setup/dashboard/error walkthroughs and verify both existing modes still work.
- **Data:** Reconcile accepted events, orders, verifications, usage and external outcomes for pilot samples.
- **Operations:** Record support runbook and go/no-go evidence; pause new connections independently of current Shopify processing.

## Test requirements

- Full adapter security/status/idempotency matrix and an authorized real callback flow.
- Fault injection around install callback, rate limiting, queue dispatch and remote status timeout.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Use fresh/unprovisioned pilot organizations; WooCommerce remains later and inherits the proven contracts.

## Evidence and references

**VERIFIED FROM CODE:** The code has no EasyOrders adapter; its production readiness cannot be inferred from platform enum expansion alone.

- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

