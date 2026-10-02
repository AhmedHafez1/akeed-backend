# US-05-06 API release gate evidence

**Validated:** 2026-10-02
**Revision:** backend `develop` @ `c799dbb` plus this story's working tree (uncommitted); frontend `develop` @ `0e86641`, unchanged by this story. No migration.
**Decision:** Done. The gate passes locally, and on 2026-10-02 the product owner tested the API and reported it working as expected (see Pilot result). The story and the epic are closed.

## The gate's question

*Does adding the API leave the existing ingestion architecture intact, and is the API safe to pilot?*

- **Intact: yes.** One order sent through the manual form, a file import and the API produces the same stored order, verification, dispatch ledger, credit movement, follow-up jobs and dashboard rows at every stage of its life. The API and a file import also produce the same canonical order and fingerprint. Only `ingestionType`, the import's two envelope extras and the manual form's own identity scheme differ. The architecture specs now fail if the API module reaches the database, a queue or a provider by itself, or if any file outside four named ones mentions `ingestionType`.
- **Safe to pilot: yes locally, with three defects found and fixed here** (below) and eight decisions handed to the product owner in the checklist, since closed. During the gate nothing was deployed, no live endpoint was called and no WhatsApp message was sent.

## Defects the gate uncovered

| # | Defect | Found by | Owning story | Outcome |
| --- | --- | --- | --- | --- |
| 1 | **One store's rate limit corrupted the others'.** Every order-API bucket (per address, per integration, global) used one throttler name. `@nestjs/throttler` 6.5.0's in-memory storage keeps its expiry timers per name and cancels all of them when any key of that name leaves its block. From then on the other integrations' counts and the global count never expired, so well-behaved stores got false `429`s and the global bucket eventually refused everyone for a minute. | Code review, then a failing unit test | US-05-04 | **Fixed.** Each bucket is its own throttler name (`order-api-throttle.guard.ts`). New test: *keeps counting each bucket on its own clock when another bucket leaves its block*. |
| 2 | **A retry of a stored order was refused when the store had become unready.** `submitOne` checked readiness before looking for the request. A response lost on the store's last credit was retried into `409 INSUFFICIENT_CREDITS`, which the guide describes as "nothing is stored", for an order that had been accepted and sent. The same held for automatic verification switched off, a used-up plan and a missing entitlement, and for the manual form. No duplicate order or message was possible; the answer was wrong. | Code review, then a failing gate test | US-05-02 (`submitOne`), against the US-05-03 lost-response guarantee | **Fixed in the core**, so the manual form inherits it. An unready source now refuses new orders only: `submitOne` asks `ManualOrderIngestionRepository.isKnown` before refusing, and a known request goes on to `acceptOne`, which replays or answers a conflict and creates nothing. A ready source makes no extra read. |
| 3 | **A stale test in the E04.6 gate.** `order-import-release-gate.contract-spec.ts` › *two batches with overlapping references* has failed since commit `8aacbe9` made an upload replace the uploader's own earlier draft; the test drafted both batches as one user. It is recorded as a known failure in the US-05-01 to US-05-05 evidence. | Regression baseline | US-04.6-10 | **Test fixed**, no product change: the second batch is uploaded by a colleague of the same store, which is the case the test is about. The suite is 21 of 21 again. |

Defect 2 changes one manual-form answer on purpose: a retry (same `Idempotency-Key`) of a manual order that was already created now answers that order with `duplicate: true` even if the store has since run out of credit, instead of the readiness error. No existing expectation had to change: `orders.service.spec.ts`, `test:contract:manual-orders` and `test:acceptance:e04` pass as they were. Three unit specs fake the acceptance repository and were given the new `isKnown` method; no assertion in them was edited.

### Found and not fixed (handed over)

- **Request bodies are read before authentication and before any rate limit** (code review; US-05-04). A request with no key and invalid JSON or an oversized body answers `400`/`413` without being counted by the pre-auth limit, and a throttled client's body is still read (at most 32 KB) before its `429`. This is the documented order ("413 before authentication") and bounded per request; changing it is a design decision.
- **The throttler behavior of defect 1 also exists outside E05.** `OrderImportUploadThrottleGuard` (E04.6) shares one name across users, and the app-wide `ThrottlerGuard` shares the library's `default` name across addresses. One caller leaving a block freezes the others' counts until they are blocked once themselves. Not touched here: E04.6 is released and the app-wide guard needs a storage decision (the Redis storage deferred in the E05 README would also remove it).
- **No kill switch and no pilot gating** for the order API. Rollback is key revocation (per store, or all keys by SQL) or a redeploy. See decisions D1 and D2 in the checklist.
- The gaps already recorded in the US-05-03, US-05-04 and US-05-05 evidence (no test mode, phones need a country code, no `trust proxy`, in-memory counters, `express` not a direct dependency, the 404 body under `/api/v1`) are unchanged.

