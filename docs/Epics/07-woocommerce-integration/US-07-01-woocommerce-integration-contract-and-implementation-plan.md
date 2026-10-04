# US-07-01 — WooCommerce integration contract and implementation plan

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Contract and plan
- **Status:** Backlog
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md); the E06 shared code on `develop` (US-06-02 to US-06-05). Not US-06-06.

Retitled on 2026-10-04 (was "Validate WooCommerce hosting, authentication and mappings", a validation spike). The filename was aligned with the title on 2026-10-04.

## User story and value

As a product owner, I want the WooCommerce contract and the adapter design written down from the official documentation before any code, so that the adapter is built once, against stated behavior, without a discovery phase.

**Business value:** WooCommerce is added as a mechanical spoke. Validation is spent where the docs are silent, not on what they already state.

## Scope

A dated contract record, the support boundary, the adapter boundary and security model, documented-shape fixtures and a short list of observations for the release gate. No production code and no test store.

**Out of scope:** a hosting or version matrix; live requests to a store; a WordPress plugin; arbitrary extension or custom-status support.

## Acceptance criteria

1. A dated contract record exists at `evidence/US-07-01-contract-record.md` with the same eight sections as the [E06 record](../06-easyorders-integration/evidence/US-06-01-contract-record.md): authorization and correlation; credentials, store identity and webhook authenticity; delivery, idempotency and disabling; payload and COD mapping; outcome mapping; tenant resolution; secret handling; limits and timeouts. Each finding is labelled DOCUMENTED (with the doc URL and the date read), DECIDED (with who and when) or UNKNOWN. VERIFIED is reserved for the release gate.
2. UNKNOWN is used only where the official docs are silent. Each UNKNOWN has a worst-case rule the code must follow. Nothing is inferred where the docs are silent.
3. The record states the outcome mapping approved on 2026-10-04 ([epic decisions](README.md)) with its side effects: confirmation is a note plus an Akeed meta marker with no status change; customer and merchant no-reply cancellation write `cancelled`; automatic no-reply writes nothing. It lists the current statuses a cancellation may be written from and treats every other status, including custom ones, as a conflict.
4. The record states the ingestion rule: which topics are subscribed, that `order.created` can fire for a draft order before checkout completes, which statuses with `payment_method` `cod` start a verification, the semantic idempotency key, how a delivery is routed to the create path or to the update handler, and that an order created before the source was connected never starts a verification.
5. A support boundary replaces a compatibility matrix: public HTTPS store URL, pretty permalinks, REST `wc/v3`, the `Authorization` header reaching WordPress, the core COD gateway and core order statuses. Everything outside it is listed as unsupported with the code and the merchant-facing message the connect flow will show.
6. The adapter boundary is written down: the files of `src/infrastructure/spokes/woocommerce/`, the tables, the registration points (normalizer and update-handler lists, outcome-adapter list, eligibility strategies, setup contributors, source-connect switch and signup picker), the switches and pilot allow-list, and the restricted outbound HTTP client with its rules.
7. Fixtures built from the documented payload shapes are saved under `test/fixtures/woocommerce/`, marked "documented, not captured", with synthetic IDs and no secrets: an order as a checkout draft, as a placed COD order, as a non-COD order, an updated order, and a ping.
8. The record ends with a supported / unsupported / unknown table, a list of at most eight observations for US-07-06 to turn into VERIFIED, and a verdict on whether US-07-02 to US-07-06 are unblocked. An UNKNOWN on authenticity, tenant resolution or secret handling blocks.

## Implementation notes

- **Backend:** Phrase every rule against the real extension points listed below. Read the EasyOrders spoke as the pattern, and say where WooCommerce differs (server-sent callback with no store URL in its body; Akeed-set webhook secret; currency and country in the payload; no documented rate limit; a webhook that can be read, re-enabled and deleted by REST).
- **Frontend:** List the connect, denied, unsupported-store and error states the later stories must show, and the copy for each unsupported case.
- **Data:** Synthetic fixtures and safe descriptors only. No consumer key, secret or real customer data in the record or fixtures.
- **Operations:** Record timeouts, the 5-consecutive-failure disable rule and its consequence for Akeed's own error responses, and the manual API-key removal step.

