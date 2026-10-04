# US-07-03 WooCommerce webhook ingestion evidence

**Validated:** 2026-10-04
**Revision:** backend `develop` at `813bc29`; frontend `develop` at `df1d795`
**Decision:** implemented locally and shipped disabled (`WOOCOMMERCE_INGESTION_ENABLED=false`). No real traffic until the US-07-06 gate has observed a real store. Acting on a store-side status change and writing outcomes to a store are US-07-04 and are not part of this story.

WooCommerce behavior is taken only from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md). No request was sent to any store while building or testing this story: stores are the in-process fake (`test/contracts/woocommerce-provider-fake.ts`), used only to connect a source, and ingestion itself never calls a store. The fixtures are still the documented shapes, not captures.

## Decisions taken with the product owner (2026-10-04)

| Question | Decision |
| --- | --- |
| The story's Data note asks for "source, topic and delivery identifiers and only the payload needed"; the record's mapping table says `rawPayload` is "the delivered object"; `webhook_events` has no column for the topic or the delivery id | The event's `raw_payload` is `{ topic, webhookId, deliveryId, order }`. `order` keeps only `id`, `number`, `status`, `currency`, `date_created_gmt`, `date_modified_gmt`, `total`, `payment_method`, the billing first name, last name, phone and country, and `meta_data` entries whose key is `akeed_outcome`. No email, address, IP address, line item or other plugin's meta is stored. `NormalizedOrder.rawPayload` is the same projection. No migration. |
| A delivery is authentic but the integration is inactive with its token still in place. The record's answer table has no row for it | Answered `200` and recorded; the existing processor marks the event `integration_inactive`. It is not a `401`, so a pause on Akeed's side does not count toward WooCommerce disabling the webhook. A disconnect (US-07-05) wipes the token, and that is a `401`. |

Both are recorded as a dated amendment at the end of the contract record.

Decisions taken while building, within the record, for review:

| Topic | Decision |
| --- | --- |
| "Older than the connection" | `date_created_gmt` has no fraction, so `connected_at` is floored to the second before comparing. An order created in the second the source connected is not older. |
| Store text in idempotency keys | `status` and `date_modified_gmt` go into the update and skip keys only when they are 1 to 64 printable ASCII characters without spaces; otherwise the literal `invalid`. |
| A stored secret that cannot be read | A part-two failure: `401`, counted, logged as `secret_unreadable`. A stored value that is not a `v1:` envelope is treated the same and is never used as an HMAC key. |
| A repeat of an order Akeed already has | By the record's routing rule it is an update, so an exact repeat of a placed order is one recorded `order.update` event (one for any number of repeats in the same state), not a duplicate of the create event. One order and one verification either way. |
| The acknowledgement | Every `200` has an empty body, ping and order alike. |
| Order of mapping reasons | `incomplete_payload` (no phone), `missing_currency`, `missing_phone_country`, `invalid_phone`, `invalid_amount`, as the EasyOrders normalizer orders them. A landline is `invalid_phone`. |
| `payment_method` | Compared exactly with `cod` after trimming. `COD` in capitals is a custom gateway and is not eligible. |

## Implemented behavior

