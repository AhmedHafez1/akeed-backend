# US-09-04 — Apply approved verification outcomes in WooCommerce

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** LATER
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-09-03](../09-woocommerce-integration/US-09-03-woocommerce-signed-webhook-ingestion.md)

## User story and value

As a WooCommerce merchant, I want verification outcomes reflected safely in my store, so that staff can act on verified intent without accidental payment or fulfillment changes.

**Business value:** Staff can act on verified intent without accidental payment or fulfillment changes.

## Scope

Capability-aware REST status updates using the mapping approved by US-09-01.

**Out of scope:** Marking COD orders paid/completed by default, refunds, fulfillment or automatic no-reply cancellation.

## Acceptance criteria

1. Only the approved status mapping is enabled; confirmation preserves COD/payment semantics and never assumes paid/completed.
2. Customer cancellation and merchant no-reply cancellation use their separately authorized mapping; automatic no_reply does not cancel remotely.
3. Unsupported/custom/current terminal states produce explicit results and cannot fall through to Shopify behavior.
4. Local customer intent is retained independently of pending/failed remote sync; errors and provider references are auditable.
5. Duplicate outcomes, uncertain responses and reflected order-updated webhooks reconcile without loops or repeated harmful transitions.

## Implementation notes

- **Backend:** Keep WooCommerce status names in the adapter and inspect current state where required before transition/retry.
- **Frontend:** Display local versus remote-sync state and localized actionable failure without falsely reporting provider success.
- **Data:** Record operation correlation, mapped state and safe errors tied to org/source/order identity.
- **Operations:** Treat credential failures as attention-needed and transient/host throttling as bounded retry; respect supported-store limits.

## Test requirements

- Approved confirmation/cancellation mappings, custom/terminal state, unauthorized tenant and disconnected source.
- Timeout after possible success, retry, credential revocation and status-webhook feedback loop.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Start with explicitly mapped pilot states; changes to store mappings require merchant approval and renewed contract tests.

## Evidence and references

**VERIFIED FROM CODE:** Existing Shopify outcomes have different tagging/cancellation semantics; the common registry must preserve those while adding WooCommerce behavior.

- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)

