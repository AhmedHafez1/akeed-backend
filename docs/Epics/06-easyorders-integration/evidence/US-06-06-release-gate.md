# US-06-06 — EasyOrders release gate evidence

- **Story:** [US-06-06 — Qualify the EasyOrders adapter for pilot release](../US-06-06-easyorders-contract-and-pilot-release-gate.md)
- **Date:** 2026-10-03
- **State:** Automated gate run. **Live pilot NOT RUN.** US-06-01 go-live verification still owed.
- **Recommendation:** **No-go** for a pilot merchant today. See [Go / no-go](#go--no-go). The decision is the product owner's.
- **Source of truth for EasyOrders behavior:** the [US-06-01 contract record](US-06-01-contract-record.md).

## What this gate is, and is not

It proves Akeed's side: the adapter contracts, the journey against a provider fake, tenant isolation, replay and fault recovery, disconnect and reconnect, and that Shopify and Standalone are unchanged. Every provider behavior in it comes from the contract record; where the record says UNKNOWN the fake uses the record's worst-case rule.

It does not prove EasyOrders. No request was made to EasyOrders or Meta, no WhatsApp message was sent, and no shared database was touched. The fixtures are still "documented, not captured". Acceptance criterion 1 asks for an authorized pilot store, and that part is the [live pilot script](US-06-06-live-pilot-script.md), which has not been run.

Decision carried from the product owner (2026-10-03, this session): build the gate now, run the pilot later, and keep the story blocked until the pilot and the owed US-06-01 verification are reconciled.

## What changed

Backend (`akeed-backend`, branch `develop`):

| Commit | What |
| --- | --- |
| `6b1c0ff` | Two defects fixed (below), with regression tests. |
| `a8c99f3` | `test/contracts/easyorders-provider-fake.ts`; `easyorders-outcome.adapter.contract.spec.ts`; `test/easyorders-release-gate.contract-spec.ts` with its Jest config and runner; `scripts/test-e06-release-gate.ps1`; `test:contract:easyorders-release-gate` and `test:gate:e06`. |
| the commit that adds this file | This file, the pilot script, `scripts/easyorders-pilot-reconcile.sql`, the story status and the epic table. |

Frontend (`akeed-frontend`, branch `develop`):

| Commit | What |
| --- | --- |
| `26ed798` | `easyOrders.types.test.ts`: every error code the connect screen names has an Arabic and an English message, the two locales hold the same EasyOrders keys, and any other code falls back to the localized default. No production code changed. |

No migration, no new environment variable, no feature. Shopify source and specs were not edited.

### Defects found and fixed

Both were found by a code review of US-06-02 to US-06-05 at the start of this gate.

1. **A store update could wait forever after a merchant retry.** The retry job id was `outcome-sync-<syncId>-<attempts>-<deferrals>`. A merchant retry rewinds both counters, so the next failed try rebuilt the id of a job that had already completed; BullMQ treats that `add` as a no-op and does not throw, so the row stayed `pending` with no job and no retry button. Fix: the id also carries the try's due time (`commerce-outcome-sync.producer.ts`, `commerce-outcome-sync-tracker.service.ts`). Scheduling the same retry twice still adds one job. Tests: `commerce-outcome-sync.producer.spec.ts`; gate suite "a provider outage ends in a bounded, visible failure, and every try after a merchant retry is queued".
2. **Starting an install during an install callback could answer 500.** `createPendingInstall` locks the organization and then the open install contexts; `connect` locks them the other way round. PostgreSQL aborts one side with `40P01`, and only `connect` was retried. Fix: `createPendingInstall` runs inside `withSerializableRetry` (`easyorders-connections.repository.ts`). Test: connection contract "a new install started while a callback holds the open context is retried past the deadlock" (the test takes the one second PostgreSQL waits before it detects the deadlock, which shows the deadlock really happens).

No defect was found by the new gate suite itself. Its first runs failed on the suite's own expectations, not on product behavior.

### One wording difference between the record and the code

Section 4 of the contract record says `payment_method === "cod"` → `codStatus: 'cod'`. The normalizer does not set `codStatus`; it passes `paymentMethod` and `paymentSignals`, and the EasyOrders eligibility strategy decides on `paymentMethod`. The result is the one the record asks for (only `cod` is eligible, and the mapping is in the spoke), so nothing was changed. The record's wording should be corrected when it is next updated.

## Results per acceptance criterion

| AC | Result | Evidence |
| --- | --- | --- |
| 1. An authorized pilot store installs, ingests a COD order, sends through Akeed, receives a customer outcome and applies the approved EasyOrders status | **Not met.** Proven against the provider fake only. The live run is NOT RUN. | Gate suite "AC1 journey" (confirm and cancel): real install flow, unverified store proven by the first order with its own key, one send from the Akeed sender, the reply, the status at the fake, the echo ignored, and counts reconciled (events, orders, verifications, sends, usage, store updates, remote writes). Live: [pilot script](US-06-06-live-pilot-script.md) Part C. |
| 2. Shared adapter contracts plus EasyOrders-specific authentication and mapping fixtures all pass | **Met**, with the limit that the fixtures are documented shapes, not captures. | `easyorders-outcome.adapter.contract.spec.ts`: `defineCommerceOutcomeAdapterContract` for EasyOrders (the same contract Shopify runs), the mapping fixtures (each approved action, the status fixture as the confirm transition, unsupported actions, writes off, normalization and COD eligibility of the order fixture, the lookup of an incomplete order) and the authentication fixtures (revoked key, another store's key, cross-store read fails closed, inactive store). |
| 3. Duplicate or replayed webhooks, wrong-store credentials, key revocation, rate limits and queue or provider outages cannot cross tenants or duplicate business effects | **Met** on Akeed's side. The provider side of cross-tenant behavior is UNKNOWN (record section 6). | Gate suite "AC3 ..." and "fault injection" (table below). After every case the suite asserts that tenant B's orders, verifications, events, usage, sends and store updates are byte-for-byte what they were, that tenant B's key was never used, and that tenant B's order at the fake is untouched. |
| 4. Disconnect and reconnect preserve history, and no automatic no_reply cancellation occurs | **Met** on Akeed's side. | Gate suite "AC4 disconnect and reconnect" (rows compared before the disconnect, after it and after the same-store reconnect; same integration id; old address `401`; a late reply stays local) and "AC4 no automatic no-reply cancellation" (reminder then escalation, with remote writes on and off: zero requests to the fake, the order still `pending`, the row `unsupported`; only the merchant's own cancel writes `canceled`, and only with writes on). |
| 5. E01, E04 and E05 regression gates pass, and unresolved US-06-01 questions block release | Regression: see [Validation results](#validation-results-as-run-2026-10-03). Blocking: **release is blocked**; the open questions are listed [below](#open-us-06-01-questions). | The gate scripts were not run as scripts; their steps were run one by one. |

### The security, status and idempotency matrix

All in `test/easyorders-release-gate.contract-spec.ts`, on PostgreSQL, with real repositories and services. Fakes: the provider, the messaging port and the BullMQ queues.

| Area | Case | What is asserted |
| --- | --- | --- |
| Duplicates | Three concurrent deliveries of one order, then a late changed redelivery | One event, order, verification, send and usage unit; the redelivery is not an edit |
| Replay | The customer's reply three times; the status webhook twice | One store update row, one remote write; the echo is `skipped / reflected_outcome` |
| Replay | The install callback again, with another key | `401`, stored credentials unchanged, the other key never used |
| Wrong store | A's address with B's order; B's secret on A's address and the reverse; a status event for B's order on A's address | `403`, `401`, `401`, recorded and skipped; nothing for B changes |
| Wrong store | An outcome naming B's order or B's integration | Refused before any request; no retry queued |
| Wrong store | A key that answers for a different store | The customer's answer is kept; the update fails with `store_mismatch`; nothing is written |
| Revocation | A revoked key on a store update | One request, `failed`, `requires_assistance`, health `credentials_rejected`, no retry |
| Revocation | A revoked key on an order lookup | The event is closed `source_credentials_rejected`; no order, send or usage |
| Revocation | Disconnect, then reconnect the same store with a new key | Updates resume; the old key is never used again |
| Rate limit | `429` with `Retry-After` on the write | Waits the named time, no attempt spent, then exactly one applied write |
| Rate limit | `429` without `Retry-After` | That store pauses until the next minute (at most 70 s); its other order makes no request; another store is not delayed |
| Outage | Queue down at webhook dispatch | `200` after the durable write; a redelivery is a duplicate; the recovery sweep dispatches once; one order |
| Outage | Queue down when a retry is scheduled | A visible `retry_not_scheduled` failure; the merchant's retry writes once |
| Outage | Provider `5xx` for every try | Five tries, then a visible failure; after a merchant retry each further try is queued (defect 1) and the update lands once |
| Fault | Install callback, provider unreachable | `503`, nothing stored, the same link then connects |
| Fault | Install callback, database write fails half-way | Everything rolled back, the same link then connects |
| Fault | Status write times out before it was taken | Read back, retried, written once |
| Fault | Status write times out after it was taken | Read back, reported done, never written again |
| Fault | `429` on the order lookup | The event is released, not failed; the order arrives once |
| Pause | Connect switch off | No install and no callback accepted; a connected store still ingests and updates; a Shopify order is processed |
| Pause | All three switches off | Shopify gives the same result as with them on; the EasyOrders address answers `404` and stores nothing |
| Secrets | Whole suite | No key, token, secret or token hash in a log line or a response; none in clear in any stored row; the fixtures hold none |

## Validation results (as run, 2026-10-03)

Code under test: backend `a8c99f3`, frontend `26ed798`, both on `develop`. Run from 19:37 to 19:51 UTC on 2026-10-03 on the local Windows machine, each PostgreSQL contract on its own disposable `postgres:17-alpine` container. During the run the backend worktree held only the three uncommitted documentation files of this story; the frontend worktree was clean.

**The gate scripts were not run as scripts.** `npm run test:gate:e06` and the `test:gate:e05` it calls were not executed, because dev servers were running (ports 3001, 3458 and 9230): the inherited E02 gate runs `nest build`, which deletes `dist`, and a frontend build inside `.next`. Their steps were run one by one instead, with both builds redirected. What that leaves unproven: `nest build` itself, `next typegen`, the scripts' own wiring (including the new `scripts/test-e06-release-gate.ps1`, which has never been executed), and the gate's check that the worktrees are unchanged.

Backend (`akeed-backend`):

| Step | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit -p tsconfig.json` | PASS |
| Structured logs | `npm run log:check` | PASS, 0 violations |
| Full unit suite | `npx jest` | PASS, 183 suites, 4667 tests |
| Lint, whole tree, non-fixing | `npx eslint "{src,apps,libs,test}/**/*.ts"` | PASS, 0 errors, 20 warnings (the existing baseline) |
| Build | `npx tsc -p tsconfig.build.json --outDir .tmp/us-06-06-build` | PASS. Used instead of `npm run build`. |
| Platform-neutral core | `npm run test:core:platform-neutral` | PASS, 12 suites, 176 tests |
| Server API guide | `npm run docs:order-api-guide:check` | PASS |
| **E06 release-gate contract** | `test:contract:easyorders-release-gate` | PASS, 29 tests |
| EasyOrders connection contract | `test:contract:easyorders-connection` | PASS, 59 tests |
| EasyOrders ingestion contract | `test:contract:easyorders-ingestion` | PASS, 58 tests |
| EasyOrders outcome-sync contract | `test:contract:easyorders-outcome-sync` | PASS, 33 tests |
| Shopify contract (E01) | `test:contract:shopify` | PASS, 11 tests |
| Platform-boundary migration contract (E02) | `scripts/test-platform-boundary-migration-contract.ps1` | PASS, 4 tests, run on 2026-10-04 at the same commit. In the main run it reported NOT RUN: the runner gave it `E01_TEST_DATABASE_URL`, and this suite reads `E02_GATE_TEST_DATABASE_URL` through its own script. A mistake in the runner, not in the code. |
| Source-identity contract (E02) | `test:contract:source-identity` | PASS, 1 test |
| Standalone-provisioning contract (E03) | `test:contract:standalone-provisioning` | PASS, 10 tests |
| E04 manual MVP acceptance | `test:acceptance:e04` | PASS, 6 tests |
| Manual-order contract (E04) | `test:contract:manual-orders` | PASS, 15 tests |
| Entitlement contract | `test:contract:entitlements` | PASS, 7 tests |
| Order-imports contract | `test:contract:order-imports` | PASS, 60 tests |
| Order-import release-gate contract | `test:contract:order-import-release-gate` | PASS, 21 tests |
| E05 release-gate contract | `test:contract:order-api-release-gate` | PASS, 24 tests |
| Order API contracts (E05) | `test:contract:order-api` | PASS, 3 suites, 61 tests |
| Integration API keys contract (E05) | `test:contract:integration-keys` | PASS, 11 tests |
| Verification-overview contract | `test:contract:verification-overview` | PASS, 14 tests |
| E04.5 credit and billing contracts | `scripts/test-e045-contracts.ps1` | PASS: 40, 10, 22, 29, 38 and 31 tests |

The EasyOrders spoke's unit specs, including the new adapter contract spec (17 tests), are part of the full unit suite. `npx prettier --check --end-of-line crlf` and `npx eslint` passed on every file this story touched.

Frontend (`akeed-frontend`):

| Step | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit` | PASS |
| Dual-mode fixture type check | `npm run smoke:e02:typecheck` | PASS |
| Lint | `npm run lint` | PASS, 0 errors, 4 warnings that were already there |
| Unit suite | `npm run test` | PASS, 96 files, 1017 tests |
| Reuse map | `npm run check:reuse-map` | PASS |
| Production build | `NEXT_DIST_DIR=.next-us0606 npx next build` | PASS. `tsconfig.json` was restored and the output directory removed afterwards. |

How the regression gates named by the story map onto this run:

| Gate | Its steps | Covered here by |
| --- | --- | --- |
| E01 (no script; the command set in `docs/E01-BASELINE-EVIDENCE.md`) | Type check, build, whole-tree lint, unit suite, Shopify contract, smoke fixture | All run, with the build redirected. The browser smoke run (`npm run smoke:e01`) was **not** run. |
| E04 (`test:gate:e04`) | E04 acceptance, manual-order contract, then the E03 and E02 gates | All their steps run individually; `nest build` and `next typegen` not run. |
| E05 (`test:gate:e05`) | The order-API suites, the shared-rule contracts, E04.5 contracts, the inherited gates, frontend unit suite and reuse map | All their steps run individually. |

Shopify: no Shopify source file or spec was edited (`git diff 423c656..a8c99f3 --stat` touches only `commerce-outcomes`, the EasyOrders repository and spoke, `test/`, `scripts/` and `package.json`).

Not run:

- `npm run test:gate:e06`, `test:gate:e05`, `test:gate:e04`, `test:gate:e03`, `test:gate:e02` as scripts; `nest build`; `next typegen`.
- Any browser check, including `npm run smoke:e01`.
- Anything against EasyOrders, Meta, Paymob, Shopify, Redis or a shared or deployed database.
- The retry worker and the webhook queue against a real Redis.

## Live pilot

**NOT RUN.** The [pilot script](US-06-06-live-pilot-script.md) is ready. Its Part A is the US-06-01 verification the contract record still owes, and must come first.

| Item to reconcile from the run | Result |
| --- | --- |
| Accepted events against EasyOrders orders | NOT RUN |
| Orders and verifications, one each per event | NOT RUN |
| Sends, all from the Akeed sender | NOT RUN |
| Usage units against accepted sends | NOT RUN |
| Store updates against the status EasyOrders shows | NOT RUN |
| Real API responses (order read, status write), secrets removed | NOT RUN |
| Side effects of `confirmed` and `canceled` in EasyOrders | NOT RUN |
| No automatic no-reply cancellation on a real order | NOT RUN |
| Disconnect and reconnect on the real store | NOT RUN |

## Localized walkthrough and the two existing modes

| Check | Result |
| --- | --- |
| Setup, health, revoked, disconnected and error states in Arabic and English | Automated only: the existing Vitest suites render them with the real message files (`EasyOrdersConnectPage.test.tsx`, `EasyOrdersSourcePanel.test.tsx`, `useEasyOrdersSetupFlow.test.tsx`, `SourceHealthCard.test.tsx`, `sourceSkins.test.ts`), plus the new parity test. |
| Error codes | The connect screen names ten codes; each has an Arabic and an English message. Codes that only EasyOrders or a webhook caller receives fall back to the localized default. No missing string was found. |
| Shopify embedded and Standalone still build and type-check | `npm run smoke:e02:typecheck`, the frontend unit suite and the production build (results above). This shows they compile and their tests pass, not that a person saw them work. |
| Looking at the screens in a browser | **Not done.** Every changed screen is behind login, and the agent has no browser session. The checklist is Part E of the pilot script: 14 rows, each in Arabic/RTL and English, light and dark, including the Shopify embedded app and an existing Standalone account. |

## Support runbook

The disconnect, removal, reconnect, escalation and rollback procedures are in the [US-06-05 runbook](US-06-05-disconnect-and-support-runbook.md) and are not repeated here. This section adds what the pilot needs.

### Switches

| Switch | Off means | Safe to turn off while stores are connected? |
| --- | --- | --- |
| `EASYORDERS_CONNECT_ENABLED` (+ `EASYORDERS_PILOT_ORG_IDS`) | No install, no callback, no reconnect. History, health and disconnect still work. | Yes |
| `EASYORDERS_INGESTION_ENABLED` | Both webhook addresses answer `404`. Orders placed meanwhile are not imported later. | Yes, but orders are lost for the duration |
| `EASYORDERS_OUTCOME_SYNC_ENABLED` | Nothing is read from or written to EasyOrders. Customer answers stay in Akeed and show as not sent to the store. | Yes |
| `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED` (frontend) | Signup has no source picker. | Yes |

Order of enabling for a store: connect, check health, then ingestion, then outcome sync. Order of disabling: the reverse.

### Pausing new connections without touching Shopify

1. Set `EASYORDERS_CONNECT_ENABLED=false` on the backend and restart. Or, to stop one organization only, remove it from `EASYORDERS_PILOT_ORG_IDS`.
2. Unset `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED` on the frontend and redeploy, so signup stops offering EasyOrders. Do the backend first: an account that picked EasyOrders while the backend is off sees `EASYORDERS_CONNECT_UNAVAILABLE` and waits.
3. What stops: `POST /api/easyorders/install` and the install callback answer `404 EASYORDERS_CONNECT_UNAVAILABLE`, including a callback on a link opened before the switch. A disconnected store cannot reconnect.
4. What keeps running: connected EasyOrders stores (ingestion and store updates have their own switches), their history, health and disconnect; every Shopify webhook, queue, send and outcome; every Standalone path.
5. Why Shopify is untouched: the switch is read in two places only: the EasyOrders spoke, and organization signup, where it decides whether a new account may be created without a source. It is not read by the webhook queue, the hub, the registry or any Shopify code. Proof: gate suite "pausing EasyOrders without touching Shopify" (a Shopify order goes from webhook to a confirmed outcome at its own adapter with the switch off, and gives an identical result with all three switches on and all three off), and the unedited Shopify specs and contract.
6. To confirm after the change: a Shopify store's next order shows `"action":"webhook-ingest"` and a send as usual; `GET /api/easyorders/connection` for a connected store still answers.

### Symptoms during the pilot

| Symptom | Read | Likely cause and action |
| --- | --- | --- |
| Install ends in "EasyOrders did not accept the API key" on an active store | Log `easyorders-install-callback`, `lastErrorCode` on the connect screen | The fail-closed probe: a valid key reading an unknown order did not answer `2xx`. This is the open question in pilot script Part A. Stop; do not retry in a loop, each try leaves a key and two webhooks at EasyOrders. |
| Connected, but no order arrives | `GET /api/settings/source-health`; `easyorders_connections.rejected_deliveries` | Refused deliveries rising: a wrong or missing secret, or a duplicate Akeed webhook in EasyOrders. None at all: ingestion switch off, the store had no order, or EasyOrders sent nothing (record section 3: inactive store or dashboard-created order). |
| Order arrives, no message | `webhook_events.last_error` | `onboarding_incomplete`, `missing_currency`, a non-COD or unparsable phone (`skipped`), or the entitlement. |
| Customer answered, EasyOrders unchanged | `commerce_outcome_syncs` for the order: `state`, `error_code`, `provider_status` | `unsupported`: writes are off. `remote_state_conflict`: the store had already moved the order. `store_unverified` or `remote_state_unreadable`: the order response is not the shape Akeed expects (Part A). `source_credentials_rejected`: disconnect and reconnect. `failed` with `source_unavailable` or `retry_not_scheduled`: the merchant's Retry on the row. |
| A store update stays "waiting" | `next_attempt_at`, and the retry queue in Redis | Before `6b1c0ff` this was defect 1. After it: a process that died between the write and the result leaves a `pending` row with no job (US-06-04 open item 5); there is no sweeper yet. Fail it by hand only with the product owner's say. |
| An order was canceled in EasyOrders that nobody canceled | `commerce_outcome_syncs.action` for the order | Akeed writes `canceled` only for `customer_cancellation` and `merchant_no_reply_cancellation`. `scripts/easyorders-pilot-reconcile.sql` section 10 must be empty. If Akeed has no such row, the change was made in EasyOrders. |
| Rate limiting | Log `easyorders-outcome-sync` with `source_rate_limited` or `source_rate_budget_exhausted` | Expected under load: 30 requests a minute per store, counted in memory per API instance. More than one instance multiplies the budget; run one instance for the pilot. |

### Reconciliation

`scripts/easyorders-pilot-reconcile.sql` is read-only, takes the organization id, and selects no credential, token hash, payload, phone, name or address. Its "expect 0 rows" sections are the invariants: no event left waiting, one event and one verification per order, no order held twice, no automatic no-reply written as a cancellation, no local result that disagrees with what EasyOrders confirmed, no row attached to another organization.

## Open US-06-01 questions

Each one blocks release. They are the contract record's go-live table; none was closed by this gate.

| # | Question | Record | Blocks | Closed by (pilot script Part A) |
| --- | --- | --- | --- | --- |
| 1 | The callback POST: headers, body fields, whether it carries a webhook secret; redirect and cancel behavior | §1, §2, §7 | Connect; the "seller copies the secrets" step | Steps 1, 4 |
| 2 | What a valid key answers for an order id that does not exist (the install probe accepts only `2xx` or the inactive-store `400`) | §2; US-06-02 open item 1 | Connect: an active store may be refused | Step 5 (`get-order`) |
| 3 | A real order webhook: headers, the `secret` header, the payload; a captured fixture; storefront versus dashboard orders | §2, §3 | Ingestion | Step 5 |
| 4 | Retries after `5xx` and timeout, duplicates, ordering | §3 | Ingestion (a lost event is recovered only if EasyOrders retries) | Step 6 |
| 5 | A real status webhook on a token URL, and after the token is rotated; whether EasyOrders keeps calling a URL that answers `401` | §6 | Ingestion; disconnect guidance | Step 7 |
| 6 | The answers to a wrong, missing or revoked key, and how fast revocation takes effect; the call that proves a key's store | §2 | Credential health; store ownership | Step 8 |
| 7 | The shape of `GET orders/:id` and of the status write's answer | §5; US-06-04 open item 2 | Outcome sync: every write fails closed if the shape differs | Steps 5, 10 |
| 8 | Transitions from `pending`; the side effects of `confirmed` and `canceled` (notifications, stock, shipping, refunds); whether an API change echoes as a status webhook | §5 | Outcome sync, and the product owner's acceptance of the effects | Step 10 |
| 9 | The first `429`: scope (key, store, app or IP), window, headers, body; whether incoming webhooks are affected | §8 | Outcome sync; more than one merchant if the limit is per IP | Step 11 |
| 10 | Uninstall behavior; `delete-by-url` with `Api-Key` and with `Bearer`; whether a secret can be regenerated | §6, §7 | Cleanup guidance | Step 12 |
| 11 | A key cannot read another store's order; one store's events never reach another store's URL | §2, §6 | Tenant isolation on the provider side | Steps 7, 8 on a second store |
| 12 | Whether two keys share one rate limit | §8 | The per-integration budget | Step 11 with a second key |

Also open, from the earlier stories, and not changed by this gate: US-06-01 itself is not Done (captured fixtures, most test requirements); the entitlement is the Starter plan, not credits (US-06-02 item 4); the rate budget is in memory per instance (US-06-04 item 3); a `pending` store update whose process died has no sweeper (US-06-04 item 5); webhooks are not removed at EasyOrders on disconnect (US-06-05 decision).

## Known limits of this gate

- The provider fake is Akeed's reading of the contract record. A real EasyOrders that behaves differently is exactly what the pilot is for.
- The fake answers `200 {}` for a valid key on an unknown order, which is what lets an install succeed in the suite. That answer is assumption 2 above, not a finding.
- The queues are faked: jobs are recorded and run in process. BullMQ's own behavior against Redis (delays, the duplicate-id rule the fake copies) was not exercised.
- The Shopify outcome adapter in the gate suite is a recorder: the suite proves that Shopify outcomes are routed to the Shopify adapter and never to EasyOrders, not what the Shopify adapter then does. That is covered by the unedited Shopify specs and contract, which pass.
- The release-gate scripts `test:gate:e06` and `test:gate:e05` were not run as scripts (see results).

## Go / no-go

**Recommendation: no-go for connecting a pilot merchant now. Go for running the pilot script, Part A first.**

For:

- Akeed's side holds under the full matrix, with two tenants and a Shopify source beside it.
- The two defects that would have hurt a pilot (a store update stuck forever; a 500 on a second Connect click) are fixed.
- New connections can be paused without touching Shopify, and each of connect, ingestion and store updates has its own switch.
- Regression is green: every step of the E01, E04 and E05 gates passed when run individually, with Shopify code and specs unedited.

Against:

- Acceptance criterion 1 is not met: no real store has been through the journey.
- Twelve provider questions are open, and by the story's own rule any one of them blocks release. Two of them (questions 2 and 7) can make the pilot fail at its first step.
- The side effects of `confirmed` and `canceled` in EasyOrders are unknown and need the product owner's acceptance before a real merchant's customers are affected.
- The localized screens have not been looked at by a person.

What turns this into a go: Part A run on an active store (and a second store for questions 11 and 12), the contract record updated with no blocking UNKNOWN, any contradiction fixed in its own story, Parts B to E run and reconciled into the "Live pilot" table above, and the side effects accepted.