## What was built

- **`test/order-api-release-gate.contract-spec.ts`** (24 tests, `npm run test:contract:order-api-release-gate`, wrapper `scripts/test-order-api-release-gate-contract.ps1`). The order API is mounted as `main.ts` mounts it (edge, three guards, route pipe, controller, adapter) and called over HTTP with `supertest`, in front of the real ingestion command, repositories, queue worker, hub, send service, credit ledger and WhatsApp webhook service over PostgreSQL. Keys are issued and revoked through `IntegrationKeysService`, as Settings does. Only the messaging port and the queues are fakes (`releaseGateHarness`); each fault case breaks one boundary.
- **`test/contracts/order-api-app.ts`**: the test app, the key migration and the request helper, shared with `order-api-guide.contract-spec.ts` (which lost its own copy and is otherwise unchanged).
- **Architecture specs extended** (no new spec file): see AC2 below.
- **`scripts/test-e05-release-gate.ps1`** (`npm run test:gate:e05`): 18 steps, each PostgreSQL contract on its own disposable container; every step runs even after a failure; a JSON report goes to `.tmp/release-gates/e05-<timestamp>.json`.
- **[Pilot checklist](Epics/05-standalone-order-ingestion-api/US-05-06-pilot-checklist.md)**: preparation, a 22-step synthetic-order script, a read-only reconciliation query, support and recovery by error code, rollback, blocking rules and open decisions.
- Core and edge fixes for defects 1 and 2; `SYSTEM-DESIGN.md` §4.4 records the changed gate order.

## Acceptance criteria

| # | Criterion | Proven by |
| --- | --- | --- |
| 1 | Cross-channel equivalence | Gate suite › *AC1 equivalence* (4 tests). Three identical stores, one per channel, the same order. A snapshot of the stored order, the event status, the verification, the dispatch ledger, the messages, the credit balance, ledger and reservations, the follow-up jobs, the dashboard projection and the Verifications list row is taken after the send and after each later step, and the import and API snapshots must equal the manual one. Lives covered: customer confirms, customer cancels, and no reply (reminder, then no-reply). A fourth test compares the stored envelopes key by key. Unit level: `channel-equivalence.spec.ts` (US-05-02), unchanged. |
| 2 | Architecture guards | `reuse-map.spec.ts`: `CHANNELS` includes `modules/order-api/`; the COD rule covers the API; two new rows (one `ref:<key>` normalizer, one key-prefix table). `ingestion-boundary.spec.ts`: the API module imports nothing from `infrastructure/`, the queues, billing, outcomes or the other channels except `DatabaseModule` in its module file; it never holds; the key module touches only its own repository; only the key and API modules and the principal's type name a key id or prefix. `release-gate-architecture.spec.ts`: `ingestionType` (and the channel list) is mentioned in exactly four production files; nothing outside `app.module.ts` and `main.ts` imports the API or key modules. |
| 3 | Tenant isolation | Gate suite › *AC3 tenant isolation* (6 tests): credentials (a key writes only into its organization; the other organization cannot list or revoke it; the database refuses a key pointed at another organization's store), idempotency responses and external-ID replays (the same key and order id with different content in two organizations are two orders, each replays its own, and a conflict names nothing of the other's), orders (list, dashboard projection, retry), usage (credit refusal and rate limit of one do not touch the other), errors (one envelope, no tenant identifier in any refusal, a revoked key reads like a wrong one). |
| 4 | Revocation | Gate suite › *AC4 revocation* (4 tests): after `revoke` the replay of an accepted order, a new order and a burst all answer `401` at once and store nothing; the accepted order is still sent, confirmed and shown; the key stays listed as revoked with its last use; the stored order and event name no credential; a new key replays the order under the old `Idempotency-Key`; with the store switched off or its automatic verification disabled before the worker runs, the order ends exactly like a manual order in the same store state. |
| 5 | Fault recovery | Gate suite › *AC5 fault recovery* (9 tests): concurrent duplicates under one key and under different keys; conflicting payloads under one key and under different keys; database outage for the whole request; database outage at the acceptance transaction; response lost after commit; response lost on the store's last credit; queue outage after commit, recovered by the sweep with no client retry. `expectReconciled` counts orders, events, verifications, dispatch rows, credit reservations, messages and the balance after each, and checks every row links to a row of the same organization. |
| 6 | End to end | `order-api-guide.contract-spec.ts`: all 17 documented examples plus the reference-table checks (24 tests, unchanged). Gate suite › *AC6 end to end*: an API order over HTTP, one message through the fake messaging port, the customer's Confirm through the WhatsApp webhook service, then `confirmed` in the Verifications list and the dashboard projection. |
| 7 | No regressions | The table under Validation results. |

