# US-07-04 WooCommerce outcome synchronization evidence

**Validated:** 2026-10-04
**Revision:** backend `develop` at `1029ae9`; frontend `develop` at `cbd1aac`
**Decision:** implemented locally and shipped disabled (`WOOCOMMERCE_OUTCOME_SYNC_ENABLED=false`). Nothing is written to any WooCommerce store for any merchant until the US-07-06 live run has shown the real effect of the note, the marker and `cancelled` on a store (observations 5 and 6 of the contract record) and the product owner has accepted it.

WooCommerce behavior is taken only from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), sections 5 and 8. No request was sent to any store while building or testing this story: stores are the in-process fake (`test/contracts/woocommerce-provider-fake.ts`) under the real restricted outbound client, as its DNS and its transport.

## What the code had, against the story's evidence note

The story said nothing shared needed extracting, and that held. The outcome contract and registry (E02), the stored sync state, the retry worker and policy, the merchant retry endpoint, the processor's `order.update` routing and the dashboard "Store update" section (E06) are used as they are. None of them was edited. The only edits outside the spoke are two registrations (`commerce-outcome.module.ts`, `webhook-queue.module.ts`), the WooCommerce config and repository, and the frontend's code-to-message map.

## Decisions taken with the product owner (2026-10-04)

| Question | Decision |
| --- | --- |
| Story AC 7 says a merchant's own status change is recorded as observed. The record's echo rule calls any `order.updated` carrying a matching marker reflected, and the marker stays on the order, so every later merchant change would be reflected | `reflected_outcome` needs the marker of a recorded outcome **and** a delivered status that write could have left: `cancelled` for a cancellation, `processing` or `on-hold` for a confirmation. Anything else is `remote_status_observed`. |
| Finding 5.18 gives the confirmation note no text or language, and a merchant's manual confirmation dispatches the same action as the customer's reply | One fixed bilingual note that does not say who confirmed: `Akeed: order confirmed. / أكيد: تم تأكيد الطلب.` with `customer_note: false`. |
| Rule 8.4 says a `405` or `501` on a write is permanent and needs assistance; the failure table names no code | A new code, `store_write_method_refused`, permanent with `requiresAssistance`, with its own merchant message. |

All three are recorded as a dated amendment at the end of the contract record.

Decisions taken while building, within the record, for review:

| Topic | Decision |
| --- | --- |
| "This store's order" | The answer's `id` is the one asked for, and `_links.self[0].href` is exactly `<canonical store URL>/wp-json/wc/v3/orders/<id>` once the part before `/wp-json/` is canonicalized by the store-URL rules. Equality, not a prefix: a store at a domain root must not take the answer of one in a subdirectory. Anything else is `store_unverified`. |
| What counts as confirmed success | A `2xx` on the `PUT` whose body is this store's order and shows the write, or a read that shows it. A timeout, a broken connection, another `5xx`, an oversized answer, or a `2xx` that does not show the write is ambiguous and forces a read-back. |
| `429` and `503` on the write | Retryable without a read-back. Every retry starts with a read, so nothing is written blind. |
| Read-back | The same decision table as the first read. "Would write" becomes `write_unconfirmed`. |
| The note after a lost answer | When the first read showed no marker and the read-back shows it, the note is added in that same run. A later run sees the marker and adds none. |
| A cancellation's marker on an order that is not cancelled | `remote_state_conflict`. The write was taken and the merchant reopened the order; the table's "otherwise write" would cancel it a second time. Also what a store that answers `200` and ignores the status ends as. |
| A status that is not a status name | Missing, over 64 characters or not printable ASCII without spaces: `remote_state_conflict` with no `providerStatus`. |
| `Retry-After` | A spoke-local parser: seconds or an HTTP date, non-negative. It keeps a long wait, because the record says the sync policy clamps it; the EasyOrders parser discards waits over 10 minutes and was not reused. |
| Order id in a URL | Decimal digits only. Anything else is `order_not_found` with no request. |
| Health | `401` sets `credentials_rejected`, `403` sets `permission_denied`, a successful read sets `ok` again. The table's CHECK already allowed all three. |
| A stored key that is not an envelope | `credentials_unreadable`, needs assistance, never sent. |
| A source that is not connected | `disconnected_at` is US-07-05. Here the registry refuses an inactive source (`integration_inactive`), and the adapter refuses a missing connection row (`connection_missing`). |
| Module wiring | `WooCommerceIngestionModule` now provides the API client and the restricted client binding, and `WooCommerceModule` imports it, as the EasyOrders modules are arranged. |

## Implemented behavior

