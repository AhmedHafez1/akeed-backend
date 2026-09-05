# US-09-06 — Qualify WooCommerce for pilot release

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** LATER
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-09-05](../09-woocommerce-integration/US-09-05-woocommerce-diagnostics-and-reconnection.md)

## User story and value

As a product owner, I want evidence across the supported WooCommerce matrix, so that the final approved adapter is reliable and operationally supportable.

**Business value:** The final approved adapter is reliable and operationally supportable.

## Scope

Compatibility/security/contract tests and an authorized end-to-end pilot.

**Out of scope:** Broad compatibility claims, WordPress plugin creation and rollout beyond the qualified matrix.

## Acceptance criteria

1. Every supported configuration in US-09-01 passes authorization, REST access, signed ingestion and approved outcome synchronization.
2. A pilot COD order completes Akeed send/reply/status lifecycle without changing payment or fulfillment unintentionally.
3. Forgery, SSRF, cross-tenant credentials/events, duplicates, throttling, webhook disablement and revocation are covered by automated or documented live checks.
4. Disconnect/reconnect and queue/provider outages preserve history and do not duplicate verification or harmful status changes.
5. Shopify, Standalone/API and EasyOrders regression gates pass; product/operations record a qualified go/no-go decision.

## Implementation notes

- **Backend:** Run the shared adapter suite and WooCommerce-specific fixtures on supported test stores; do not infer compatibility from one host.
- **Frontend:** Record localized onboarding/dashboard/diagnostic acceptance and existing-mode regression.
- **Data:** Reconcile event/order/verification/usage/provider outcome counts across happy and failure cases.
- **Operations:** Publish supported configurations, known limits, incident runbook and a staged pilot rollback procedure.

## Test requirements

- E09 compatibility/auth/security/status matrix plus E01, E04, E05 and E08 regressions.
- Live authorized webhook and recovery drill on each selected representative configuration.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Pause new WooCommerce connections on failures while preserving other sources and historical data; future plugin work remains unapproved.

## Evidence and references

**VERIFIED FROM CODE:** WooCommerce enum membership is architectural intent, not an implemented adapter; this gate requires new operational proof.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts)
- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