## What the gate measured

Behaviors observed while writing the suite. None is a defect; each is now pinned by a test or stated in the checklist.

- **A provider-accepted message spends its credit at once.** After a send the balance is one lower and nothing is left held; the reservation row remains as the record.
- **A retry inside the dispatch back-off is another 503.** After `503 API_ORDER_DISPATCH_FAILED` the event waits three seconds or more before it can be claimed again; a retry before that answers the same code and stores nothing. The sweep, or a later retry, queues it. The sweep runs only with `WEBHOOK_RECONCILIATION_ENABLED=true`, which is `false` in `.env.example` (checklist step 1.4).
- **A database outage while the key is being checked answers `500 API_INTERNAL_ERROR`**, not 503, with the fixed retry message and no driver text. An outage at the acceptance write answers `503 API_ORDER_ACCEPTANCE_FAILED`.
- **The Verifications list returns `total_price` without trailing zeros** (`1250.5` for `1250.50`), for every channel. The stored order keeps `1250.50`.
- **The database itself refuses a key that points at another organization's integration** (composite foreign key), independently of the resolver's check.

## The checks fail when they should

Each change was made, observed and reverted with `git checkout`:

| Change | What failed |
| --- | --- |
| A function in `verification-hub.service.ts` comparing `ingestionType` to `'api'` | 4 tests in `release-gate-architecture.spec.ts`, including the new four-file rule |
| `api-order.channel-adapter.ts` importing `WebhookEventsRepository` | 2 tests in `ingestion-boundary.spec.ts`, including the new reach rule |
| The key guard no longer refusing revoked keys | Gate suite: *refuses the key at once* and *errors: … a bad key reads the same* |
| The API adapter upper-casing the customer name | Gate suite: all 4 equivalence tests |
| Defect 1 before its fix | `order-api-throttle.guard.spec.ts`: the new test, `allowed: false` on the second request |
| Defect 2 before its fix | Gate suite: *response lost on the last credit*, `Expected: 202, Received: 409` |

## Validation results

Contract suites ran on disposable `postgres:17-alpine` containers, never the app database. "Before" is clean `develop` @ `c799dbb`; "after" is the final `npm run test:gate:e05` run (`.tmp/release-gates/e05-20261002T162350Z.json`), all 18 steps PASS.