- **Data.** No migration. `commerce_outcome_syncs` (`0049`) and `woocommerce_connections.health` (`0051`) are reused unchanged.
- **Mapping (`woocommerce-outcome.mapping.ts`, pure).** `customer_confirmation`: the meta entry `akeed_outcome` = `<action>:<verification id>` and one internal note; no status. `customer_cancellation` and `merchant_no_reply_cancellation`: `status: cancelled` and the marker in one update; no note. `automatic_no_reply_tagging` and `merchant_cancellation_tagging`: no entry. Writable from `processing` and `on-hold` only.
- **Adapter (`WooCommerceOutcomeAdapter`).** `tracksSynchronization: true`, `requiresActiveConnection: true`. Read, decide, one `PUT`, a note for a confirmation whose first read showed no marker, read back after a lost answer. Every call is built from the stored canonical store URL and the decrypted keys of `findByIntegration(integrationId, orgId)`, through the restricted client. With the switch off `capabilities` is empty.
- **API client.** `getOrder`, `updateOrder`, `addOrderNote` with typed results. Only the status and the `akeed_outcome` values of an answer leave the client. The existing methods are unchanged.
- **Failure mapping.** `401` `source_credentials_rejected` and `403` `source_permission_denied` (both need assistance and set health); `404` `order_not_found`; `400` or another `4xx` on the write `remote_rejected`; `405`/`501` on the write `store_write_method_refused` (needs assistance); `429` `source_rate_limited` and `503` `source_unavailable`, retried with `retryAfterMs` from `Retry-After` when the answer names one; another `5xx`, a timeout or a network failure on a read `source_unavailable`, retried; a call the restricted client refuses `store_unreachable` (needs assistance).
- **Update handler (`WooCommerceOrderUpdateHandler`).** Registered in `WEBHOOK_ORDER_UPDATE_HANDLERS`. Reasons: `malformed_update_event`, `order_not_owned`, `reflected_outcome`, `remote_status_observed`. It reads two repositories and nothing else.
- **Config.** `WOOCOMMERCE_OUTCOME_SYNC_ENABLED`, independent of the other two switches; startup fails when it is on without `SHOPIFY_TOKEN_ENCRYPTION_KEY`. In `.env.example` and `docs/ENVIRONMENT.md`.
- **Frontend.** Three sentences in the "Store update" section, Arabic and English, for `source_permission_denied`, `store_unreachable` and `store_write_method_refused`, mapped by code in `remoteSync.ts`. `store_unverified`, `remote_rejected` and `write_unconfirmed` keep the general sentence. No source branch.

Shopify, Standalone and EasyOrders code is unchanged. No shared code changed.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Confirmation writes the marker and one note, no status; never `processing`, `completed` or paid | Contract: "a confirmation writes the marker and one internal note, and changes no status", "a confirmation is written from on-hold too", "never sends processing, completed or a paid flag to the store". Unit: adapter spec "approved mapping", client spec "never asks the store to mark the order paid", mapping spec. |
| 2. The two cancellations write `cancelled` only from the allowed statuses; automatic no-reply writes nothing and is unsupported | Contract: the four cancellation cases, "does not cancel an order that is ...", "keeps automatic_no_reply_tagging local", "shows automatic no-reply to the merchant as local only". Unit: mapping spec (no entry for the two tagging actions), adapter spec "never sends a request for ...". |
| 3. Read before write; terminal, custom or unlisted status is an explicit conflict; nothing falls through to Shopify | Contract: "remote state" (six statuses for a confirmation, three for a cancellation, an order already cancelled, an order the store no longer has). Unit: adapter spec "current remote state". The suite's registry holds only the WooCommerce adapter. |
| 4. Own integration and key through the restricted client; another tenant's order refused before any request | Contract: "tenant isolation" (five tests), "never sends a key to a store that no longer resolves to a public address", "does not follow a redirect with the key". Adapter contract spec: "every request goes to the address that was checked". |
| 5. Safe to repeat; marker and status in one update; note at most once; read back before any retry; no unconfirmed success | Contract: "does not write again for a repeated outcome: one update, one marker, one note", "a timeout before the write was taken" (two), "a timeout after the write was taken" (four), "does not cancel a second time an order the merchant reopened". Unit: adapter spec "a write whose answer was lost", "the note". |
| 6. Local intent kept; remote side stored as pending, succeeded, failed or unsupported; credential and permission failures stop and are flagged; throttling and transient failures use the bounded retry | Contract: "throttling and transient failures" (six), "credentials, permission and hosting" (eight), and every failing case asserts the local verification status. Frontend: `remoteSync.test.ts`. |
| 7. The echo is reflected and causes nothing; a merchant's change is observed; neither starts a second verification | Contract: "order.updated feedback loop" (nine tests, with the real hub: verification and send counts are asserted). Unit: handler spec. |
| 8. Switch off: no capability, every outcome unsupported, no request | Contract: "sends nothing at all while remote writes are switched off". Unit: adapter spec "offers nothing while remote writes are switched off", "is off when the configuration was never validated"; adapter contract spec. |

