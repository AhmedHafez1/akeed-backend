# US-09-02 — Connect WooCommerce through application authentication

- **Epic:** [E09 — WooCommerce Integration](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** LATER
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-09-01](../09-woocommerce-integration/US-09-01-woocommerce-compatibility-and-auth-validation.md)

## User story and value

As a new WooCommerce merchant, I want to authorize Akeed securely against my store, so that I can connect using core WooCommerce without installing a plugin.

**Business value:** I can connect using core WooCommerce without installing a plugin.

## Scope

Store URL validation, application-auth callback, encrypted consumer credentials and source activation.

**Out of scope:** A WordPress plugin, credentials in URLs, source switching and unsupported hosting.

## Acceptance criteria

1. Owner/admin starts authorization with an expiring single-use context bound to the expected organization/store and minimum required permissions.
2. Credential callback completion is verified independently of the browser success redirect; replay/mismatched store/key responses cannot replace another connection.
3. Store/API URLs require valid public HTTPS; private/loopback/link-local destinations, unsafe redirects and DNS-rebinding paths are blocked before server requests.
4. Consumer key/secret are encrypted, validated by a permitted REST probe and never exposed in API responses/logs/query strings.
5. Only a fresh/unprovisioned organization receives a woocommerce source and pilot entitlement; active different sources are rejected without mutation.

## Implementation notes

- **Backend:** Implement the core application-auth flow and restricted outbound HTTP client; reuse pending-install and credential primitives.
- **Frontend:** Provide localized URL/setup/authorization/denial/error states and RTL-compatible guidance using existing source onboarding.
- **Data:** Persist canonical store identity, encrypted credentials and connection state transactionally; retain original identity on same-store reconnect.
- **Operations:** Support only US-09-01-qualified stores; revoke/clean incomplete credentials using validated procedures.

## Test requirements

- Successful/denied auth, expired/replayed callback, bad credentials, cross-tenant association and concurrent connect.
- SSRF/private-IP/redirect/DNS checks, invalid TLS and subdirectory store URLs.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Pilot-only; no production polling or order mutations before connection validation and merchant consent.

## Evidence and references

**VERIFIED FROM CODE:** The shared integration/auth model can be reused, but WooCommerce authorization and outbound store-URL handling do not exist yet.

- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/shared/utils/token-encryption.util.ts](../../akeed-backend/src/shared/utils/token-encryption.util.ts)
- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)