- **Data.** No migration. The story runs on the US-07-02 tables: `woocommerce_connections.webhook_secret_encrypted`, `webhook_token_hash`, `rejected_deliveries`, `last_rejected_at` and `connected_at` already exist (`0051`). `webhook_events` is reused unchanged.
- **Route.** `POST /api/woocommerce/webhooks/:token`, one URL for both topics. The body reaches it as raw bytes for any content type (`applyWooCommerceWebhookEdge`, from US-07-02).
- **Authentication, in this order and before any business work.** (1) The URL token, looked up by its SHA-256: it alone decides the tenant. (2) `X-WC-Webhook-Signature` as the base64 HMAC-SHA256 of the raw bytes with that install's decrypted secret, compared with `timingSafeEqual` after a length check. (3) `X-WC-Webhook-Source`, canonicalized by the store-URL rules, equal to the connection's canonical store URL. Any failure is one `401 WOOCOMMERCE_WEBHOOK_UNAUTHORIZED` with nothing stored. A failure of (2) or (3) increments `rejected_deliveries`; an unknown token counts nothing.
- **Answers.** Ingestion off: `404` to an order delivery, no lookup. Ping (any request whose topic is not an order topic) on a known token: `200`, nothing stored, with the switch on or off; on an unknown token `401`, or `404` while ingestion is off. Order delivery on the token of an install still connecting: `200`, nothing stored. Authentic delivery whose body is not an order with an integer `id`: `200`, nothing stored, logged.
- **Routing (`woocommerce-ingestion.policy.ts`, pure).** Starts a verification, on either topic, when `payment_method` is `cod`, `status` is `processing` or `on-hold`, and the order is not older than the connection. Create: `order.create:<integrationId>:<orderId>`, job `order.create`. An order Akeed already has a create event for: `order.update:<integrationId>:<orderId>:<status>:<date_modified_gmt>`, job `order.update`, recorded only. Anything else: `order.skip:<integrationId>:<orderId>:<status>:<date_modified_gmt>`, job `order.create`, which the normalizer records with its reason. The source identity is `woocommerce:<orgId>`. `X-WC-Webhook-Delivery-ID` is stored and is never a key.
- **Acceptance.** `WebhookQueueProducer.ingest` (E02) writes the event and dispatches; the answer is `200` after the write. A queue outage still answers `200` and the dispatcher recovers the row. A database failure answers `5xx` and logs `woocommerce-webhook-not-persisted`, apart from `woocommerce-webhook-refused`.
- **Normalizer and eligibility strategy.** Registered next to the Shopify, Standalone and EasyOrders ones. Order id and number, billing name, phone, decimal total and currency come from the payload; a local phone is read in the billing country and an international one is taken as it is. Reasons: `order_predates_connection`, `order_not_placed`, `non_cod_payment_method`, `missing_payment_signal`, `missing_currency`, `missing_phone_country`, `invalid_phone`, `invalid_amount`, `incomplete_payload`, `source_connection_missing`. No order lookup, no rate limiter, no request to a store.
- **Config.** `WOOCOMMERCE_INGESTION_ENABLED`, independent of the connect switch; startup fails when it is on without `SHOPIFY_TOKEN_ENCRYPTION_KEY`. In `.env.example` and `docs/ENVIRONMENT.md`.
- **Frontend.** Messages for the two new reason codes (`order_predates_connection`, `order_not_placed`) in Arabic and English, through the existing reason allow-list. The WooCommerce source label was already there.

Shopify, Standalone and EasyOrders code is unchanged. No shared code changed: the only edits outside the spoke are the two registrations (`webhook-queue.module.ts`, `app.module.ts`), the WooCommerce config and repository, and a comment in `commerce-source.interface.ts`. The processor, the producer and verification core are untouched.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Token, raw-body HMAC and source checked before any business work; a failure stores nothing and answers `401`; a refused delivery on a valid token is counted | Contract: "authentication" (14 tests), "tenant isolation". Unit: `woocommerce-webhook.service.spec.ts` ("the three-part check"), `woocommerce-webhook.controller.spec.ts` (the signature over the bytes as they arrived, through the real route, edge and pipe). |
| 2. A verification starts at the first placed COD delivery on either topic; a draft or `pending` order is skipped with a stable reason; an order older than the connection never starts | Contract: "a cash-on-delivery order", "draft, placed, updated", "an order older than the connection" (4 tests), "orders that must not be sent". Unit: `woocommerce-ingestion.policy.spec.ts`. |
| 3. Semantic, source-scoped key; repeated, concurrent and cross-topic deliveries give one order and one verification; the delivery id is audit only; the same order id from two stores stays apart | Contract: "duplicate and concurrent deliveries", "order.created and order.updated arriving together give one", "order.updated before order.created gives one", "keeps the same order id from two stores apart", "tenant B's order does not make tenant A's a known order", "keeps X-WC-Webhook-Delivery-ID for audit and never as the key". |
| 4. Fields normalize from the payload; phone country from the billing country; missing currency or unparsable phone is a recorded reason | Contract: "takes the currency, the total and the phone country from the order", "keeps an international number as given", "orders that must not be sent". Unit: `woocommerce-order.normalizer.spec.ts`. |
| 5. Non-COD, custom gateway and custom status give explicit reasons; nothing falls through to Shopify behavior | Contract: "orders that must not be sent" (bank transfer, custom gateway, no payment method, pending, custom status). Unit: `woocommerce-order-eligibility.strategy.spec.ts`; the hub in the contract suite is built with every platform's strategy, as the application binds them. |
| 6. `2xx` only after the durable write; queue outage `2xx` and recovered; database failure `5xx` and logged as possibly lost; ping `2xx` and nothing stored; inactive, disconnected or not-ready source sends nothing | Contract: "queue outage and database failure", "the ping" (8 tests), "accepts an order for a source that is not ready", "records an order for a source switched off without a disconnect", "stops accepting a token after it is rotated". Unit: service spec "acknowledgement". |

