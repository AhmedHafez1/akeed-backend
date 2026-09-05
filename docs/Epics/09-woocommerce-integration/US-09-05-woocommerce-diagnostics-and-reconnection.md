# US-09-05 — Provide WooCommerce diagnostics and reconnection

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P1
- **Horizon:** LATER
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-09-04](../09-woocommerce-integration/US-09-04-woocommerce-outcome-status-adapter.md)

## User story and value

As a WooCommerce merchant, I want clear help when my store stops communicating, so that I can restore integration without losing historical verification data.

**Business value:** I can restore integration without losing historical verification data.

## Scope

Connection health, webhook troubleshooting, safe disconnect and same-store reconnection.

**Out of scope:** Automatic repair of arbitrary WordPress plugins/hosting and source switching.

## Acceptance criteria

1. Setup checks distinguish invalid URL/TLS, unavailable REST, denied permissions, bad credentials and webhook delivery problems.
2. Health shows last known successful API/event processing separately from webhook silence, with qualified-store guidance.
3. Owner/admin disconnect stops new/queued effects and retains historical orders/usage; provider key/webhook removal follows the validated runbook.
4. Reconnect verifies the same store identity, replaces credentials safely and avoids duplicate webhook registrations.
5. Arabic/English, RTL/LTR, keyboard and error states work; unsupported hosting directs the merchant to support without false compatibility promises.

## Implementation notes

- **Backend:** Expose safe diagnostics using the restricted outbound client and common source lifecycle; limit probes to authorized store scope.
- **Frontend:** Reuse onboarding/settings skins and display source-specific help via capability-driven domain logic.
- **Data:** Preserve source/order identifiers, audit reconnections and retain disconnected-source reporting.
- **Operations:** Provide a webhook-disabled recovery checklist and separate merchant hosting responsibilities from Akeed service incidents.

## Test requirements

- Blocked REST, TLS failure, webhook disabled, stale credentials and invalid permission scope.
- Duplicate reconnect, wrong-store reconnect, viewer/cross-tenant denial and historical reporting.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Deploy with the pilot matrix and runbook; no automated unsafe URL probing or plugin configuration changes.

## Evidence and references

**VERIFIED FROM CODE:** Existing platform-neutral settings work must replace Shopify-only resolution before WooCommerce diagnostics can be exposed.

- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-frontend/src/features/onboarding](../../akeed-frontend/src/features/onboarding)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