| Command | Before | After |
| --- | --- | --- |
| `npx jest` (full backend unit suite) | PASS — 161 suites, 4268 tests | PASS — 161 suites, 4279 tests (inside the E02 gate) |
| `npx jest src/modules/order-ingestion` | within the full run | PASS — 10 suites, 291 tests |
| `npx jest src/modules/orders src/modules/order-imports src/modules/order-api src/modules/integration-keys` | within the full run | PASS — 44 suites, 1630 tests |
| `npm run test:core:platform-neutral` | within the full run | PASS — 9 suites, 144 tests |
| `npm run test:contract:order-api-release-gate` (new) | — | PASS — 24 |
| `npm run test:contract:order-api` | PASS — 3 suites, 61 tests | PASS — 3 suites, 61 tests |
| `npm run test:contract:integration-keys` | PASS — 11 | PASS — 11 |
| `npm run test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `npm run test:contract:order-imports` | PASS — 60 | PASS — 60 |
| `npm run test:contract:order-import-release-gate` | 20 passed, **1 failed** (defect 3) | PASS — 21 |
| `npm run test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `npm run test:contract:shopify` | PASS — 11 | PASS — 11 |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS — 6 suites, 170 tests | PASS — 6 suites, 170 tests |
| `npm run test:contract:source-identity` | PASS — 1 | PASS — 1 (inside the E02 gate) |
| `scripts/test-e045-inherited-gates.ps1`: E04 acceptance and manual contract, then the E03 and E02 gates (full backend regression, platform migration, Shopify and source-identity contracts, backend build, non-fixing lint, tenant and role guards, Standalone provisioning contract, frontend route types, typecheck, dual-mode fixture typecheck, lint and isolated production build) | not run before | PASS — E04 acceptance 6, manual contract 15, adapter contract 26, platform migration 4, Shopify 11, source identity 1, tenant and role guards 107 (6 suites), provisioning 10; backend lint 0 errors (20 existing warnings) |
| `npm run docs:order-api-guide:check` | — | PASS |
| `npx tsc --noEmit -p tsconfig.json`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |
| `npx eslint` and `prettier --check --end-of-line crlf` on the touched files | — | PASS — 0 errors |
| Frontend `npm run test` (Vitest) | — | PASS — 81 files, 781 tests |
| Frontend `npm run check:reuse-map` | — | PASS — 4 of 4 rules |
| Frontend `npx tsc --noEmit`, `npm run smoke:e02:typecheck`, `npm run lint`, isolated `npm run build` (inside the E02 gate) | — | PASS — 0 errors (4 existing lint warnings) |

The gate was run twice in full. The first run (`e05-20261002T155847Z.json`) passed all 18 steps before defects 1 and 2 were found by the code review; the table shows the second run, after their fixes.

**Expectations changed.** None in the regression suites, apart from the stale test of defect 3. `order-api-guide.contract-spec.ts` was moved onto the shared test app and gained one assertion (the documented path).

## Frontend

No frontend file changed. What the story's frontend note asks for is covered as follows, and the rest is in the hand-off:

- **Key lifecycle and localized errors:** `ApiKeysTab.test.tsx` (list, create with one-time reveal, revoke with confirmation, viewer read-only, every key-management error present in Arabic and English, the uncoded 429 copy) passes inside the Vitest run.
- **API-created order visibility:** the Standalone UI never reads the channel or the external order id, and the gate proves the Verifications list row of an API order equals the row of the same manual and imported order, field for field. An API order is therefore rendered by the code that already renders manual and imported orders.
- **Both modes:** the dual-mode fixture typecheck, lint and isolated production build pass inside the E02 gate.

## Pilot result

- **Reported by the product owner, 2026-10-02:** the API was tested and works as expected.
- **What is on record:** that report. The per-step observations of the [checklist](Epics/05-standalone-order-ingestion-api/US-05-06-pilot-checklist.md) (status, code and correlation ID for steps 2.1 to 2.22, and the section 3 reconciliation counts) were not handed back and are not in this repository. The environment, build commits and stores used are not recorded here either.
- **Open points:** closed. Decisions D2 and D7 applied to the pilot and closed with it. D1, D3, D4, D5, D6 and D8, and the throttler behavior outside E05, are accepted for the current single-instance deployment and moved to *Deferred (post-pilot)* in the E05 README. None blocks the release.

## Not verified by the gate

- **Nothing was looked at in a browser.** This session had no browser tool. Layout, dark mode, RTL and phone width of Settings → API keys, Verifications and the two guide pages are step 2.22 of the pilot checklist.
- **The application was not booted** against a real database and Redis. The API is mounted in tests the way `main.ts` mounts it, and BullMQ is replaced by an in-process queue.
- **No live provider.** Meta, Shopify and Paymob were not called. The messaging port is a fake that accepts or rejects.
- **Throttling across restarts and instances** (in-memory counters) and behavior behind a proxy (`trust proxy`) were not exercised.
- **The pilot** was not run by the gate. It was run by the product owner afterwards; see Pilot result.

## Rollout and recovery

- No migration. The backend change is the two fixes above; the rest is tests, scripts and documents.
- Rollback of the fixes is reverting the commit. Defect 2's fix writes nothing, so no stored data needs repair either way.
- Stopping the API without removing it, keeping every accepted order: checklist section 5.
- The gate is complete, so E08 may reuse the ingestion boundary.
