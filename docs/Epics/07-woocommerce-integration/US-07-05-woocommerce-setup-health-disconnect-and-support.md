# US-07-05 — WooCommerce setup, health, disconnect and support

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Done (2026-10-05). No switch of its own: connect and reconnect ride on `WOOCOMMERCE_CONNECT_ENABLED` and the pilot list, re-enable on `WOOCOMMERCE_INGESTION_ENABLED`, and disconnect, the check, status and health on none. [Evidence](../../US-07-05-WOOCOMMERCE-SETUP-HEALTH-EVIDENCE.md), [runbook](evidence/US-07-05-disconnect-and-support-runbook.md)
- **Dependencies:** [US-07-04](US-07-04-apply-approved-verification-outcomes-in-woocommerce.md)

Retitled on 2026-10-04 (was "Provide WooCommerce diagnostics and reconnection"). The filename was aligned with the title on 2026-10-04. P1, but the US-07-06 gate depends on it.

## User story and value

As a WooCommerce merchant, I want clear setup, health and disconnect controls, so that I can see whether my store is communicating and restore it without losing historical verification data.

**Business value:** I can restore the integration without losing historical verification data, and support has a runbook.

## Scope

Source-specific onboarding completion, connection diagnostics, health including the live webhook state, re-enabling a disabled webhook, safe disconnect, same-store reconnect, and the support runbook.

**Out of scope:** repairing WordPress plugins or hosting; source switching; backfill of orders missed while disconnected or disabled; a different store on reconnect.

## Acceptance criteria

1. Onboarding identifies the connected store, the automation settings and the Akeed sender status, and can be completed for a WooCommerce source. Currency and phone country are not merchant inputs: they come from each order.
2. Connection checks distinguish an invalid URL or TLS failure, REST unreachable, permission denied, rejected credentials and webhook problems, each with its own code and localized guidance.
3. Health shows separate facts with no overall verdict: last credential answer, last accepted event, processing failures, backlog, store-update failures, refused deliveries and each webhook's state as read from the store (`active`, `paused`, `disabled`). No recent events is not a fault.
4. Owner/admin can re-enable a disabled webhook from Akeed. Orders placed while it was disabled are not imported, and the screen says so.
5. Owner/admin disconnect stops new and already queued external effects, deletes Akeed's webhooks at the store through REST (best effort, reported if it fails), wipes the stored credentials and keeps all orders, verifications and usage. Removing the API key in WooCommerce is a manual step the screen and the runbook describe.
6. Reconnect is to the same canonical store and the same source, in place, with new credentials and with Akeed's webhooks replaced rather than added to. Another merchant's store, a different store, or an organization with a different source is refused.
7. Arabic and English, RTL and LTR, keyboard access and loading, empty and error states work for every screen. No key, secret or delivery URL token is shown. A store outside the support boundary is directed to support without a compatibility promise.

## Implementation notes

- **Backend:** Add a `SourceSetupContributor` for `woocommerce` and register it. Extend health through the existing DTO. Disconnect and reconnect follow the EasyOrders pattern; all probes go through the restricted outbound client and only to the bound store. A new setup blocked reason for a disabled webhook may be added; existing reasons are never renamed.
- **Frontend:** Extend the existing source skins: setup checklist, connection panel in Settings (disconnect with confirmation, reconnect, re-enable webhook) and the health card.
- **Data:** Additive migration for disconnect state, mirroring EasyOrders. The integration row and connection row are updated in place on reconnect so history stays attached.
- **Operations:** Write `evidence/US-07-05-disconnect-and-support-runbook.md`: what disconnect does and does not do, manual API-key removal, the webhook-disabled recovery checklist, reconnect, escalation, rollback, and which problems are the merchant's hosting rather than an Akeed incident.

## Test requirements

- REST blocked, TLS failure, rejected credentials, insufficient permission, webhook disabled then re-enabled, webhook deleted at the store.
- Disconnect (wipe, idempotence, queued event and queued store update, webhook deletion failing), same-store reconnect without duplicate webhooks, wrong-store reconnect, reconnect after another organization verified the store.
- Viewer and cross-tenant denial; history and health readable after disconnect.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Adds no switch: connect and reconnect need the connect switch and the pilot list; disconnect and the health read need neither, so turning the feature off never traps a merchant in a connection.

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** Source resolution, the test message and settings are platform-neutral, and E06 added a setup-contributor registry, a health DTO and endpoint, and source skins that resolve by platform. The earlier note that onboarding was Shopify-only no longer holds.

- [akeed-backend/src/shared/commerce/source-setup.ts](../../../src/shared/commerce/source-setup.ts)
- [akeed-backend/src/modules/onboarding/source-setup.service.ts](../../../src/modules/onboarding/source-setup.service.ts)
- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../../src/modules/onboarding/onboarding-state.service.ts)
- [akeed-backend/src/infrastructure/spokes/easyorders/easyorders-setup.contributor.ts](../../../src/infrastructure/spokes/easyorders/easyorders-setup.contributor.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../../src/infrastructure/database/repositories/webhook-events.repository.ts)
- [akeed-frontend/src/features/settings](../../../../akeed-frontend/src/features/settings)
- [akeed-frontend/src/features/onboarding](../../../../akeed-frontend/src/features/onboarding)
- [US-06-05 evidence](../../US-06-05-EASYORDERS-ONBOARDING-HEALTH-EVIDENCE.md) and [runbook](../06-easyorders-integration/evidence/US-06-05-disconnect-and-support-runbook.md)

**ASSUMPTION / REQUIRES VALIDATION:** That API keys cannot be removed through REST is core behavior to confirm at the gate; until then removal is manual.

**VERIFIED FROM CODE (2026-10-05):** The frontend folders were re-read before this story was built. `features/onboarding` resolved a setup skin by platform and already had a WooCommerce connect screen whose connected state was a dead end; the setup flow, the checklist card and the disconnect dialog existed only as EasyOrders files and were extracted to `skins/connect/`. `features/settings` resolved the order-source tab by platform through `sourceSkins.ts`, with no WooCommerce row, and its health card had no place for a webhook's state.

**EXTERNAL PLATFORM DEPENDENCY:** WooCommerce behavior comes from the US-07-01 contract record. These are its sources.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