## Test requirements

| Case | Where |
| --- | --- |
| Valid and invalid signature | Contract "a cash-on-delivery order"; "authentication" (wrong, missing, not base64). Unit `isValidWooCommerceSignature`. |
| Altered bytes | Contract "refuses bytes altered after they were signed". Unit: altered and re-serialized bytes. |
| Wrong source header | Contract "authentication" (missing, another store, plain HTTP), "accepts a store in a subdirectory by its own address". |
| Another tenant's token or secret | Contract "tenant isolation" (A's token with B's signature; B's whole delivery on A's token; A's signature with B's source). |
| Unknown and rotated token | Contract "authentication" (unknown, malformed, empty, rotated, the install callback token). |
| Switch off | Contract "answers 404 and stores nothing while ingestion is switched off"; `woocommerce-connection.contract-spec.ts` "delivery URL before ingestion", unchanged. |
| Draft then placed | Contract "a checkout draft then the placed order give one verification", "a draft delivered again and again never becomes an order". |
| Created and updated together | Contract "order.created and order.updated arriving together give one" (concurrent), "order.updated before order.created gives one". |
| Duplicate and concurrent delivery | Contract "collapses repeated deliveries…", "collapses concurrent deliveries of one order" (eight, both topics), "does not turn a changed redelivery into an order edit". |
| Same order id across two stores | Contract "keeps the same order id from two stores apart". |
| Order older than the connection | Contract "an order older than the connection". |
| Ping | Contract "the ping" (`ping.txt`, any other body, no body, during the callback, unknown token). Controller spec "answers the ping 200 whatever its body is". |
| COD and non-COD | Contract "a cash-on-delivery order"; non-COD fixture and custom gateway in "orders that must not be sent". |
| Missing currency | Contract "records a missing currency and creates nothing". |
| Local and international phone | Contract "takes the currency… and the phone country from the order", "keeps an international number as given". Unit normalizer spec (four local, four international, six refusals). |
| Custom status | Contract "records a custom status and creates nothing". |
| Queue outage | Contract "acknowledges after the durable write and recovers the order once the queue is back". |
| Database failure | Contract "answers 5xx when the event cannot be written, and logs it apart from a refusal" (a trigger refuses the insert). Controller spec "answers 5xx when the event could not be written". |
| Inactive and not-ready source | Contract "records an order for a source switched off without a disconnect, and sends nothing", "accepts an order for a source that is not ready, and sends nothing". |
| Driven from the US-07-01 fixtures | All five fixtures are loaded through `test/fixtures/woocommerce/load.ts` by the contract suite and the unit specs. |
| Secrets | Contract "never logs or returns a token, a secret or a key", "stores no secret, token or key in an event", "keeps the delivery identifiers and only the order fields Akeed reads". |

## Validation results (as run, 2026-10-04)

Backend (`akeed-backend`), before any change:

