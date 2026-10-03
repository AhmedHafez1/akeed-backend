# US-06-03 EasyOrders webhook ingestion evidence

**Validated:** 2026-10-03
**Revision:** backend and frontend working trees on `develop`, on top of backend `fcec959` and frontend `9ab8008`
**Decision:** implemented locally and shipped disabled (`EASYORDERS_INGESTION_ENABLED=false`). No real traffic until the US-06-01 go-live verification has observed a real order delivery and a real status delivery with their `secret` header. Remote status writes (US-06-04) are not part of this story.

EasyOrders behavior is taken only from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md). No request was sent to EasyOrders while building or testing this story: the provider is a fake `fetch` in every test. The fixtures are still the documented shapes, not captures.

## Decisions taken with the product owner (2026-10-03)

| Question | Decision |
| --- | --- |
| Where currency and phone country come from (US-06-02 had deferred them to US-06-05) | Two nullable columns on `easyorders_connections`, a small owner/admin setter and two fields on the existing connect screen. While either is missing an order is recorded as not eligible. |
| Story AC 4 asks for a lookup on incomplete payloads; contract record section 8 says no lookup on the webhook path | Never while a webhook is received. In the worker only: when a required field is missing, plus one read for the first order while the store is still an unverified claim. |
| How far "show source and reasons on the dashboard" goes | Frontend only: a source label and message keys for the reason codes. Skipped orders stay absent from the list, as they are for Shopify. |
| The status webhook URL | Authenticated and recorded only. No order is read or changed; handling is US-06-04. |

Decisions taken while building, for review:

| Topic | Decision |
| --- | --- |
| `orderNumber` | The first eight characters of the EasyOrders order id. The documented payload has no reference field. |
| Fetched order without a `store_id` | Fails closed: `store_unverified`, nothing is taken from the response. The response shape of `GET orders/:id` is not in the contract record, so if the real one differs no order from an unverified store is ingested until this is adjusted. |
| Missing `full_name` | Treated as incomplete (lookup, then `incomplete_payload`). No placeholder name is sent to a customer. |
| Queue contract | Normalizers may be async and may return a skip reason. `RetryAfterError` reschedules a job for a named delay. Needed because the default backoff (3, 6, 12, 24 seconds) can run out before the next rate-limit minute. No platform name was added to the processor. |
| Wrong store or malformed payload | `403` and `400` with nothing stored, rather than an accepted-and-skipped event. |

## Implemented behavior

- **Data.** Migration `0048_easyorders_ingestion.sql`, additive and re-runnable, plus the `_journal.json` entry and the schema columns: `currency`, `phone_country`, `rejected_deliveries`, `last_rejected_at` on `easyorders_connections`, and the health value `credentials_rejected`.
  - Rollback: move any `credentials_rejected` row back to `ok`, restore the two-value health check, drop the four columns. No existing row is rewritten.
- **Routes.** `POST /webhooks/easyorders/orders/:token` and `POST /webhooks/easyorders/status/:token`. They answered `404` before this story and still do while the switch is off.
- **Authentication.** URL token (looked up by hash, the only tenant signal) and that webhook's `secret` header, compared in constant time. Unknown or rotated token, inactive source, secret not set, missing or wrong header: one `401`. A wrong secret on a valid token is counted.
- **Store binding.** An order's `store_id` must equal the integration's, checked before anything else in the payload: `403`.
- **Event types.** An order payload with an `event_type`, or without a text `id`, is `400`. Status events are accepted only on the status route and only as `order-status-update`.
- **Acceptance.** `WebhookQueueProducer.ingest` (E02) writes the event and dispatches; the answer is `200` after the write. A queue outage still answers `200` and the row is recovered by the dispatcher; a database failure answers `5xx` and logs `easyorders-webhook-not-persisted`.
- **Idempotency.** `order.create:<integrationId>:<orderId>` and `order.status:<integrationId>:<orderId>:<old>:<new>` under source identity `easyorders:<orgId>`.
- **Normalizer and eligibility strategy.** Registered next to the Shopify and Standalone ones. Currency and phone country come from the integration; a missing one is `missing_currency` or `missing_phone_country`. `payment_method` `cod` is eligible; any other value or none is not.
- **Order lookup.** `GET orders/:id` with the integration's own key, through a 30 per minute per-integration budget (20 for lookups). `429` pauses the integration and reschedules the job; transient failures use the queue backoff; `401`/`403` are permanent and set health.
- **Order settings.** `PUT /api/easyorders/connection/order-settings`: owner or admin. The status DTO now also reports `currency`, `phoneCountry` and `rejectedDeliveries`.
- **Frontend.** Country and currency form on the EasyOrders connect screen, with notices for a rejected key and for refused deliveries. The verification details sheet names the order source from the row's existing `platform` field through a generic label map with a fallback. Reason messages were added for the new codes and for six codes that were already allow-listed without a message. Arabic and English.

