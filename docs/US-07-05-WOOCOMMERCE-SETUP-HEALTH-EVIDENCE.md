# US-07-05 WooCommerce setup, health, disconnect and support evidence

**Validated:** 2026-10-05
**Revision:** backend `develop` at `c6b8d5e` (shared change `1757659`); frontend `develop` at `62c3198` (shared extraction `69132ac`)
**Decision:** implemented locally. It adds no switch of its own: connect and reconnect need `WOOCOMMERCE_CONNECT_ENABLED` and the pilot list, re-enabling a webhook needs `WOOCOMMERCE_INGESTION_ENABLED`, and disconnect, the connection check, the status and the health read need none. Nothing is enabled for a real merchant before the US-07-06 gate, as for US-07-02 to US-07-04.

WooCommerce behavior is taken only from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), sections 2, 3 and 7, and its amendments. No request was sent to any store while building or testing this story: stores are the in-process fake (`test/contracts/woocommerce-provider-fake.ts`) under the real restricted outbound client, as its DNS and its transport.

Operations: [disconnect, webhook recovery and support runbook](Epics/07-woocommerce-integration/evidence/US-07-05-disconnect-and-support-runbook.md).

## What the code had, against the story's evidence note

The story's note held: source resolution, the test message and settings were platform-neutral, and E06 had left a setup-contributor registry, a health DTO and endpoint, and source skins that resolve by platform. What was missing for WooCommerce:

- `SOURCE_SETUP_CONTRIBUTORS` held only EasyOrders, so a WooCommerce source had no `sourceSetup` block and `POST /api/onboarding/complete` answered `source_invalid`. Setup could not be finished, and every real order would have been skipped as `onboarding_incomplete`.
- `woocommerce_connections.health` was written by the outcome adapter and shown nowhere (US-07-04 open item 8). Nothing read a webhook's state.
- Any integration row, active or not, blocked a connect, so reconnect was refused by construction.
- The six credential columns were `NOT NULL`, so a row could not be wiped.

The frontend folders were re-read before designing, as the story asked:

- `features/onboarding`: the WooCommerce connect screen ended at "connected" with nowhere to go. The setup flow hook, the checklist card and the disconnect dialog existed only as EasyOrders files.
- `features/settings`: the order-source tab resolves a skin by platform in `sourceSkins.ts`, with no WooCommerce row. Two existing tests used WooCommerce as their example of a platform with no skin.
- The health card had no place for a webhook's state.

## Decisions

Product owner, 2026-10-05 (recorded as a dated amendment at the end of the contract record):

| Question | Decision |
| --- | --- |
| The record (section 7) says the webhooks are deleted while the keys are held, then the row is wiped. That leaves the source active while Akeed waits on a merchant's store | Stop and wipe first. One transaction deactivates the source and wipes the keys, the token hash, the webhook ids and the verified slot. The keys it read are held in memory for that request and used to delete the two webhooks, best effort; a failure is reported. |
| The setup flow, the checklist card and the disconnect dialog exist only as EasyOrders files | Extract them to `skins/connect/`. The EasyOrders files keep their names and exports and delegate. Its own commit, EasyOrders tests unedited. |
| The story names no switch for re-enabling a webhook, and re-enabling with ingestion off cannot hold | Re-enable needs `WOOCOMMERCE_INGESTION_ENABLED` on. It needs neither the connect switch nor the pilot list. |

Taken while building, within the record, for review:

| Topic | Decision |
| --- | --- |
| Where the setup reason `webhook_disabled` comes from | The last state Akeed read, stored on the connection row. The store is read only when health is read, on a connection check and before a re-enable (section 3: no background poll). `describe()` reads rows only, because `GET /api/onboarding/state` runs on every route guard and must not wait on a merchant's host. |
| How health asks the store | A new optional `inspectWebhooks` on `SourceSetupContributor`, called by `SourceSetupService.health()` alone, before `describe`, so the credential status is the answer just given. The `webhooks` key on the health DTO is absent for a source without it. Shared change, its own commit. |
| `401` and `403` | Both are credential status `rejected` and reason `credentials_rejected` (record, screen states). The status DTO keeps `permission_denied` apart for its own guidance. An answer that needed the keys to be given clears either. |
| Which webhook states block setup | Only `disabled`. `paused` is the merchant's choice and is never overridden; `missing` needs a reconnect. Both are shown, in health and on the screens, with their own guidance. |
| Recovery from rejected keys or a deleted webhook | Disconnect, then reconnect. Reconnect is offered only from the disconnected state, as in E06. |
| Currency and phone country | The contributor returns `orderDefaults: { currency: null, phoneCountry: null }` and never pushes `order_defaults_missing`. No shared type changed, and EasyOrders still requires both. |
| The connection check | `200` with the codes found, most fundamental first: a diagnosis is an answer, not a failed request. `system_status` first (address, TLS, REST, keys, permission, `home_url` still equal), then both webhooks. Owner or admin, because it makes Akeed call the store. |
| Where the reconnect store is checked | At the start, before the discovery probe, and again in the transaction. A disconnected organization cannot make Akeed call another host. |
| What a reconnect resets | New ciphertexts, token hash and webhook ids; `health` `ok`; refused-delivery counter zero; `connected_at` now, so an order placed while disconnected is `order_predates_connection`. `onboarding_status` is left as it is. |
| A re-enable that changes nothing | Success is what the store shows. A webhook that still reads `disabled` after a `2xx`, or a `405`/`501` on the `PUT`, is `WOOCOMMERCE_WEBHOOK_ENABLE_FAILED`. With one webhook deleted, the other is not touched. |
| Budgets | 8 seconds for a health read (two requests, in parallel), 20 for a check or a re-enable, 15 for the deletion at disconnect. Each is one deadline over all of its calls. |
| The store on the screens | Named by its canonical address, without the scheme, kept left to right in Arabic. No key, secret, token, delivery address or authorize link. |
| Where the check is offered | In Settings and on the setup screen: a merchant whose onboarding is pending cannot reach Settings, and nothing else there reads the store. |
| Settings panel after a health read | The panel reads its status again when the health card's answer lands, so a webhook the health read found disabled can be re-enabled without a reload. |

## Implemented behavior

- **Data.** Migration `0052_woocommerce_disconnect.sql`, additive and re-runnable, with its `_journal.json` entry and the schema change. New columns: `disconnected_at`, `disconnected_by`, `order_created_webhook_state`, `order_updated_webhook_state`, `webhooks_checked_at`. The three ciphertexts, `webhook_token_hash` and the two webhook ids become nullable. `woocommerce_connections_credentials_state_check` ties them together: a connected row holds all six, a disconnected row holds none and no verified slot. `woocommerce_connections_webhook_state_check` limits the two state columns. No existing row is rewritten.
  - Rollback: reconnect or delete rows with `disconnected_at` set, drop the two checks, restore `NOT NULL` on the six columns, drop the five columns. Orders and verifications are unaffected. The full statement list is in the runbook, section 7.