## Test requirements

| Case | Where |
| --- | --- |
| The shared outcome-adapter contract, for WooCommerce | `woocommerce-outcome.adapter.contract.spec.ts` (`defineCommerceOutcomeAdapterContract`), over the provider fake and the real restricted client. |
| Each approved mapping, request asserted | Contract "approved mapping"; adapter spec; adapter contract spec. |
| Unsupported automatic no-reply | Contract "keeps automatic_no_reply_tagging local"; adapter and mapping specs. |
| Terminal and custom current status | Contract "remote state"; adapter spec "never overwrites ...". |
| Wrong-tenant dispatch | Contract "refuses a dispatch that names another tenant's order, before any request", "does not let another organization reopen a failed sync". |
| Disconnected source | Contract "a source that is not connected" (inactive, a retry queued before, a missing connection row). The disconnect itself is US-07-05. |
| Switch off | Contract "sends nothing at all while remote writes are switched off". |
| Timeout before the write was taken | Contract "on the read: nothing was written, and the retry does the whole write", "on the write: writes again only after reading that the first was not taken". A real timeout of the restricted client (250 ms in the suite). |
| Timeout after the write was taken, read-back | Contract "reads the order back and reports success without writing twice", "adds the confirmation note once the read-back shows the marker", "stays pending when the read-back is lost too ...", "treats a broken connection the same as a timeout". |
| Repeated outcome, one note | Contract "does not write again for a repeated outcome: one update, one marker, one note"; adapter contract spec "a repeated outcome writes nothing again". The fake adds a second meta entry for a repeated key, the worst case of finding 5.3. |
| Throttling | Contract "waits for a 429 that names a delay, without spending an attempt, then succeeds", "honors Retry-After on a 503 from the host as well", "uses the existing backoff for a 429 that names no delay". Client spec `parseRetryAfter`. |
| Revoked key | Contract "a revoked key stops at once ...", "a key revoked between the read and the write stops there too", "a key whose user lost the permission ...", "clears the health state once the store accepts the keys again". |
| Feedback loop on `order.updated` | Contract "order.updated feedback loop": own confirmation, own cancellations, the echo of a write whose answer never arrived, the merchant completing, reopening and cancelling an order, a forged marker, another tenant's order on this tenant's token. |
| Secrets | Contract "never logs, returns or stores a key, a token or a secret", "puts no customer data in what it writes to the store". |

## Validation results (as run, 2026-10-04)

Backend (`akeed-backend`), before any change, at `fdaa802`:

| Command | Result |
| --- | --- |
| `npx jest` | 197 suites, 5203 tests: 5202 passed, 1 failed. The failure is `parse-import-file.timing.spec.ts`, a wall-clock limit in the order-import parser that this story does not touch. It passed in the run after the change. |
| `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests. |
| Shopify, EasyOrders outcome sync, WooCommerce connection, WooCommerce ingestion contract scripts | PASS: 11, 33, 112, 64. |

Backend, after, at `1029ae9`:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |
| `npx jest` | PASS, 202 suites, 5458 tests. |
| `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-07-04-build` | PASS. Used instead of `npm run build`, which deletes `dist`; the output was removed. `nest build` itself was not run. |
| `scripts/test-woocommerce-outcome-sync-contract.ps1` (disposable PostgreSQL 17) | PASS, 63 tests. |
| `scripts/test-woocommerce-connection-contract.ps1` | PASS, 112 tests. |
| `scripts/test-woocommerce-ingestion-contract.ps1` | PASS, 64 tests. |
| `scripts/test-easyorders-outcome-sync-contract.ps1` | PASS, 33 tests. |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 58 tests. |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 59 tests. |
| `scripts/test-shopify-contract.ps1` | PASS, 11 tests. |
| `scripts/test-source-identity-contract.ps1` | PASS, 1 test. |

The after run was interrupted once, during the Shopify contract script. The unit suite, the Shopify suite and the source-identity suite were run again and the figures above are from those runs; the container the interrupted script left behind was removed. The existing Shopify, Standalone and EasyOrders specs were not edited.

Frontend (`akeed-frontend`), at `cbd1aac`:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | No error in `src/`. 9 errors in stale generated files under `.next/` (`.next/types`, `.next/shopify/dev/types`, `.next/e01-validation-build/types`), the same ones recorded for US-07-02 and US-07-03. |
| `npm run lint` | PASS, 0 errors, the 4 existing warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run test` | PASS, 101 files, 1123 tests. |
| `NEXT_DIST_DIR=.next-us0704 npx next build` | PASS. The `tsconfig.json` edit it makes was reverted and the folder removed. |