Shopify code is unchanged. The shared changes are the normalizer interface, the processor's handling of its result and of `RetryAfterError`, and `RetryAfterError` itself.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Secret verified before processing; `store_id` checked against the bound integration | Contract: "authentication" (wrong secret, no header, unknown and malformed token, secrets not added, status secret on the orders route, rotated token, switch off), "store binding and tenant isolation". Unit: `easyorders-webhook.service.spec.ts`. |
| 2. Order ID, reference, customer, amount, payment and currency normalize from verified sources; missing currency not guessed | Contract: "a cash-on-delivery order" (three tests), "records {currency: null} as the reason and never guesses". Unit: `easyorders-order.normalizer.spec.ts`, `easyorders-order-eligibility.strategy.spec.ts`. |
| 3. Repeated deliveries produce one order and one verification without a provider delivery ID | Contract: "duplicate and concurrent deliveries" (repeat, eight concurrent, changed redelivery), "keeps the same order id apart for two integrations". |
| 4. Lookup only when required; rate-limited and transient failures retry through the common pipeline | Contract: "order lookup" (ten tests: incomplete, still incomplete, first-order verification, `429` rescheduled then recovered, `503` retried then recovered, rejected key, inactive store, per-integration budget). Unit: `easyorders-rate-limiter.spec.ts`, `easyorders-api.client.spec.ts`, `webhook-queue.processor.spec.ts` ("retry after a provider-named delay"). |
| 5. Unknown and status events cannot enter the create path; inactive and unready sources do not send | Contract: "event types", "a disconnected source", "accepts an order for a source that is not ready, and sends nothing". |

## Test requirements

| Case | Where |
| --- | --- |
| COD / non-COD | Contract "a cash-on-delivery order"; "records a non-COD payment method and creates nothing". Unit strategy spec. |
| Local / international phone | Contract "takes the currency and the phone country from the integration", "keeps an international number as given". Unit normalizer spec (five formats, three refusals). |
| Missing fields | Contract "reads an incomplete order back", "records an order that stays incomplete", missing currency and phone country. |
| Wrong store / wrong secret | Contract "authentication", "answers 403 and stores nothing", "rejects tenant A's token with tenant B's store id", "does not accept tenant B's secret on tenant A's token". |
| Malformed event | Contract "event types". Unit webhook service spec. |
| Duplicate / concurrent delivery | Contract "duplicate and concurrent deliveries". |
| Fetch throttling | Contract "reschedules a 429", "one store spending its lookup budget does not delay another". Unit limiter spec. |
| Queue outage | Contract "acknowledges after the durable write and recovers the order once the queue is back". Unit "does not acknowledge an event it could not persist". |
| Disconnected source | Contract "rejects new webhooks and stops an order that was already queued". |
| Owed by the contract record, section 6 | Contract "rejects tenant A's token with tenant B's store id", "a status event for tenant B's order on tenant A's token changes nothing", "stops accepting a token after it is rotated". |
| Secrets | Contract "never logs or returns a token, a secret or an API key", "stores no secret, token or API key in an event". |

## Validation results (as run, 2026-10-03)