- **Setup.** `WooCommerceSetupContributor`, registered in `SOURCE_SETUP_CONTRIBUTORS`. `GET /api/onboarding/state` and `GET /api/settings` now carry `sourceSetup` for a WooCommerce source, and `POST /api/onboarding/complete` honors its reasons: `source_disconnected`, or `credentials_rejected` and `webhook_disabled`.
- **Health.** `GET /api/settings/source-health` gains `webhooks: { checkedAt, items: [{ kind, state }] }` for a connected WooCommerce source, read from the store at that moment. States: `active`, `paused`, `disabled`, `missing`, `unknown`. Every other signal is the existing one.
- **Connection check.** `POST /api/woocommerce/connection/check` (owner or admin). Codes: the support-boundary codes (`WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC`, `_STORE_REDIRECTS`, `_STORE_TLS_FAILED`, `_REST_NOT_FOUND`, `_REST_UNREACHABLE`, `_PROVIDER_UNAVAILABLE`, `_CREDENTIALS_REJECTED`, `_PERMISSION_DENIED`, `_STORE_URL_MISMATCH`) and three new ones: `WOOCOMMERCE_WEBHOOK_MISSING`, `WOOCOMMERCE_WEBHOOK_DISABLED`, `WOOCOMMERCE_WEBHOOK_PAUSED`.
- **Re-enable.** `POST /api/woocommerce/connection/webhooks/enable` (owner or admin). Reads both, sets each `disabled` one to `active`, reads again. `503 WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE` while ingestion is off; `409 WOOCOMMERCE_WEBHOOK_MISSING`; `503 WOOCOMMERCE_WEBHOOK_ENABLE_FAILED`.
- **Disconnect.** `DELETE /api/woocommerce/connection` (owner or admin). The transaction, then the two deletions at the store, then waiting `commerce_outcome_syncs` rows closed as `integration_inactive`. Answers the status plus `webhookCleanup`: `removed`, `failed` or `not_attempted`. A second call is a no-op and calls no store. Nothing is purged.
- **Queued effects.** They rely on the `is_active` guards that already existed (webhook acceptance, `WebhookQueueProcessor.resolveSource`, the automation worker, the dispatch claim, `CommerceOutcomeRegistryService`). New code only where a credential can now be null: the outcome adapter answers `integration_inactive` for a disconnected connection, the normalizer skips, and the webhook service treats a missing secret as unreadable.
- **Reconnect.** Through `POST /api/woocommerce/install` and the callback. `409 WOOCOMMERCE_RECONNECT_STORE_MISMATCH` for another canonical URL, at the start and in the transaction; `409 WOOCOMMERCE_STORE_UNAVAILABLE` when another organization has connected the store since, before any authenticated request. The integration and connection rows are updated in place. The callback's existing "delete every webhook that delivers to Akeed, then create two" step is what replaces the old webhooks.
- **Status.** `GET /api/woocommerce/connection` gains state `disconnected`, and `connection` gains `rejectedDeliveries`, `webhooks` (the last states read), `webhooksCheckedAt` and `disconnectedAt`. A reconnect under way shows as `pending`, `failed` or `expired` with the connection still described. Readable by any member, with the switch off.
- **Frontend.**
  - Setup: the connected screen ends in the order notifications with their state, a connection check, and a checklist (store, order notifications, Akeed sender), a summary of the automation that will run, and the number for the free test. Then the shared test step and completion.
  - Views for rejected access (with disconnect behind a confirmation) and disconnected (manual API-key removal steps, whether the store deleted the webhooks, and a reconnect of the same store with no address to type).
  - Settings: a WooCommerce row in `sourceSkins.ts` with a connection panel (webhook states, re-enable, connection check with per-code guidance, disconnect, reconnect) and the health card, which now has one row per webhook.
  - A disabled webhook says, wherever it is shown, that orders placed while it was disabled are not imported.
  - Arabic and English for every state. No key, secret, token, delivery address or authorize link is rendered.

