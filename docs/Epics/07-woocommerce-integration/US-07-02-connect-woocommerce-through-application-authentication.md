# US-07-02 — Connect WooCommerce through application authentication

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Done (2026-10-04), shipped disabled; real-store proof is owed to US-07-06 — [evidence](../../US-07-02-WOOCOMMERCE-CONNECTION-EVIDENCE.md)
- **Dependencies:** [US-07-01](US-07-01-woocommerce-integration-contract-and-implementation-plan.md)

## User story and value

As a new WooCommerce merchant, I want to authorize Akeed securely against my store, so that I can connect using core WooCommerce without installing a plugin or copying keys.

**Business value:** I can connect using core WooCommerce without installing a plugin or copying keys.

## Scope

Store URL validation, the application-auth flow and its callback, encrypted consumer credentials, creation of Akeed's webhooks, store identity and source provisioning. Shipped behind `WOOCOMMERCE_CONNECT_ENABLED` and a pilot allow-list.

**Out of scope:** a WordPress plugin; manual consumer key/secret entry; credentials in URLs; plain-HTTP stores; source switching; order ingestion (US-07-03); disconnect and reconnect (US-07-05).

## Acceptance criteria

1. Owner/admin starts authorization for a store URL they enter. Akeed creates an expiring single-use install context bound to the caller's organization and to that canonical store URL, and returns the WooCommerce authorize link with scope `read_write`, which is the minimum that allows creating webhooks and updating orders.
2. The callback is the proof of authorization; the browser `return_url` is only a hint (`success=0` shows the denied state and changes nothing). The callback body carries no store URL, so it is bound through the single-use token in the callback path and in `user_id`, and the keys are proven by a permitted REST read against the store URL held in the install context. A replayed, expired, mismatched or cross-tenant callback cannot create or replace a connection.
3. Every request Akeed sends to a store goes through one restricted outbound client: HTTPS only, public addresses only, the resolved address pinned for the request, redirects never followed to a private, loopback or link-local address, bounded time and size. This applies to the probe and to every later call, not only at connect.
4. Consumer key and secret are encrypted at rest, validated by the REST probe, and never exposed in API responses, logs, URLs or fixtures.
5. After the keys are proven, Akeed creates its order webhooks through REST with a per-install unguessable delivery URL and a secret Akeed generates, and stores the webhook ids. The merchant copies no secret. The ping is answered 2xx and creates no event. If webhook creation fails, no half-connected source is left and the same link can be retried.
6. Only a fresh/unprovisioned organization receives a `woocommerce` source, with the pilot entitlement and onboarding defaults used for EasyOrders. An organization with any other source is rejected without mutation. A canonical store URL can be verified for one organization only.
7. A store outside the support boundary in the contract record (no HTTPS, REST unreachable, permalinks not enabled, credentials rejected because the `Authorization` header does not arrive) is refused with its own code and localized message.

## Implementation notes

- **Backend:** Add the spoke under `src/infrastructure/spokes/woocommerce/` with an auth service, start-install and callback controllers, an API client and config. Add the restricted outbound client under `src/shared/http/` as its own commit. Generalize the source-connect switch read by signup so more than one connectable source can be on; EasyOrders behavior must not change.
- **Frontend:** Add WooCommerce to the signup source picker and a connect skin: enter store URL, waiting, denied, unsupported store, error and connected states, in Arabic and English (RTL). Name the store being connected. No key, secret or install link is rendered.
- **Data:** Spoke-owned tables mirroring the EasyOrders ones (pending installs; one connection row per integration with ciphertext, webhook token hash, webhook ids, health, canonical store URL with a partial unique index once verified). RLS on with no policy. The EasyOrders tables are not generalized.
- **Operations:** Pilot only. An abandoned or refused install can leave an API key in the store; the not-completed and error screens tell the merchant where to remove it.

## Test requirements

- Valid install, denied (`success=0`), expired and replayed context, bad credentials, cross-tenant callback, concurrent connects, existing active source, retry after a partial failure, webhook creation failure.
- SSRF: private, loopback and link-local addresses, DNS that resolves to a private address, redirect to a private address, invalid TLS, plain HTTP; a store in a subdirectory.
- Proof that no key, secret or token appears in a response, a log line or a stored column in clear.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Additive, reversible migration. Ships with `WOOCOMMERCE_CONNECT_ENABLED=false`; connecting needs the switch on and the organization on `WOOCOMMERCE_PILOT_ORG_IDS`. No order is ingested and no order is written until US-07-03 and US-07-04 are enabled.

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** The install pattern exists in the EasyOrders spoke and is the model: a hashed single-use install context, a callback token in the URL path, a probe outside the transaction, provisioning in one transaction, and source-less signup (`sourceMode: "connect"`). No WooCommerce authorization code and no SSRF-safe outbound client exist yet.

- [akeed-backend/src/infrastructure/spokes/easyorders/easyorders-auth.service.ts](../../../src/infrastructure/spokes/easyorders/easyorders-auth.service.ts)
- [akeed-backend/src/infrastructure/database/repositories/easyorders-connections.repository.ts](../../../src/infrastructure/database/repositories/easyorders-connections.repository.ts)
- [akeed-backend/src/shared/config/easyorders.config.ts](../../../src/shared/config/easyorders.config.ts)
- [akeed-backend/src/modules/organizations/organizations.service.ts](../../../src/modules/organizations/organizations.service.ts)
- [akeed-backend/src/shared/utils/token-encryption.util.ts](../../../src/shared/utils/token-encryption.util.ts)
- [akeed-backend/src/shared/http/bounded-http.ts](../../../src/shared/http/bounded-http.ts)
- [US-06-02 evidence](../../US-06-02-EASYORDERS-CONNECTION-EVIDENCE.md)

**ASSUMPTION / REQUIRES VALIDATION:** That the callback is sent by the store's server (so no CORS handling is needed) is core behavior, not stated on the doc page; build to the contract record's rule and confirm at the gate.

**EXTERNAL PLATFORM DEPENDENCY:** WooCommerce behavior comes from the US-07-01 contract record. These are its sources.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
