# US-08-02 — Connect EasyOrders and secure its credentials

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-08-01](../08-easyorders-integration/US-08-01-easyorders-integration-validation.md)

## User story and value

As a new EasyOrders merchant, I want to authorize Akeed for my store, so that my orders can enter verification without manual API-key handling.

**Business value:** My orders can enter verification without manual API-key handling.

## Scope

Authorized-app link, secure callback, store binding and connection lifecycle.

**Out of scope:** Replacing an active Shopify/Standalone source, multiple stores per organization, or changing the WhatsApp sender.

## Acceptance criteria

1. Owner/admin starts installation with minimum verified permissions and a single-use expiring context tied to their authenticated organization.
2. The callback is validated using the US-08-01 contract, credentials are checked against the expected store, and replay/mismatched-store callbacks cannot replace credentials.
3. API keys and webhook secrets are encrypted and never returned/logged; unauthorized roles cannot connect or disconnect.
4. A successful install provisions one easyorders source for a fresh/unprovisioned organization with the existing pilot entitlement and onboarding settings.
5. Existing active sources are rejected without mutation; native signup chooses its source before default Standalone provisioning, so no silent source conversion is needed.

## Implementation notes

- **Backend:** Add an EasyOrders spoke/auth service and trusted pending-install context; reuse source/entitlement/credential primitives.
- **Frontend:** Provide Arabic/English, RTL-compatible connect/deny/error states and clearly identify the chosen store.
- **Data:** Persist verified store_id, encrypted credentials and installation/readiness state atomically; preserve history on reconnect.
- **Operations:** Use the Akeed sender unless the merchant independently completed an explicit E07 migration; avoid requesting unnecessary permissions.

## Test requirements

- Valid/denied install, expired/replayed context, spoofed callback/store, invalid key and cross-tenant callback.
- Concurrent connect, existing active source and retry after partial failure.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Restrict to qualified pilot accounts and disable real-order ingestion until authentication and settings are ready.

## Evidence and references

**VERIFIED FROM CODE:** Source provisioning and credentials currently revolve around Shopify; E03's source rules must be extended without adding source switching.

- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/shared/utils/token-encryption.util.ts](../../akeed-backend/src/shared/utils/token-encryption.util.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Authentication](https://public-api-docs.easy-orders.net/docs/authentication)