Not run:

- The frontend suite before the change. Only the after run exists.
- The E01 to E06 release gates (`npm run test:gate:*`). US-07-06 runs them.
- The remaining contract suites: order imports (no migration was added, so its list is unchanged), EasyOrders release gate, entitlements, platform-boundary migration, integration keys, order API, manual order ingestion, verification overview, standalone provisioning, Paymob checkout and the E04.5 credit and billing suites.
- Any browser check. The three messages appear only on a failed store update behind login; Arabic/RTL, English, light and dark still need a person's eyes.
- Anything against a real store, a shared database or a deployed environment.
- The retry worker against a real Redis. Its logic is tested with the queue faked.

## Open items and known limits

1. **Remote writes stay off.** Enabling them needs US-07-06 observations 5 and 6: the side effects of `cancelled` from `processing` and `on-hold` (stock, emails), whether a meta-only update and a cancellation come back as `order.updated`, and whether a repeated key duplicates the marker.
2. **The order's own link is an untested shape.** The identity check rests on `_links.self[0].href`, known from the documentation's examples only. If a real store builds it from another address than its `home_url` (findings 2.9 and 5.7), every write fails closed as `store_unverified`: visible, never a wrong write. A finding there reopens this story.
3. **A confirmation can end with the marker and no note.** If the note request fails, or the write's answer and its read-back are both lost, the outcome is `applied` (or becomes so on the retry) and no note is added later. This is the record's "known limit of the note"; the contract suite asserts it.
4. **Two runs at the same instant are not locked.** A dispatch and a retry of the same outcome that both read before either writes would both write and, for a confirmation, both add a note. The sync row and the retry schedule make that unlikely; nothing in the store can prevent it (finding 5.6).
5. **A store that answers `200` and does not cancel** ends as `remote_state_conflict`, and stays so on a manual retry because its marker is already there. Which transitions a store refuses, and how, is finding 5.11.
6. **A sync left `pending` by a process that died has no sweeper** (carried from E06 open item 5).
7. **Disconnect is US-07-05.** It must close the source's waiting rows (`failPendingForIntegration`), as the EasyOrders disconnect does, and add the adapter's own check of `disconnected_at`.
8. **Health is written and not shown yet.** `credentials_rejected` and `permission_denied` reach the merchant only as the sentence on the failed store update. The health surface and the reconnect offer are US-07-05.
9. **The merchant's cancel action** for a no-reply order is offered for a WooCommerce source once the switch is on, through the shared capability check. It was not looked at in a browser.
10. **`parse-import-file.timing.spec.ts` is sensitive to machine load.** It failed once in the baseline run and passed afterwards. Not changed here.

## Operational notes

- **Enable:** only after the US-07-06 gate. Confirm the store is connected and its health is `ok`, then set `WOOCOMMERCE_OUTCOME_SYNC_ENABLED=true`. Needs Redis for the retry queue.
- **Disable:** set it back to `false`. New outcomes are recorded `unsupported`; a queued retry records `unsupported` on its next run and stops.
- **Logs to watch:** `woocommerce-outcome-sync` (`errorCode`, `providerStatus`), `woocommerce-outcome-note` (a confirmation whose note was not added), `commerce-outcome-dispatch`, `commerce-outcome-sync-retry`, `webhook-order-update-handle` (`reason`), and the tracker's own failures `commerce-outcome-sync-begin`, `-settle`, `-schedule`.
- **A merchant reports an order not updated:** read `commerce_outcome_syncs` for the order (`state`, `error_code`, `provider_status`, `attempts`), then `woocommerce_connections.health`. `remote_state_conflict` means the store had already moved the order; `source_credentials_rejected` and `source_permission_denied` need a reconnect; `store_unverified` means the store's answer did not name this store's order (open item 2); `store_write_method_refused` means the host blocks `PUT`; `store_unreachable` means the stored address no longer passes the outbound checks.
- **What Akeed leaves in a store:** one `akeed_outcome` meta entry per outcome written, and one internal note per confirmation. Neither holds customer data.
