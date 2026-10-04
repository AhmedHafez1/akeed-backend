# US-07-06 — WooCommerce release gate and pilot

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-07-05](US-07-05-woocommerce-setup-health-disconnect-and-support.md); the E06 automated gate (`test:gate:e06`) passing. Not the E06 live pilot.

## User story and value

As a product owner, I want proof that the WooCommerce adapter satisfies the same contract as the other sources and works on a real store, so that enabling merchants does not put existing ones at risk.

**Business value:** The adapter is proven against a real store before any merchant is enabled.

## Scope

Shared conformance tests, WooCommerce-specific contract tests against a provider fake, regression of the other sources, and a live run on a real WooCommerce store. This is where validation lives for this epic. Defects found are fixed; no feature is added.

**Out of scope:** broad compatibility claims; a hosting matrix; rollout beyond the pilot allow-list.

## Acceptance criteria

1. The provider-neutral part of the EasyOrders release-gate suite is extracted into a shared conformance harness, in its own commit, with the EasyOrders gate still passing unchanged in behavior. WooCommerce runs through the same harness against a WooCommerce provider fake.
2. The shared outcome-adapter contract and the WooCommerce-specific cases pass: authorization callback, HMAC and source checks, payload mapping, COD detection, draft-then-placed, status mapping, API errors and throttling, webhook disable and re-enable, SSRF.
3. Duplicates and replays, another tenant's token, secret, key or order, key revocation, and queue or provider outages cannot cross tenants or duplicate a business effect. Disconnect and reconnect preserve history. No automatic no-reply cancellation reaches WooCommerce.
4. On a real WooCommerce store a pilot organization completes: connect → COD order → webhook → Akeed WhatsApp → customer confirms → note and marker in WooCommerce; and customer cancels → `cancelled` in WooCommerce. A duplicate delivery, a non-COD order and disconnect/reconnect are exercised on the same store. Events, orders, verifications, usage and store updates reconcile.
5. The observations handed over by US-07-01 are turned into VERIFIED in the contract record from that run, on classic checkout and, where a second store or checkout mode is available, on the Checkout block. A contradiction with the record opens a focused validation story; it is not patched silently in this gate.
6. Shopify, Standalone (manual, import, API) and EasyOrders automated regression gates pass, run as scripts with dev servers stopped. The localized setup, settings, dashboard and error screens are looked at by a person in Arabic and English.
7. The product owner records a go/no-go decision.

## Implementation notes

- **Backend:** Build `test/contracts/woocommerce-provider-fake.ts` from the contract record. Add fault injection around the install callback, webhook creation, queue dispatch and a status write that times out. Record real API responses from the live run with secrets removed.
- **Frontend:** Locale key parity for every WooCommerce error code; the walkthrough checklist for the live run.
- **Data:** A read-only reconciliation query for the pilot organization, selecting no credential, payload or personal data.
- **Operations:** Write `evidence/US-07-06-release-gate.md` (results per criterion, commands as run, the switch table, how to pause WooCommerce connections without touching other sources, known limits, recommendation) and `evidence/US-07-06-live-pilot-script.md`.

## Test requirements

- The conformance matrix for WooCommerce and, unchanged, for EasyOrders.
- The E01, E04, E05 and E06 gates, each run as its script. Whatever was not run is listed as not run.
- The live sequence in criterion 4 on at least one real store.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable in order for a pilot store: connect, check health, ingestion, then outcome sync; disable in reverse. On a failure, pause new WooCommerce connections while other sources and all history stay untouched. Future plugin work remains unapproved.

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** The shared outcome-adapter contract is small (adapter identity, capabilities and result shape). The tenant-isolation, replay, outage, disconnect, switch and secrets matrix exists only as an EasyOrders-specific suite with its own provider fake. The reuse this gate relies on therefore has to be extracted first (criterion 1). The E06 gate recorded that its own scripts were never run as scripts and that no screen was looked at by a person; this gate must not repeat that.

- [akeed-backend/test/contracts/commerce-outcome-adapter.contract.ts](../../../test/contracts/commerce-outcome-adapter.contract.ts)
- [akeed-backend/test/contracts/easyorders-provider-fake.ts](../../../test/contracts/easyorders-provider-fake.ts)
- [akeed-backend/test/easyorders-release-gate.contract-spec.ts](../../../test/easyorders-release-gate.contract-spec.ts)
- [akeed-backend/test/contracts/release-gate-harness.ts](../../../test/contracts/release-gate-harness.ts) (the E04.6/E05 Standalone harness: a model for a shared harness, not one a spoke can reuse as is)
- [E06 release-gate evidence](../06-easyorders-integration/evidence/US-06-06-release-gate.md) and [live pilot script](../06-easyorders-integration/evidence/US-06-06-live-pilot-script.md)
- [akeed-backend/AGENTS.md](../../../AGENTS.md)
- [akeed-frontend/AGENTS.md](../../../../akeed-frontend/AGENTS.md)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria describe approved proposed work, not completed functionality. One store proves the adapter on that store; it is not a claim about every host.

**EXTERNAL PLATFORM DEPENDENCY:** The live run is the validation of these sources for this integration.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
