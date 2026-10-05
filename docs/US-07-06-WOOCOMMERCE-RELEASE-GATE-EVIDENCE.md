# US-07-06 WooCommerce release gate evidence (automated gate)

**Validated:** 2026-10-05
**Revision:** backend `develop` at `03da34f` with an uncommitted refactor of the store spokes on top (tree `1c8569c46d03`, see [Validation results](#validation-results-as-run-2026-10-05)); frontend `develop` at `cfac6ee`
**State:** automated gate run as scripts. **Live pilot NOT RUN.** The story stays open: acceptance criteria 4, 5 and 7 need the run on a real store, and the release-gate record with the go/no-go recommendation (`Epics/07-woocommerce-integration/evidence/US-07-06-release-gate.md`) is written after it.

WooCommerce behavior is taken only from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md) and its amendments. No request was sent to any store, to Meta, to Shopify or to Paymob, no WhatsApp message was sent, and no shared database was touched: stores are the in-process fake (`test/contracts/woocommerce-provider-fake.ts`) under the real restricted outbound client, as its DNS and its transport.

For the product owner's run: [live pilot script](Epics/07-woocommerce-integration/evidence/US-07-06-live-pilot-script.md), `scripts/woocommerce-pilot-reconcile.sql`, `scripts/woocommerce-pilot-probe.mjs`.

## What this gate is, and is not

It proves Akeed's side: the adapter contract, the journey against a provider fake, tenant isolation, replay and fault recovery, disconnect and reconnect, the address rules on every outbound path, and that Shopify, Standalone and EasyOrders work the same beside it. Where the record says UNKNOWN the fake takes the record's worst-case rule.

It does not prove WooCommerce. The fixtures are still "documented, not captured", and the eight observations the record hands to this gate are all still open. One store, when it is run, proves the adapter on that store; it is not a claim about every host.

## What changed

Backend (`akeed-backend`, branch `develop`, no feature branch):

| Commit | What |
| --- | --- |
| `ce2aff2` | Two defects fixed in the WooCommerce spoke (below), with unit tests. |
| `b1d8b82` | The provider-neutral matrix of the US-06-06 gate extracted to `test/contracts/source-conformance-harness.ts`, with `test/contracts/easyorders-conformance-driver.ts`. Test code only. |
| `a9ffa76` | A shared logging defect fixed (below): `src/shared/logging/backend-log.util.ts`, `src/shared/filters/global-exception.filter.ts`, with unit tests. |
| `940d535` | `test/contracts/woocommerce-conformance-driver.ts`; `test/woocommerce-release-gate.contract-spec.ts` with its Jest config and runner; a Standalone and a driver-based "beside" source in the harness; `test:contract:woocommerce-release-gate`. |
| `1833c7d` | The cases only WooCommerce has, in the same suite. |
| `f7e5fcf` | `scripts/test-e07-release-gate.ps1` and `test:gate:e07`. |
| `57abec2` | The live pilot script, `scripts/woocommerce-pilot-reconcile.sql` (run by the gate suite against the schema) and `scripts/woocommerce-pilot-probe.mjs`. |
| `03da34f` | One case of the WooCommerce connection contract aligned with `9161b3e` (below). Test only. |
| the commit that adds this file | This file, the story status and the epic table. |

Also on `develop` since US-07-05, by the product owner and not part of this story's work: `9161b3e`, which makes an **empty** pilot allow-list allow every organization while connect is on. This gate ran with it. It changes how one organization is paused; see [Operational notes](#operational-notes).

Frontend (`akeed-frontend`, branch `develop`):

| Commit | What |
| --- | --- |
| `52d02a4` | One defect fixed (below): `src/shared/auth/AuthGuard.tsx`, with a test. |
| `cfac6ee` | `wooCommerce.types.test.ts`: every one of the backend's 30 WooCommerce error codes reads in Arabic and in English. Test only. |

No migration, no new environment variable, no feature. This story's commits edit no Shopify, Standalone or EasyOrders production file; the two shared files they change are the log helper and the exception filter.

Not part of this story, and uncommitted when the gate ran: a refactor of the three store spokes by another work session. The last gate run includes it; see [Validation results](#validation-results-as-run-2026-10-05).

## Code review of US-07-02 to US-07-05

The gate started with a review of the four stories, as the E06 gate did. Ten findings came back; each was checked against the code and the contract record.

### Defects fixed

1. **A refused write after an accepted read left the connection's health at "ok".** `WooCommerceConnectionHealthService` compared each answer from the store with the connection row as it was loaded. In a re-enable whose read was accepted (health set to `ok`) and whose write was refused with `403`, the refusal was compared with the stale value and not written. Fix: the value just written is what the next answer is compared with. Test: `woocommerce-connection-health.service.spec.ts`, "records a refusal that follows an accepted read in the same request".
2. **A disconnect could leave a store update waiting for ever.** Waiting `commerce_outcome_syncs` rows were closed only after the store had been asked to delete the webhooks (up to 15 seconds), inside a log call, and never on a repeated disconnect. A request that died in that wait left rows `pending` whose job, if lost, nothing would run. Fix: they are closed right after the local disconnect, and again on a repeat. Tests: `woocommerce-auth.service.spec.ts`, the order of the calls and the repeated disconnect.
3. **A reconnect the merchant refused in the store was shown as "waiting".** A finished account that reconnects from Settings comes back from the store on the setup route, and `AuthGuard` sent it on to the store tab without the address's query, so the `success=0` hint was lost and the panel polled until the install expired. Fix: the query goes along. Source-neutral: nothing in it names a provider. Test: `AuthGuard.test.tsx`.

### A defect the gate suite found

4. **A failed database statement wrote its parameters to the log.** Drizzle reports a failed statement as `Failed query: <sql>` followed by `params: <values>`. `normalizeError` logged that message and its stack as they were, and Nest's default handler does the same for a failed query nobody caught. The secrets case of the new suite found, in the line the install callback logs when its transaction fails, the webhook token hash, the three ciphertexts and the store's path. The same path would log a phone or a name for any other table, for every source. Fix (`a9ffa76`): both now log the SQL text, which holds placeholders only, and the driver's code and message, and keep the stack frames. The `500` answer is unchanged. This is a shared change, in its own commit: the full unit suite was run before it (207 suites, 5598 tests) and after it (208 suites, 5603 tests), and the Shopify, Standalone and EasyOrders contracts after it, in the gate run below. They were not run immediately before it.

The EasyOrders gate did not find this because its install callback does not log the fault itself. It was exposed there too, through Nest's handler.

### Findings checked and left as they are

None of these was changed, because each is what the contract record says, or is not a defect. Three need the product owner's word.

| # | Finding | Why it was left | Proposed |
| --- | --- | --- | --- |
| a | An order whose first placed delivery the normalizer skips (a phone that does not parse, a missing currency) is never verified, even after the merchant fixes it in the store: the next delivery is routed as an update. | Record, section 4: "Akeed already has a create event" is true from the first accepted create delivery, and an update never starts a verification. Shopify and EasyOrders behave the same way. | **Decision needed.** Either accept it as a stated limit, or a small story: a create event the normalizer skipped does not count as "has a create event". It changes the record first. |
| b | The health read calls the store (two requests, up to 8 seconds) on every read, for any role, before the database summaries. | Record, section 3 and the US-07-05 amendment: the webhooks are read "when health is read". A check on a click costs about five store calls in all, bounded; there is no loop. | None for the pilot. If health reads grow, cache the last reading for a minute. |
| c | The restricted client connects only to the first resolved address. A dual-stack store whose first address is unreachable from Akeed's host is reported as unreachable. | Record, section 8, rule 6: no retry inside the client. Every resolved address is still checked. | Known limit. If the pilot's host has no IPv6 route, test one IPv6-enabled store early. |
| d | A WooCommerce order with a local phone and no billing country, or with no currency, is shown with the EasyOrders wording: "Choose it in the store connection settings". WooCommerce has no such setting. | Record, section 4 names these two reason codes on purpose, "so the frontend reason map already knows them". The codes are shared with EasyOrders. | **Decision needed.** Two WooCommerce-only reason codes with their own sentences (a record amendment and four message keys), or reword the two shared sentences. Both cases are rare: WooCommerce sends a currency with every order and asks for a billing country at checkout. |
| e | A store already connected to another organization is refused at the callback, after the merchant approved, which leaves a key in the store. | Record, support boundary table: `WOOCOMMERCE_STORE_UNAVAILABLE` is detected at the callback. Refusing at the start would tell any organization on the pilot list whether a given address is an Akeed customer, before it has shown it controls the store. | None. |
| f | `outcomeMarkers` in `woocommerce-delivery.ts` repeats `readWooCommerceOutcomeMarkers`, and `isRecord` is defined twice. | Not a defect: the two limits are equal today. | Tidy with the next WooCommerce change. |
| g | The WooCommerce and shared connect components import `Notice`, `Frame` and `Panel` from the EasyOrders skin by a relative path. | Not a defect in behavior, and lint passes. Moving them edits EasyOrders files. | **Decision needed.** A small refactor of its own, with the EasyOrders tests run before and after. |

## The conformance harness

`test/contracts/source-conformance-harness.ts` has three parts:

- **A world:** one PostgreSQL schema built from the Drizzle tables and the real migrations, the real repositories and services wired as the application binds them, and fakes only at the edges: the messaging port and the BullMQ queues, whose jobs are recorded and run in process. A source is added to it as a spoke: its outcome adapter, eligibility strategy, normalizer and update handler.
- **A driver, per source,** for everything a provider decides: connect, begin and finish an install, disconnect and reconnect, place and deliver an order, deliver the provider's echo of an outcome, what the store shows after an outcome, the request log, key revocation and fault injection, and the assertions only that provider can make.
- **The matrix,** which runs each case through the driver and asserts Akeed's side: events, orders, verifications, sends, usage and store updates. Tenant B and the other sources stand beside every case, and after every case tenant B's rows must be byte-for-byte what they were, its key unused and its order untouched at the store.

**EasyOrders asserts what it asserted before.** The suite has the same 29 tests with the same titles. The old file had 168 assertions; the harness, the EasyOrders driver and the gate spec together have 169 (one added). Each provider-specific assertion moved into the driver unchanged; the two cases only EasyOrders has (it looks an order up while ingesting it) stay in its gate spec. Nothing blocked a clean extraction.

One thing reads differently and asserts the same: where the old suite compared a status name at the fake (`pending`, `confirmed`, `canceled`), the matrix compares what the store shows in terms both sources share (`untouched`, `confirmed`, `cancelled`), and each driver maps its own states onto them strictly; anything else fails the case.

## Results per acceptance criterion

| AC | Result | Evidence |
| --- | --- | --- |
| 1. The provider-neutral part of the EasyOrders suite is a shared harness, in its own commit, with EasyOrders unchanged in behavior; WooCommerce runs through it | **Met.** | `b1d8b82` on its own; `test:contract:easyorders-release-gate` 29 of 29 before and after; `test:contract:woocommerce-release-gate` runs the same matrix. |
| 2. The shared adapter contract and the WooCommerce-specific cases pass | **Met**, against the fake. | `woocommerce-outcome.adapter.contract.spec.ts` (the shared contract, mapping and status fixtures); the gate suite's WooCommerce-only cases (table below); the connection, ingestion and outcome-sync contracts for the authorization callback, payload mapping, COD detection, API errors and throttling. |
| 3. Duplicates, replays, another tenant's token, secret, key or order, key revocation and outages cannot cross tenants or duplicate an effect; disconnect and reconnect keep history; no automatic no-reply cancellation | **Met** on Akeed's side. | The matrix (table below). |
| 4. A pilot organization completes the journey on a real store, and the run reconciles | **Not met. NOT RUN.** | The [pilot script](Epics/07-woocommerce-integration/evidence/US-07-06-live-pilot-script.md) is ready. |
| 5. The record's observations are VERIFIED from that run | **Not met. NOT RUN.** | Each observation has its step in the pilot script. |
| 6. Shopify, Standalone and EasyOrders regression gates pass, run as scripts with dev servers stopped; the localized screens are looked at by a person | **Gates: passed** in run 3, as scripts with the dev servers stopped. Run 1 failed in one WooCommerce case, which was out of date. The screens: **not done**, they are behind login. | [Validation results](#validation-results-as-run-2026-10-05); the pilot script's Part H for the screens. |
| 7. The product owner records a go/no-go decision | **Open.** | After the run. |

### The matrix, as WooCommerce runs it

All in `test/woocommerce-release-gate.contract-spec.ts`, on PostgreSQL, with real repositories and services. Beside every case: a second WooCommerce tenant, a Shopify source, a Standalone source and an EasyOrders store.

| Area | Case | What is asserted |
| --- | --- | --- |
| Journey | Confirm, and cancel | Connect with the store's pings answered `200`; one event, order, verification, send from the Akeed sender and usage unit; nothing asked of the store while ingesting; confirm writes the marker and one internal note and no status; cancel writes `cancelled` and the marker in one request; the echo is `skipped / reflected_outcome`; every count reconciled |
| Duplicates | Three concurrent deliveries, then a late changed one | One order, verification, send and usage unit; one create event and one update event; the total is not edited |
| Replay | The customer's reply three times; the echo twice | One store update row, one write |
| Replay | The install callback again, with another store's keys | `401`, the stored connection unchanged, the other keys never used |
| Cross-tenant | B's secret on A's address and the reverse; A's address with B's store as the source; B's signed delivery on A's address | `401` each, counted on the address it reached; nothing stored |
| Cross-tenant | A's store reporting an order id only B holds | Recorded for A and skipped; nothing for B changes |
| Cross-tenant | An outcome naming B's order or B's integration | Refused before any request; no retry queued |
| Wrong store | An order answer that links to another site | The customer's answer is kept; the update fails `store_unverified`; nothing is written |
| Revocation | A revoked key on a store update | One request, `failed`, needs the merchant, health `credentials_rejected`, no retry |
| Revocation | Disconnect, then reconnect the same store | Updates resume; the old key is never used after the disconnect |
| Throttling | `429` with `Retry-After` | Waits the named time, no attempt spent, then exactly one write |
| Throttling | `429` without `Retry-After` | The standard backoff; the store's other order and another store are not delayed |
| Outage | Queue down at webhook dispatch | `200` after the durable write; the recovery sweep dispatches; one order |
| Outage | Queue down when a retry is scheduled | A visible `retry_not_scheduled` failure; the merchant's retry writes once |
| Outage | The store answers `503` for every try | Five tries, then a visible failure; after a merchant retry each further try is queued and the update lands once |
| Fault | Install callback, the store unreachable while the keys are proven | `503`, nothing stored, no webhook at the store, the same link then connects |
| Fault | Install callback, the second webhook refused | `503`, the first webhook deleted again, nothing stored, the same link then connects |
| Fault | Install callback, the database write fails half-way | Everything rolled back, the same link then connects |
| Fault | Status write times out before it was taken | Read back, retried, written once, one note |
| Fault | Status write times out after it was taken | Read back, reported done, never written again |
| Disconnect | Disconnect and same-store reconnect | Every order, verification, event, usage row and store update kept; same integration id; the credentials wiped and the store's webhooks deleted; the old address `401`; a late reply stays local |
| No-reply | Reminder then escalation, with writes on and off | Zero requests to the store; the order untouched; the row `unsupported`; only the merchant's own cancel writes `cancelled`, and only with writes on |
| Pause | Connect switch off | No install and no callback accepted; a connected store still ingests and updates; Shopify, Standalone and EasyOrders each complete an order |
| Pause | All three switches off | Shopify, Standalone and EasyOrders give the same result as with them on; the WooCommerce address answers `404` and stores nothing |
| Secrets | Whole suite | No key, secret, token or token hash in a log line or an answer; none in clear in any stored row; the fixtures hold none |

### The cases only WooCommerce has

| Area | Case | What is asserted |
| --- | --- | --- |
| HMAC and source | Twelve wrong deliveries: a changed body, another secret, no, empty, malformed, truncated and hex signatures, no source, another store, plain HTTP, a wrong path, a value that is not an address | One answer for all of them (`401`, one code), each counted, nothing stored; the same bytes with the store's signature are taken |
| HMAC and source | The bytes as they arrived | An indented body with an escaped letter is taken with its own signature; the compact form with that signature is refused |
| HMAC and source | The store's address in any spelling | With and without a trailing slash, upper case, with `:443`, at a domain root and in a subdirectory: accepted. The site root for a subdirectory store, a longer path, another port, another host: refused |
| HMAC and source | The ping | `200` and nothing stored on an address Akeed issued, with ingestion on or off; `401` or `404` on any other |
| HMAC and source | The same order id in two stores | Two orders, two verifications; only the answered store is written, with its own key |
| Draft, then placed | A checkout draft, then the placed order on the other topic, then again | The draft is `skipped / order_not_placed`; one order, verification, send and usage unit; nothing asked of the store |
| Draft, then placed | A non-COD order and a held COD order | The first is recorded and never sent; the second is verified, and confirmed without a status change |
| Webhook state | A webhook the store disabled | Shown on a health read and as a setup blocker; re-enable refused with ingestion off and no store call; with it on, set active, confirmed by reading, the ping answered `200`; the next order is taken; the order placed meanwhile is never imported |
| Webhook state | Paused, and deleted at the store | Paused is shown and never overridden; deleted is `WOOCOMMERCE_WEBHOOK_MISSING` and a reconnect |
| SSRF | Seven paths (start probe, install callback, health read, connection check, webhook re-enable, outcome write, disconnect cleanup) against seven address answers (private, loopback, cloud metadata, carrier-grade NAT, IPv6 loopback, IPv4-mapped private, a public address beside a private one) | No request leaves for any of them; each path ends with its own code and changes nothing it should not: no install stored, health left as it was, the webhook still disabled, the customer's answer kept and the store order untouched, the disconnect completed |
| SSRF | The same seven paths against a redirect to a private address and to another public site | The store's `301` is never followed; the same codes |
| Reconciliation | `scripts/woocommerce-pilot-reconcile.sql` | It names no credential, stored payload or customer field; it runs read-only against the schema; after a confirmed and a cancelled order every "expect 0 rows" section is empty and nothing it prints is a secret, a ciphertext or customer data |

The address rule was also checked the other way round: with the rule weakened by hand (one public address made enough), the seven "public beside private" cases failed, one per path. The change was reverted.

## Validation results (as run, 2026-10-05)

`npm run test:gate:e07` was run three times as a script. One run carries the other gates: E07 runs the E06 gate, which runs the E05 gate, which runs the E04.5 contracts and the E04 gate, which runs the E03 and E02 gates. E01 has no script: its command set (`docs/E01-BASELINE-EVIDENCE.md`) is what the E02 gate runs. The dev servers (the backend watcher and the Shopify CLI frontend) were stopped for every run. ngrok and the local Redis container were left running; no step uses either.

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Backend | `57abec2`, the main checkout, clean | `03da34f`, a clean checkout of that commit (`git worktree`) | `03da34f` **with the uncommitted spoke refactor on top**, the main checkout (tree `1c8569c46d03d078b5e9cb1ec9e0e650adc1c426`) |
| Frontend | `cfac6ee`, clean | the same | `cfac6ee`, clean |
| Started, finished (UTC) | 09:13:26, 09:32:25 | 09:42:06, cut off at about 09:56 | 09:58:16, 10:13:06 |
| Result | **FAILED**: 1 of 67 steps | **No result** | **PASS**: 67 of 67 steps |
| Checkouts changed during the run | backend **yes** (see below), frontend no | not recorded | backend no, frontend no |
| Reports, in `.tmp/release-gates` | `e07-20261005T091326Z.json`, `e06-20261005T091515Z.json`, `e05-20261005T091654Z.json` | none | `e07-20261005T095816Z.json`, `e06-20261005T100035Z.json`, `e05-20261005T100218Z.json` |

**Why run 1 failed.** One case of `test/woocommerce-connection.contract-spec.ts` ("needs the connect switch and the pilot list, unlike the disconnect") emptied the pilot list and expected `WOOCOMMERCE_PILOT_REQUIRED`. Since `9161b3e` an empty list allows every organization, so the install was accepted: 1 failed, 167 passed. The code does what `9161b3e` says; the case was out of date. `03da34f` makes it use a list that names another organization. The suite was then run alone in a clean checkout of `57abec2` with that change: 168 of 168.

**What was edited under run 1.** While run 1 was finishing, another work session began a refactor in the main backend checkout. Its first file was written at 09:30:25 UTC. By the step durations in the E05 report, run 1's last backend step had ended about four seconds before that, and only the frontend unit suite and the frontend reuse map followed. Run 1's backend results are therefore from `57abec2` as committed, but only by that margin, and its report says, correctly, that the backend checkout changed during the run.

**Why run 2 has no result.** It was started from a clean checkout of `03da34f` to keep that refactor out, and was cut off when the session that started it ended, during the E02 gate's frontend steps. The 60 steps it had started by then showed the same counts as run 1, with the connection contract at 168 of 168. It wrote no report and is not counted.

**What run 3 covers.** By the time run 3 started the refactor was finished and still uncommitted, so run 3 was run on the main checkout as it stood: `03da34f` plus that refactor. The refactor is not part of this story. It was made at the product owner's request to make the three store spokes consistent: one shared install-token helper, the EasyOrders ingestion policy and credentials in their own files, the eligibility strategies exported by each spoke's module, the Shopify normalizer and guards moved into the Shopify spoke, the Shopify error codes in one file, and a spec that guards the spoke boundary. It moves and edits Shopify and EasyOrders files and specs; this story's own commits do not.

The content that was gated is the tree `1c8569c46d03d078b5e9cb1ec9e0e650adc1c426`, taken with `git add -A` into a throwaway index before the run and again after it, with the same result. When the refactor is committed, `git diff 1c8569c46d03 <commit> --stat` shows what the gate did not see; it should list documentation only. The tree object is unreferenced and will be pruned in time, so check soon.

**Not covered by any run:** no test boots `AppModule`, and the refactor changes module wiring (`app.module.ts`, `webhook-queue.module.ts`, `ShopifyCommerceModule`). The type check, the build and every suite pass, but the first real check of the wiring is the next start of the backend.

### The E07 gate's own steps

| Step | Command | Run 3 | Run 1 |
| --- | --- | --- | --- |
| E07: type check | `npx tsc --noEmit -p tsconfig.json` | PASS | the same |
| E07: structured-log contract | `npm run log:check` | PASS | the same |
| E07: WooCommerce spoke: shared adapter contract, fixtures and unit specs | `npx jest src/infrastructure/spokes/woocommerce` | PASS, 21 suites, 799 tests | **PASS, 21 suites, 811 tests** |
| E07: restricted outbound client, logging and the exception filter | `npx jest src/shared/http src/shared/logging src/shared/filters src/shared/config` | PASS, 13 suites, 279 tests | the same |
| E07: platform-neutral core and outcome retry | `npm run test:core:platform-neutral` | PASS, 13 suites, 179 tests | **PASS, 12 suites, 176 tests** |
| E07: onboarding, settings and source health | `npx jest src/modules/onboarding src/modules/verifications` | PASS, 15 suites, 247 tests | the same |
| E07: E07 release-gate contract (conformance matrix, HMAC and source, draft then placed, webhook re-enable, SSRF) | `npm run test:contract:woocommerce-release-gate` | PASS, 102 tests | the same |
| E07: WooCommerce connection contract | `npm run test:contract:woocommerce-connection` | PASS, 168 tests | **FAIL, 1 failed, 167 passed, 168 total** |
| E07: WooCommerce ingestion contract | `npm run test:contract:woocommerce-ingestion` | PASS, 72 tests | the same |
| E07: WooCommerce outcome-sync contract | `npm run test:contract:woocommerce-outcome-sync` | PASS, 68 tests | the same |
| E07: inherited E06 gate (EasyOrders, E05, E04, E03, E02, E01/Shopify, frontend) | `npm run test:gate:e06` | PASS | the same |

### The inherited E06 gate

| Step | Command | Run 3 | Run 1 |
| --- | --- | --- | --- |
| E06: type check | `npx tsc --noEmit -p tsconfig.json` | PASS | the same |
| E06: structured-log contract | `npm run log:check` | PASS | the same |
| E06: EasyOrders spoke: shared adapter contract, fixtures and unit specs | `npx jest src/infrastructure/spokes/easyorders` | PASS, 13 suites, 277 tests | **PASS, 12 suites, 266 tests** |
| E06: platform-neutral core and outcome retry | `npm run test:core:platform-neutral` | PASS, 13 suites, 179 tests | **PASS, 12 suites, 176 tests** |
| E06: onboarding, settings and source health | `npx jest src/modules/onboarding src/modules/verifications` | PASS, 15 suites, 247 tests | the same |
| E06: E06 release-gate contract (journey, isolation, replay, revocation, limits, outages, disconnect, no-reply) | `npm run test:contract:easyorders-release-gate` | PASS, 29 tests | the same |
| E06: EasyOrders connection contract | `npm run test:contract:easyorders-connection` | PASS, 59 tests | the same |
| E06: EasyOrders ingestion contract | `npm run test:contract:easyorders-ingestion` | PASS, 58 tests | the same |
| E06: EasyOrders outcome-sync contract | `npm run test:contract:easyorders-outcome-sync` | PASS, 33 tests | the same |
| E06: source-identity contract | `npm run test:contract:source-identity` | PASS, 1 test | the same |
| E06: standalone-provisioning contract | `npm run test:contract:standalone-provisioning` | PASS, 10 tests | the same |
| E06: inherited E05 gate (E04, E03, E02, E01/Shopify, frontend) | `npm run test:gate:e05` | PASS | the same |

### The inherited E05 gate, with the E04.5 contracts

| Step | Command | Run 3 | Run 1 |
| --- | --- | --- | --- |
| E05: type check | `npx tsc --noEmit -p tsconfig.json` | PASS | the same |
| E05: structured-log contract | `npm run log:check` | PASS | the same |
| E05: server API guide matches the tested examples | `npm run docs:order-api-guide:check` | PASS | the same |
| E05: ingestion core and architecture guards | `npx jest src/modules/order-ingestion` | PASS, 10 suites, 291 tests | the same |
| E05: manual, file-import, API and key channels | `npx jest src/modules/orders src/modules/order-imports src/modules/order-api src/modules/integration-keys` | PASS, 44 suites, 1630 tests | the same |
| E05: platform-neutral core | `npm run test:core:platform-neutral` | PASS, 13 suites, 179 tests | **PASS, 12 suites, 176 tests** |
| E05: E05 release-gate contract (equivalence, isolation, revocation, recovery, end to end) | `npm run test:contract:order-api-release-gate` | PASS, 24 tests | the same |
| E05: order API contracts (endpoint, idempotency, guide examples) | `npm run test:contract:order-api` | PASS, 3 suites, 61 tests | the same |
| E05: integration API keys contract | `npm run test:contract:integration-keys` | PASS, 11 tests | the same |
| E05: manual-order contract | `npm run test:contract:manual-orders` | PASS, 15 tests | the same |
| E05: order-imports contract | `npm run test:contract:order-imports` | PASS, 60 tests | the same |
| E05: order-import release-gate contract | `npm run test:contract:order-import-release-gate` | PASS, 21 tests | the same |
| E05: entitlement contract | `npm run test:contract:entitlements` | PASS, 7 tests | the same |
| E05: shopify contract | `npm run test:contract:shopify` | PASS, 11 tests | the same |
| E05: E04.5 credit and billing contracts | `powershell scripts/test-e045-contracts.ps1` | PASS | the same |
| E04.5: US-04.5-01 migration, RLS, immutability and concurrency | in `scripts/test-e045-contracts.ps1` | PASS, 40 tests | the same |
| E04.5: US-04.5-09 signup auto-activation, backfill and one-time grant | in `scripts/test-e045-contracts.ps1` | PASS, 10 tests | the same |
| E04.5: US-04.5-03 usage accounting and recovery | in `scripts/test-e045-contracts.ps1` | PASS, 22 tests | the same |
| E04.5: US-04.5-04 Paymob checkout, callback and inquiry | in `scripts/test-e045-contracts.ps1` | PASS, 29 tests | the same |
| E04.5: US-04.5-06 staff operations, debt and repair | in `scripts/test-e045-contracts.ps1` | PASS, 38 tests | the same |
| E04.5: US-04.5-07 reconciliation, monitoring and finance metrics | in `scripts/test-e045-contracts.ps1` | PASS, 31 tests | the same |
| E05: E04 acceptance and inherited E03/E02/Shopify gates | `powershell scripts/test-e045-inherited-gates.ps1` | PASS | the same |
| E05: frontend unit suite (API keys tab, localized errors, server API guide) | `npm run test` | PASS, 104 files, 1268 tests | the same |
| E05: frontend reuse map | `npm run check:reuse-map` | PASS | the same |

### The inherited E04, E03 and E02 gates (E01 and Shopify)

The scripts of these gates print no summary and stop at their first failing step, so a step is shown as passed because the script went on to its end and the E05 step that carries it passed.

| Step | Command | Run 3 | Run 1 |
| --- | --- | --- | --- |
| E04: composed Standalone manual MVP acceptance | in `npm run test:gate:e04` | PASS, 6 tests | the same |
| E04: manual-order PostgreSQL contract | in `npm run test:gate:e04` | PASS, 15 tests | the same |
| E04: inherited E03 and E02 release gates | in `npm run test:gate:e04` | PASS | the same |
| E03: E02 compatibility gate | in `npm run test:gate:e03` | PASS | the same |
| E02: core without Shopify services | in `npm run test:gate:e02` | PASS, 13 suites, 179 tests | **PASS, 12 suites, 176 tests** |
| E02: reusable adapter contract and Shopify-specific expectations | in `npm run test:gate:e02` | PASS, 26 tests | the same |
| E02: full backend regression | in `npm run test:gate:e02` | PASS, 212 suites, 5632 tests | **PASS, 208 suites, 5603 tests** |
| E02: platform migration rehearsal | in `npm run test:gate:e02` | PASS, 4 tests | the same |
| E02: Shopify PostgreSQL characterization and queue recovery | in `npm run test:gate:e02` | PASS, 11 tests | the same |
| E02: source identity and disconnect retention | in `npm run test:gate:e02` | PASS, 1 test | the same |
| E02: backend build | in `npm run test:gate:e02` | PASS | the same |
| E02: backend non-fixing lint | in `npm run test:gate:e02` | PASS, 0 errors, 20 warnings | the same |
| E02: frontend route type generation | in `npm run test:gate:e02` | PASS | the same |
| E02: frontend application typecheck | in `npm run test:gate:e02` | PASS | the same |
| E02: frontend dual-mode fixture typecheck | in `npm run test:gate:e02` | PASS | the same |
| E02: frontend non-fixing lint | in `npm run test:gate:e02` | PASS, 0 errors, 4 warnings | the same |
| E02: frontend isolated production build | in `npm run test:gate:e02` | PASS | the same |
| E03: backend structured-log contract | in `npm run test:gate:e03` | PASS | the same |
| E03: tenant and role guards | in `npm run test:gate:e03` | PASS, 6 suites, 107 tests | the same |
| E03: Standalone provisioning and primary-source concurrency | in `npm run test:gate:e03` | PASS, 10 tests | the same |

The backend and frontend lint warnings were there before this story. Every count that differs from run 1 is in a suite the refactor touched: it moved the install-token cases out of the two spokes into a shared spec and added four specs. The counts were not reconciled test by test.

### How the gates and suites the story names map onto the run

| Named by the story | Run as | Result in run 3 |
| --- | --- | --- |
| E07 | `npm run test:gate:e07` | **PASS**: 67 of 67 steps |
| E06 | `npm run test:gate:e06`, by the E07 script | PASS |
| E05 | `npm run test:gate:e05`, by the E06 script | PASS |
| E04 | `npm run test:gate:e04`, by the E05 script | PASS |
| E01 | No script. Its command set is the E02 gate's steps: the full backend suite, build, non-fixing lint, the Shopify contract, the frontend type check, the smoke fixture type check, lint and an isolated production build | PASS. The browser smoke run was not run |
| The full backend suite | `npm test -- --runInBand`, in the E02 gate | PASS, 212 suites, 5632 tests |
| The full frontend suite | `vitest run`, in the E05 gate | PASS, 104 files, 1268 tests |

### Not run

- **The live pilot**, and `scripts/woocommerce-pilot-probe.mjs` against a store.
- **Any browser check:** `npm run smoke:e01`, the Playwright suite `npm run e2e:order-imports`, and any screen looked at by a person, in either language or mode.
- `npm run test:gate:e045` and `npm run test:gate:e046` as scripts. The story does not name them; the E05 gate runs the E04.5 contracts.
- `npm run test:e2e` in the backend.
- Anything against a real store, Meta, Shopify, Paymob, Redis or a shared or deployed database. The queues are in-process fakes.
- The other sources' contracts immediately **before** the shared logging change `a9ffa76`. The full unit suite was run before and after it; the contracts were run after it, in runs 1 and 3.
- A start of the backend with the refactored module wiring.
- A run that finished on a clean checkout of `03da34f` alone (run 2 was cut off).

## Open items and known limits

- **The live pilot is NOT RUN**, so acceptance criteria 4, 5 and 7 are open and all eight observations of the contract record are still unverified.
- **The spoke refactor in the main checkout is uncommitted**, and its module wiring has not been started once. The last gate run passed with it; the record is tied to it by a tree hash, not by a commit. Start the backend once before the pilot.
- **No screen was looked at by a person.** The rendering tests and the locale tests pass; that shows the strings exist in both languages, not that a screen reads well in Arabic. Part H of the pilot script is the check.
- **Three review findings need a decision** (a, d and g above).
- **Finding 5.3 cannot be observed by the pilot as written:** Akeed never repeats the marker write on a healthy run, and the probe does not write. It stays UNKNOWN with its worst-case rule unless a write test is asked for.
- **The fake is Akeed's reading of the contract record.** A real store that behaves differently is exactly what the pilot is for.
- **The queues are faked.** BullMQ against Redis (delays, the duplicate-id rule the fake copies) was not exercised.
- **The Shopify outcome adapter in the gate suite is a recorder:** the suite proves Shopify outcomes go to the Shopify adapter and never to WooCommerce, not what the adapter then does. That is covered by the unedited Shopify specs and contract.
- **The Standalone source beside the suite** takes its order through the queue with a manual-order envelope, not through the HTTP endpoints. Those are covered by the E04, E04.6 and E05 gates, which ran.
- **The probe (`woocommerce-pilot-probe.mjs`) was never run against a store.** It was run against an in-process stand-in to check what it prints.
- Carried from the earlier stories and not changed here: a `pending` store update whose process died has no sweeper (US-06-04 item 5); the pilot entitlement is the Starter plan, not credits.

## Operational notes

- **Switches, in the order to turn them on for a store:** `WOOCOMMERCE_CONNECT_ENABLED` (with `WOOCOMMERCE_PUBLIC_API_BASE_URL`, `WOOCOMMERCE_APP_BASE_URL` and, on the frontend, `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED`), check health, `WOOCOMMERCE_INGESTION_ENABLED`, then `WOOCOMMERCE_OUTCOME_SYNC_ENABLED`. Off in the reverse order. No order may be placed on a connected store while ingestion is off: each is answered `404` and the fifth disables the webhooks.
- **The pilot list after `9161b3e`:** an empty `WOOCOMMERCE_PILOT_ORG_IDS` allows every organization. To stop one organization, remove its id **and keep at least one other id in the list**; removing the last id opens connect to everyone. To stop all new connections, turn the connect switch off.
- **Logs:** a database fault now reads `Failed query: <sql>` and `cause: <code> <message>`, without the statement's parameters.
- The full switch table, the pause procedure and the go/no-go recommendation belong to `US-07-06-release-gate.md`, after the run.