Shopify, Standalone and EasyOrders code is unchanged on the backend. Shared backend changes: the optional `inspectWebhooks` and `webhooks` on the source-setup contract, the `webhook_disabled` reason, and the registration in `onboarding.module.ts`. Shared frontend changes: the three extracted components, the WooCommerce row in `sourceSkins.ts`, the webhook rows in `SourceHealthCard`, and the `webhook_disabled` blocker message.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Onboarding identifies the store, the automation settings and the Akeed sender, and can be completed; currency and phone country are not inputs | Unit: `woocommerce-setup.onboarding.spec.ts` (the real contributor behind the real onboarding and settings routes: "identifies the store, automation and the Akeed sender, with no currency or phone country to enter", "finishes onboarding through the common route without either"), `woocommerce-setup.contributor.spec.ts`. Contract: connection "setup". Frontend: `WooCommerceConnectPage.test.tsx` "setup checklist" (Arabic and English), `wooCommerce.types.test.ts` "buildWooCommerceChecklist". |
| 2. Connection checks tell an invalid URL or TLS failure, REST unreachable, permission denied, rejected credentials and webhook problems apart, each with its own code and localized guidance | Contract: connection "connection check" (14 tests: 12 store conditions, each told apart by its own code against the fake store under the real restricted client, plus the switches and the role). Unit: `woocommerce-connection-health.service.spec.ts` "check". Frontend: `WooCommerceSourcePanel.test.tsx` "connection check" (9 codes in English, a pair in Arabic), `wooCommerce.types.test.ts` (every code has its own guidance in both languages, no two the same). |
| 3. Health shows separate facts with no overall verdict, including each webhook's state as read from the store; no recent events is not a fault | Unit: `source-setup.webhooks.spec.ts` (6 tests), `woocommerce-setup.onboarding.spec.ts` "adds each webhook's state to health, for any member, with no overall verdict". Contract: connection "webhook state in health" (8 tests). Frontend: `SourceHealthCard.webhooks.test.tsx` (9 tests, including "does not treat a store with no recent events as a fault of its webhooks"). |
| 4. Owner or admin can re-enable a disabled webhook; orders placed meanwhile are not imported, and the screen says so | Contract: connection "re-enabling a disabled webhook" (7 tests: the write and the confirming read, the ping answered `200`, ingestion off, a deleted webhook, a store that does not make the change, a paused one left alone, viewer and other tenant). Frontend: page and panel "a disabled order notification"; `sourceSkins.test.ts` asserts the "not imported" sentence in both languages. |
| 5. Disconnect stops new and queued effects, deletes the webhooks by REST as best effort and reports a failure, wipes the credentials and keeps history; manual key removal is described | Contract: connection "disconnect" (11 tests); ingestion "a disconnected source" (old address `401`, queued event, queue outage, history kept); outcome-sync "a disconnected source" (waiting update closed, reply afterwards, adapter guard, only its own rows, written history kept). Frontend: disconnect dialog and key-removal steps in page and panel tests. Runbook sections 1 and 2. |
| 6. Reconnect to the same canonical store and source, in place, with new credentials and replaced webhooks; another merchant's store, a different store or another source is refused | Contract: connection "reconnect" (14 tests): "brings the same store back in place ... its webhooks replaced" (the old webhooks were deliberately left at the store first), three wrong-store forms refused at the start with no request, a tampered install refused in the transaction, "refuses a reconnect when another organization has verified the store since", "another tenant cannot reconnect into this organization's disconnected source", and the existing other-platform refusals. |
| 7. Arabic and English, RTL and LTR, keyboard access, loading, empty and error states; no secret shown; a store outside the boundary is directed to support with no promise | Frontend: page, panel, health card and store-tab tests in both languages; focus moves to the heading on a state change ("disconnects after a confirmation ..."); loading skeletons and load-error retries; `container.innerHTML` checked for keys, the authorize path and the delivery path; the check's support line ("Akeed can't promise it works with every hosting setup or plugin") asserted on every problem. Not looked at in a browser: see "Not run". |

## Test requirements