## Test requirements

- No runtime tests: this story produces documents and fixtures.
- Every relative link in the record and the story resolves; the fixtures parse as JSON (the ping fixture as its documented content type).
- Satisfy the applicable [shared Definition of Done](../README.md); record what was read and when, not test results.

## Migration and rollout

US-07-02 starts when the verdict says unblocked. A contradiction found later does not reopen this story: it opens a focused validation story and updates the record.

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** `woocommerce` is already a member of `SUPPORTED_PLATFORM_TYPES` and of the database CHECK it mirrors, with no spoke behind it. The reusable pieces E06 left are:

- [akeed-backend/src/shared/interfaces/commerce-source.interface.ts](../../../src/shared/interfaces/commerce-source.interface.ts)
- [akeed-backend/src/modules/webhook-queue/interfaces/webhook-normalizer.interface.ts](../../../src/modules/webhook-queue/interfaces/webhook-normalizer.interface.ts) (async; may return a skip reason)
- [akeed-backend/src/modules/webhook-queue/interfaces/webhook-order-update-handler.interface.ts](../../../src/modules/webhook-queue/interfaces/webhook-order-update-handler.interface.ts)
- [akeed-backend/src/shared/commerce/commerce-outcome.ts](../../../src/shared/commerce/commerce-outcome.ts) (`tracksSynchronization`, sync states)
- [akeed-backend/src/shared/commerce/source-setup.ts](../../../src/shared/commerce/source-setup.ts) (setup contributors, health DTO)
- [akeed-backend/src/infrastructure/spokes/easyorders](../../../src/infrastructure/spokes/easyorders) (the spoke to model)
- [akeed-backend/src/shared/http/bounded-http.ts](../../../src/shared/http/bounded-http.ts) (deadlines and retries; no SSRF guard)

Registration is still a hardcoded list per spoke in [webhook-queue.module.ts](../../../src/modules/webhook-queue/webhook-queue.module.ts), [commerce-outcome.module.ts](../../../src/modules/commerce-outcomes/commerce-outcome.module.ts) and [app.module.ts](../../../src/app.module.ts); `isSourceConnectEnabled` in [easyorders.config.ts](../../../src/shared/config/easyorders.config.ts) reads only the EasyOrders switch.

**DOCUMENTED PROVIDER BEHAVIOR (read 2026-10-04; the contract record restates these with labels):**

- Authorization is `GET {store}/wc-auth/v1/authorize` with `app_name`, `scope`, `user_id`, `return_url` and an HTTPS `callback_url`. The callback is a JSON POST with `key_id`, `user_id`, `consumer_key`, `consumer_secret` and `key_permissions`; it carries no store URL. `return_url` receives `success` (`0` or `1`) and `user_id`.
- REST calls use Basic authentication over HTTPS.
- Webhook deliveries carry `X-WC-Webhook-Source`, `-Topic`, `-Resource`, `-Event`, `-Signature`, `-ID` and `-Delivery-ID`. The signature is a base64 HMAC-SHA256 of the body with the webhook secret.
- A webhook is disabled after 5 consecutive failed deliveries and must be re-enabled through the REST API. A ping is sent when a webhook is first saved as active.
- `order.created` fires for a checkout draft under the Checkout block ([WooCommerce issue #37958](https://github.com/woocommerce/woocommerce/issues/37958), open).

**ASSUMPTION / REQUIRES VALIDATION:** Core behavior not found on the doc pages goes into the gate-observation list, not into the contract as fact: that the callback is sent by the store's server, the ping's body, that a placed COD order sits in `processing` or `on-hold`, the exact side effects of `cancelled`, and that API keys cannot be removed through REST.

**EXTERNAL PLATFORM DEPENDENCY:** These primary sources are the contract inputs. They are not proof of this integration's readiness; that is US-07-06.

- [WooCommerce — REST authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
- [WooCommerce — Working with webhooks](https://developer.woocommerce.com/docs/working-with-webhooks-in-woocommerce/)
- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