| Command | Result |
| --- | --- |
| `npx jest` | PASS, 192 suites, 5015 tests. |
| `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests. |
| Shopify, Standalone provisioning, EasyOrders ingestion, EasyOrders connection, source identity, WooCommerce connection contract scripts | PASS: 11, 10, 58, 59, 1, 112. |

Backend, after:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |
| `npx jest` | PASS, 197 suites, 5203 tests. |
| `npx jest src/infrastructure/spokes/woocommerce src/shared/config/woocommerce.config.spec.ts` | PASS, 13 suites, 442 tests. |
| `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-07-03-build` | PASS. Used instead of `npm run build`, which deletes `dist`; the output was removed. `nest build` itself was not run. |
| `scripts/test-woocommerce-ingestion-contract.ps1` (disposable PostgreSQL 17) | PASS, 64 tests. |
| `scripts/test-woocommerce-connection-contract.ps1` | PASS, 112 tests. |
| `scripts/test-shopify-contract.ps1` | PASS, 11 tests. |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS, 10 tests. |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 58 tests. |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 59 tests. |
| `scripts/test-source-identity-contract.ps1` | PASS, 1 test. |
| `scripts/test-order-imports-contract.ps1` | PASS, 60 tests. |

Frontend (`akeed-frontend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | No error in `src/`. 9 errors in stale generated files under `.next/` (`.next/types`, `.next/shopify/dev/types`, `.next/e01-validation-build/types`), the same ones recorded for US-07-02. |
| `npm run lint` | PASS, 0 errors, the 4 existing warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run test` | PASS, 101 files, 1118 tests. |
| `NEXT_DIST_DIR=.next-us0703 npx next build` | PASS. The `tsconfig.json` edit it makes was reverted and the folder removed. |

Not run:

- The frontend suite before the change. Only the after run exists.
- The E01 to E06 release gates (`npm run test:gate:*`). US-07-06 runs them.
- The remaining contract suites: EasyOrders outcome sync and release gate, entitlements, platform-boundary migration, integration keys, order API, manual order ingestion, verification overview, Paymob checkout and the E04.5 credit and billing suites.
- Any browser check. The reason messages appear only on screens behind login, and no skipped order is listed today (open item 3).
- Anything against a real store, a shared database or a deployed environment.

## Open items and known limits

1. **Fixtures are documented shapes, not captures.** The status of a placed COD order on each checkout, the draft's status value, the ping and the exact `X-WC-Webhook-Source` value are US-07-06 observations 2, 3, 4 and 8. A finding that contradicts the record reopens this story.
2. **A WooCommerce organization cannot finish onboarding until US-07-05**, so with real data every order is skipped as `onboarding_incomplete`. The contract suite sets `onboarding_status` directly, as E06 did.
3. **Skipped orders are not listed in the dashboard for any source.** Their reason is on `webhook_events.last_error` only, so the two new messages are not shown yet. The shared copy for `missing_currency` and `missing_phone_country` tells the merchant to choose them in settings, which is EasyOrders wording; it was left unchanged.
4. **Update events are recorded and not handled.** The processor marks them `unhandled_job_type:order.update` until US-07-04 registers a handler.
5. **Clock skew.** The age check compares the store's `date_created_gmt` with Akeed's `connected_at`. A store whose clock runs behind has its first orders after connecting skipped as older than the connection.
6. **Queue-outage recovery relies on the webhook reconciler**, which is off unless `WEBHOOK_RECONCILIATION_ENABLED=true`.
7. **A source header in another spelling is refused** (record findings 2.9 and 2.16): the refused counter rises and the store disables the webhook after five. US-07-05 health makes it visible.
8. **The delivery route is throttled in memory**, 1,200 per minute per address and per instance.
9. **Orders placed while ingestion is off, or before a disabled webhook is re-enabled, are not imported later** (epic decision 7).

## Operational notes

- **Enable:** set `WOOCOMMERCE_INGESTION_ENABLED=true` before a pilot organization connects. With it off every order delivery is a `404`, and five in a row disable the store's webhooks.
- **Disable:** set it back to `false`. Order deliveries answer `404`; events already queued are still processed. Stores connected at that time need their webhooks re-enabled afterwards (US-07-05).
- **Logs to watch:** `woocommerce-webhook-not-persisted` (alert: an event may be lost), `woocommerce-webhook-refused` (`reason` is `unknown_token`, `signature_mismatch`, `source_mismatch` or `secret_unreadable`), `woocommerce-webhook-accept` (`route` is `create`, `update` or `skipped`), `woocommerce-order-normalize`.
- **A merchant reports missing orders:** check `woocommerce_connections.rejected_deliveries` and `last_rejected_at`, then `webhook_events` for the integration with `status = 'skipped'` and its `last_error`.