| Case | Where |
| --- | --- |
| REST blocked | Contract "tells a REST API that is not there (plain permalinks) apart", "a store that does not answer". |
| TLS failure | Contract "tells an invalid TLS certificate apart"; also an address that redirects, and one that is no longer public (no request sent at all). |
| Rejected credentials | Contract "tells keys the store rejects apart", "a key revoked in the store shows as rejected credentials on the next health read", "keys the store rejects are recovered by disconnect then reconnect, on the same source". |
| Insufficient permission | Contract "tells a user who may no longer manage WooCommerce apart", "a key whose user lost the permission shows as rejected, and clears once it is back". |
| Webhook disabled then re-enabled | Contract "shows a webhook the store has as disabled, and only a disabled one blocks setup", "sets it active again at the store, confirms by reading, and answers the ping". |
| Webhook deleted at the store | Contract "shows a webhook deleted at the store as missing", "cannot bring back a webhook that was deleted at the store ...", "a webhook deleted at the store is recovered the same way, with no duplicate". |
| Disconnect: wipe | Contract "stops the source, deletes Akeed's webhooks at the store and wipes every credential, keeping the store and the integration", "a disconnected row can hold no credential and no verified slot, and a connected one cannot lose any" (the CHECK constraints). |
| Disconnect: idempotence | Contract "a second disconnect changes nothing and calls no store". |
| Disconnect: queued event | Ingestion contract "does not process an order that was queued before the disconnect: no order, no message", "does not process one that was waiting out a queue outage either". |
| Disconnect: queued store update | Outcome-sync contract "closes a store update that was waiting to retry, at the disconnect, without a request". |
| Disconnect: webhook deletion failing | Contract "still disconnects and says the webhooks are left when ..." (the store refuses, does not answer, or had revoked the key); the old address then answers `401`. Unit: auth service "disconnect" (9 tests). |
| Same-store reconnect without duplicate webhooks | Contract "brings the same store back in place ..." (exactly two webhooks, neither an old one), "two reconnect callbacks at once bring the source back once, with exactly its two webhooks". |
| Wrong-store reconnect | Contract "refuses a different store / the same host under another path / the www form of the same host at the start, without calling it", "refuses a callback whose install names another store, and leaves nothing at that store". |
| Reconnect after another organization verified the store | Contract "refuses a reconnect when another organization has verified the store since, and leaves that connection and its webhooks untouched". |
| Viewer denial | Contract: check, re-enable, disconnect and reconnect each refuse a viewer. Unit: auth service "owner or admin only". Frontend: viewer tests on the page and the panel. |
| Cross-tenant denial | Contract "has nothing to say of another tenant's source, and asks no store for it", "another tenant cannot disconnect this connection", "another tenant cannot reconnect into this organization's disconnected source", "refuses a viewer, and never touches another tenant's store", and every check case asserts no request went anywhere but the bound store. Ingestion "never reports another tenant's events after a disconnect". Outcome-sync "closes only its own waiting rows". |
| History and health readable after disconnect | Ingestion contract "keeps orders, verifications and events, and setup and health still read them". Connection contract "keeps setup and health readable afterwards, and asks the store nothing". Unit: `woocommerce-setup.onboarding.spec.ts` "keeps state and health readable after a disconnect, and refuses completion". |
| After a reconnect | Ingestion contract "after a reconnect the new address feeds the same source and the old one stays dead", "an order placed while the source was disconnected starts nothing after the reconnect", "counts a refused delivery from zero again after a reconnect". |
| Secrets | Connection contract "never puts a key, secret or token in a response, a log line or a stored column" now covers the check, re-enable, disconnect and reconnect answers; "logs the host of a store and never its path". Unit: auth and health service specs assert the same on their own log lines. |

## Validation results (as run, 2026-10-05)

Backend (`akeed-backend`). "Clean checkout" is a separate git worktree at the named commit, sharing `node_modules`.