Backend (`akeed-backend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-06-03-build` | PASS. Used instead of `npm run build`, which deletes `dist` under the running dev server. `nest build` itself was not run. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |
| `npx jest` | PASS, 171 suites, 4473 tests. Run before the documentation edits and one comment edit in `commerce-source.interface.ts`; the affected folders were re-run afterwards (25 suites, 577 tests, PASS). |
| `npm run test:core:platform-neutral` | PASS, 9 suites, 144 tests. |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 49 tests. |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 43 tests (now applies 0047 and 0048). |
| `scripts/test-order-imports-contract.ps1` | PASS, 60 tests (0048 added to its migration list). |
| `scripts/test-shopify-contract.ps1` | PASS, 11 tests. |
| `scripts/test-source-identity-contract.ps1` | PASS, 1 test. |
| `scripts/test-manual-order-ingestion-contract.ps1` | PASS, 15 tests. |
| `scripts/test-order-import-release-gate-contract.ps1` | PASS, 21 tests. |
| `scripts/test-order-api-release-gate-contract.ps1` | PASS, 24 tests. |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS, 10 tests. |

Frontend (`akeed-frontend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | No error in `src`. 9 errors in generated files under `.next/` (stale validator output of earlier builds); the same 9 are reported on the untouched tree. |
| `npm run lint` | PASS, 0 errors, 4 warnings that were already there. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run test` | PASS, 89 files, 884 tests. |
| `NEXT_DIST_DIR=.next/e01-validation-build npx next build` | PASS. `tsconfig.json` restored afterwards. |

Not run:

- The E02 to E05 release gates (`npm run test:gate:*`).
- The remaining contract suites: entitlements, platform-boundary migration, integration keys, order API, verification overview, Paymob checkout and the E04.5 credit and billing suites.
- Any browser check. Both changed screens are behind login.
- Anything against EasyOrders, a shared database or a deployed environment. The migration was applied only to disposable PostgreSQL containers.

## Open items and known limits

1. Fixtures are documented shapes, not captures. Live traffic stays blocked on the US-06-01 go-live run; a finding that contradicts the contract record reopens this story.
2. The response shape of `GET orders/:id` is not in the contract record. The code assumes the order object at the top level with a `store_id`, and fails closed otherwise.
3. Skipped and ineligible orders do not appear in the dashboard list for any source. Their reason is on `webhook_events.last_error` only.
4. The rate budget is in memory, per API instance, and assumes the limit is per store. If the owed run shows it is per IP this must be redesigned before more than one merchant is live (contract record section 8).
5. Queue-outage recovery relies on the webhook reconciler, which is off unless `WEBHOOK_RECONCILIATION_ENABLED=true`.
6. `orderNumber` is derived from the order id until a real payload shows a merchant-facing reference.
7. An EasyOrders organization still cannot finish onboarding (US-06-02 open item 5), so with real data every order is skipped as `onboarding_incomplete` until US-06-05. The contract suite sets `onboarding_status` directly.
8. Orders received while the secrets or the order settings are missing are not ingested later. The connect screen says so.
9. The connection-health surface beyond the two notices on the connect screen is US-06-05.
10. "Canceled in Shopify" and "Complete Standalone setup" in shared dashboard copy are source-specific wording. Left for US-06-04 and US-06-05.

## Operational notes

- **Enable:** apply the deploy (migration 0048 runs at boot), make sure the store has both webhook secrets and its country and currency, then set `EASYORDERS_INGESTION_ENABLED=true`.
- **Disable:** set it back to `false`. New deliveries answer `404`; events already queued are still processed.
- **Logs to watch:** `easyorders-webhook-not-persisted` (alert: an event may be lost), `easyorders-webhook-accept` with `outcome: failure` (`reason` or `errorCode`), `easyorders-order-lookup`, `easyorders-order-normalize`, `webhook-job-defer`.
- **A merchant reports missing orders:** check `easyorders_connections.rejected_deliveries` and `health`, then `webhook_events` for the integration with `status = 'skipped'` and its `last_error`.