| Command | Before, at `9791e94` (clean checkout) | After the shared change, at `1757659` (clean checkout) | After the feature, at `c6b8d5e` |
| --- | --- | --- | --- |
| `npx jest` | 202 suites, 5458 tests. 5456 passed in the run made together with the contract suites; the 2 that failed (`order-imports.http.spec.ts`, `order-imports.authorization.http.spec.ts`, at 83 s and 95 s) passed when run alone (237 tests). | PASS, 203 suites, 5464 tests. | PASS, 207 suites, 5596 tests, run alone. In a run made together with frontend checks, `parse-import-file.timing.spec.ts` failed once (the wall-clock limit recorded as US-07-04 open item 10). |
| `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests. | PASS, 12 suites, 176 tests. | PASS, 12 suites, 176 tests. |
| `scripts/test-shopify-contract.ps1` | PASS, 11. | PASS, 11. | PASS, 11 (clean checkout). |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 59. | PASS, 59. | PASS, 59 (clean checkout). |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 58. | PASS, 58. | PASS, 58 (clean checkout). |
| `scripts/test-easyorders-outcome-sync-contract.ps1` | PASS, 33. | PASS, 33. | PASS, 33 (clean checkout). |
| `scripts/test-source-identity-contract.ps1` | PASS, 1. | PASS, 1. | PASS, 1 (clean checkout). |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS, 10. | PASS, 10. | PASS, 10 (clean checkout). |
| `scripts/test-woocommerce-connection-contract.ps1` | PASS, 112. | PASS, 112. | PASS, 168 (clean checkout). 56 new. |
| `scripts/test-woocommerce-ingestion-contract.ps1` | PASS, 64. | PASS, 64. | PASS, 72 (clean checkout). 8 new. |
| `scripts/test-woocommerce-outcome-sync-contract.ps1` | PASS, 63. | PASS, 63. | PASS, 68 (clean checkout). 5 new. |
| `scripts/test-order-imports-contract.ps1` | PASS, 60. | PASS, 60. | PASS, 60 (clean checkout). `0052` added to its migration list. |

At `c6b8d5e` only:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-07-05-build` | PASS. Used instead of `npm run build`; the output was removed. `nest build` itself was not run. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |

The existing Shopify, Standalone and EasyOrders specs were not edited. Among the WooCommerce specs, three fixtures gained the new columns, the auth service spec's source check moved from `getOverview` to `readSourceSlot`, the three contract suites' harnesses pass the two new constructor arguments and apply `0052`, and one status assertion gained the new fields.

Frontend (`akeed-frontend`):

| Command | Before, at `cbd1aac` | After the extraction, at `69132ac` (clean checkout) | After the feature, at `62c3198` |
| --- | --- | --- | --- |
| `npm run test` | PASS, 101 files, 1123 tests. | PASS, 101 files, 1123 tests. `useEasyOrdersSetupFlow.test.tsx`, `EasyOrdersConnectPage.test.tsx` and `EasyOrdersSourcePanel.test.tsx` pass unedited. | PASS, 104 files, 1235 tests. |
| `npx tsc --noEmit` | Not run. | No error in `src/`. | No error in `src/`. 9 errors in stale generated files under `.next/`, the same ones recorded for US-07-02 to US-07-04. |
| `npm run lint` | Not run. | Touched files only: PASS. | PASS, 0 errors, the 4 existing warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | | PASS. | PASS. |
| `NEXT_DIST_DIR=.next-us0705 npx next build` | | Not run. | PASS. The `tsconfig.json` edit it makes was reverted and the folder removed. |

Two existing frontend tests were edited, both because WooCommerce was their example of a platform with no Settings skin: `sourceSkins.test.ts` (the "has no skin" list now uses `salla`; WooCommerce joins the skinned cases, the key-parity check and a "no promise, no credential" check of its own) and `StoreTab.test.tsx` ("falls back to the platform id for a source with no skin of its own" now uses `salla`). `WooCommerceConnectPage.test.tsx` gained the new connection fields in its fixture and a query client in its harness; none of its 21 existing cases was removed.

Not run:

- The E01 to E06 release gates (`npm run test:gate:*`). US-07-06 runs them.
- The remaining contract suites: EasyOrders release gate, entitlements, platform-boundary migration, integration keys, order API, manual order ingestion, verification overview, Paymob checkout and the E04.5 credit and billing suites. None of them touches a file this story changed.
- Any browser check. Every changed screen is behind login; Arabic/RTL, English, light and dark, and keyboard use of the disconnect dialog still need a person's eyes.
- Anything against a real store, a shared database or a deployed environment. Migration `0052` was applied by these runs only to disposable PostgreSQL containers, twice each. It also runs at boot, so a local API will apply it to its own development database on its next start.
- The frontend type check and lint before the change. Only the test suite has a before run.

## Open items and known limits

1. **Nothing here has been seen on a real store.** Whether re-enabling resets the store's failure count or sends a ping (3.17), the answer to a revoked key (2.6), and whether a host accepts `PUT` and `DELETE` (8.4) are US-07-06 observations 2 and 7. The code follows the record's worst-case rule for each.
2. **A webhook's state is as old as the last time someone looked.** Nothing polls. Between health reads and checks, setup and the panel show the last state stored. A webhook disabled an hour ago shows as active until the tab is opened or the check is pressed.
3. **A process that dies between the wipe and the store deletion leaves the webhooks at the store with nothing reported.** They answer `401` and the store disables them; a reconnect removes them. This is the price of stopping first.
4. **A request already on the wire at the disconnect cannot be recalled.**
5. **A disconnect also works on a source that was switched off without one**, and a source its merchant disconnected can be reconnected by them. A source deactivated by staff could therefore be brought back by disconnecting and reconnecting. EasyOrders has the same property (US-06-05). There is no staff-deactivation flow today that depends on it; if one is added it needs its own marker.
6. **A second disconnect retires a reconnect link opened since the first.** It changes nothing else.
7. **Reconnect needs the connect switch on and the organization on the pilot list.** Otherwise the merchant sees `WOOCOMMERCE_CONNECT_UNAVAILABLE` or `WOOCOMMERCE_PILOT_REQUIRED`. History and health stay readable.
8. **A different store, or the same store at a new address, cannot be reconnected.** A domain move or a forced `www` is a support path, and there is no staff tool for it yet.
9. **`paused` and `missing` do not block setup.** A merchant can finish onboarding with a webhook they paused or deleted; the screen and health say so, and no order arrives until it is fixed.
10. **The health card's "Events refused before processing" row says "a wrong webhook secret"** for every source. For WooCommerce a refused delivery can also be a source-address mismatch. The WooCommerce panel words it correctly; the shared row was not changed, because its text is asserted by the EasyOrders tests.
11. **Unreadable stored keys are reported as rejected** in a connection check (`WOOCOMMERCE_CREDENTIALS_REJECTED`), with `credentials_unreadable` in the log. The fix is the same for the merchant: disconnect and reconnect.
12. **The API keys tab is still shown for a WooCommerce source**, as for EasyOrders (US-06-05 open item 8). The backend refuses it.
13. **`POST /api/onboarding/setup` completes onboarding without the setup check**, for any source (US-06-05 open item 9). Existing behavior, not changed.
14. **A health read by a viewer makes Akeed call the store.** Any member may read health, and the read is what asks. It is two bounded requests to the organization's own bound store.
15. **`parse-import-file.timing.spec.ts` and the two order-import HTTP specs are sensitive to machine load.** Each failed once in a run made alongside other suites and passed alone. Not changed here.

## Operational notes

- **Deploy:** migration `0052` runs at boot. No new environment variable.
- **A merchant cannot finish setup:** read `GET /api/onboarding/state` → `sourceSetup.blockedReasons`.
- **A merchant reports no orders:** ask them to open Settings → order source, which reads the store, then follow the runbook, section 3.
- **Before turning ingestion on for a store that connected while it was off:** its webhooks are disabled. The merchant presses "Re-enable order notifications" after the switch is on.
- **Logs:** `woocommerce-disconnect` (`webhookCleanup`, `closedPendingSyncs`), `woocommerce-disconnect-webhook-cleanup` and `woocommerce-disconnect-close-syncs` (failure only), `woocommerce-connection-check` (`problems`), `woocommerce-webhook-read`, `woocommerce-webhook-enable`, `woocommerce-install-callback` (`reconnected`). Each names the store by host only.
- **Everything else:** the [runbook](Epics/07-woocommerce-integration/evidence/US-07-05-disconnect-and-support-runbook.md).
