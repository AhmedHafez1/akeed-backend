# US-05-05 server integration guide evidence

**Validated:** 2026-10-02
**Revision:** backend and frontend working trees on `develop` (uncommitted). No migration, no change to any file under `src/` in the backend.
**Decision:** implemented locally. The release stays blocked until US-05-06 (gate and pilot).

## What was built

- **The guide.** `akeed-frontend/content/docs/en/server-api.md` (`/en/docs/server-api`), structured like `bulk-order-import.md`: overview, before you start, quick start, order fields, what "accepted" means, sending an order twice, limits, examples, error codes, getting help, FAQ. A short Arabic overview for the merchant at `content/docs/ar/server-api.md` links to the English guide. Both `standalone-platform.md` pages point to it.
- **One fixture.** `test/fixtures/order-api/guide-examples.json` holds 17 examples, 11 fields, 19 error codes, the request limits and the currency list.
- **The contract suite.** `test/order-api-guide.contract-spec.ts`, added to `test/jest-order-api-contract.json`, so `npm run test:contract:order-api` and `scripts/test-order-api-contract.ps1` run it. The test instance is the order API mounted as `main.ts` mounts it (`applyOrderApiEdge`, the three guards, the route pipe, the controller and the adapter) in front of the real ingestion command, repositories and worker over PostgreSQL. Requests go over HTTP with `supertest`. The key is generated for the test, stored through `IntegrationApiKeysRepository.createWithinCap` and dropped with the schema. Only the messaging port and the queues are fakes, as in the other suites that use `releaseGateHarness`.
- **The generator and drift check.** `scripts/order-api-guide.js` renders the guide's `Field reference`, `Limits`, `Examples` and `Error Codes` sections from the fixture (`npm run docs:order-api-guide`). With `--check` it fails when those sections differ, when a code block in the hand-written part is not one of the tested examples, or when the guide names an error code the fixture does not have. `scripts/test-order-api-contract.ps1` runs the check before the tests.
- **Discoverability.** Settings → API keys ends with the endpoint address (`<NEXT_PUBLIC_API_URL>/api/v1/orders`, copyable) and a link to `/{locale}/docs/server-api` that opens in a new tab. Both are shown to viewers. Copy is in `ar.json` and `en.json` under `settings.standalone.page.apiKeys.connect`.

### Decided during planning

The production API host is not known to the repository, so the guide uses the placeholders `$AKEED_API_URL` and `$AKEED_API_KEY`, and the API keys tab shows the real address of the environment it runs in.

### Frontend changes beside the guide

- `MarkdownContent` renders `pre` with `dir="ltr"`, so a code block reads left to right on an Arabic page.
- The copy-to-clipboard logic that `StoreTab` and `CreateApiKeyDialog` each carried is now `features/settings/domain/useCopyToClipboard.ts`, used by both and by the new `ApiConnectionGuide`. Their existing tests pass unchanged.
- `shared/lib/auth.ts` exports `getApiBaseUrl()`; `features/settings/api/integrationKeysApi.ts` exports `getOrderApiEndpoint()`.

## What the examples found

Nothing in the API had to change. Three behaviors were not written down anywhere and are now documented and tested:

- **The first `202` has no `verificationId`.** The confirmation does not exist until the worker has run, so the field appears on a later replay and never for a non-COD order.
- **A phone without `+` and a country code is rejected.** The API passes no country to `PhoneService.standardize`, so `01001234567` answers 400 with `fieldErrors.customerPhone`. File import reads the same number with the store's country. The guide says to send international format.
- **`#10023` and `10023` are one order but not identical data.** `orderNumber` defaults to `externalOrderId` as written, so the second spelling under a new key answers 409 `API_ORDER_EXTERNAL_ID_CONFLICT` unless `orderNumber` is sent. This is now the example `order-id-written-differently`, and the guide tells integrators to write the id the same way every time.

## Acceptance criteria

| # | Criterion | Where it is met |
| --- | --- | --- |
| 1 | Location | The two `server-api.md` files; `server-api-guide.test.ts` checks slug, order and the Arabic link to `/en/docs/server-api`. |
| 2 | Quick start | Guide › Quick Start. Its `curl` block and response are the `create-order` example; the drift check refuses any other block. |
| 3 | Contract | Guide › Order Fields, What "accepted" Means, Before You Start (one store per key, server-only key, `/api/v1`). |
| 4 | Idempotency | Guide › Sending an Order Twice. |
| 5 | Examples | Guide › Examples, generated from the fixture: `curl` requests, raw HTTP responses, and the first request also as raw HTTP. |
| 6 | Troubleshooting | Guide › Error Codes (by `code`), Limits, Getting Help (correlation ID). It links Order Confirmation for the lifecycle. `server-api-guide.test.ts` asserts the guide names no path but `/api/v1/orders` and no `GET`. |
| 7 | Proven | `test/order-api-guide.contract-spec.ts`, 24 tests. |
| 8 | Discoverable | `ApiConnectionGuide.tsx` in the API keys tab; `ApiKeysTab.test.tsx`. |

## Each guide statement and the test behind it

| Statement in the guide | Proven by |
| --- | --- |
| Success, replay, lost-response retry, both 409 conflicts, non-COD, invalid phone, missing key header, invalid API key, 413, 429 with `Retry-After`, automatic confirmation off, setup incomplete, store unavailable, out of credits | One fixture example each, run by `order-api-guide.contract-spec.ts`: status, body key for key, message, headers, and the number of WhatsApp messages the example leads to (0 or 1) |
| 60 requests a minute per store, 32 KB body | The suite runs with `parseOrderApiConfig({})` and asserts those defaults equal the fixture. `rate-limited` really sends 60 requests first; `payload-too-large` hits the real limit |
| Required fields, unknown fields rejected | A request without each required field, and one with an extra field, answer 400 with that field in `fieldErrors` |
| Field length limits | Each text field is refused one character over its documented length and accepted at it |
| `Idempotency-Key` of 8 to 128 characters | 7 and 129 characters answer 400; 8 and 128 answer 202 |
| Supported currencies | The fixture list equals `CANONICAL_ORDER_CURRENCIES` |
| Error codes with no example (`API_INTERNAL_ERROR`, `API_ORDER_ACCEPTANCE_FAILED`, `API_ORDER_DISPATCH_FAILED`, `API_ENTITLEMENT_REQUIRED`, `API_PLAN_LIMIT_REACHED`, `API_REQUEST_REJECTED`, three credit codes) | The fixture names the suite in `provenBy`; the contract suite checks that the file exists and contains the code |
| A held, released or stopped import keeps its state; identical is strict (extras, `IMP-…` number); JSON key order does not matter; a key survives API-key rotation | `test/order-api-idempotency.contract-spec.ts` (US-05-03), unchanged |
| A key in the URL is refused; one answer for every bad key; a safe `X-Correlation-Id` is echoed | `src/modules/order-api/order-api.http.spec.ts` (US-05-01, US-05-04), unchanged |

## Validation results

| Check | Before (clean `develop`) | After |
| --- | --- | --- |
| `npx jest src/modules/order-ingestion` | PASS — 10 suites, 281 tests | PASS — 10 suites, 281 tests |
| `npx jest src/modules/orders src/modules/order-imports src/modules/order-api` | PASS — 40 suites, 1563 tests | PASS — 40 suites, 1563 tests |
| Full backend `npx jest` | 161 suites, 4268 tests (US-05-04 evidence) | PASS — 161 suites, 4268 tests on the third run (see the two flaky tests below) |
| `npm run test:core:platform-neutral` | — | PASS — 9 suites, 144 tests |
| `test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `test:contract:order-imports` | PASS — 60 | PASS — 60 |
| `test:contract:order-import-release-gate` | 20 passed, **1 failed** | 20 passed, **1 failed** (same test) |
| `test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `test:contract:shopify` | PASS — 11 | PASS — 11 |
| `test:contract:order-api` | PASS — 2 suites, 37 tests | PASS — 3 suites, 61 tests |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS — 6 suites, 170 tests | PASS — 6 suites, 170 tests |
| `scripts/test-order-api-contract.ps1` (drift check, then the suites) | — | PASS — guide check, then 3 suites, 61 tests |
| `npx tsc --noEmit -p tsconfig.json`, `npx eslint test/order-api-guide.contract-spec.ts`, `prettier --check --end-of-line crlf <touched>`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |
| Frontend `npx tsc --noEmit`, `npm run lint` | — | PASS — 0 errors (4 existing unused-variable warnings) |
| Frontend `npx vitest run src/features/settings src/features/docs` | 17 files, 256 tests in settings (US-05-04 evidence) | PASS — 20 files, 276 tests |
| Frontend `npm run test` | — | PASS — 81 files, 781 tests |

Contract suites ran on disposable `postgres:17-alpine` containers, never the app database.

**Pre-existing failure, not fixed here.** `order-import-release-gate.contract-spec.ts` › *AC4 … two batches with overlapping references* fails identically before and after. It is recorded in the US-05-01 to US-05-04 evidence.

**The checks fail when they should.** Each change below was made, observed and reverted:

- Fixture: status 409 changed to 422, a message reworded, the per-store limit changed to 100. The contract suite failed 4 tests (`Expected: 422, Received: 409`, the message, the limit, the error table), and the drift check failed on the limits table.
- Guide, generated section: a status in the error table edited by hand. The drift check failed at that line.
- Guide, hand-written section: the quick-start body changed to a numeric `totalPrice`, and an unknown code `API_ORDER_NOT_FOUND` added. The drift check reported both.

**Expectations changed.** None. `ApiKeysTab.test.tsx` and `MarkdownContent.test.tsx` gained tests. One existing spec was edited to remove a flake, described next.

**Two flaky unit tests seen in the full `npx jest` runs.** Neither is caused by this story; each failed once in three full runs.

- `order-api.http.spec.ts` › *replaces a short value instead of echoing it* asserted that the response headers never contain the rejected value `abc`. The generated correlation UUID is hex and contained `abc` in one run (`…a94abc151d41`), which happens about once in 150 runs. **Fixed here:** the rejected value is now `xyz`, which a hex UUID cannot contain. The assertion is unchanged.
- `parse-import-file.timing.spec.ts` › *parses a 5,000 × 20 XLSX in under 1 s* measured 1,082 ms while the machine was busy, and passes alone and in the next full run. **Not changed:** it is a wall-clock budget owned by E04.6.

## Not verified

- **The pages were not viewed in a browser.** No dev server was running and this session had no browser tool. `ServerApiGuide.test.tsx` renders both pages through the real `MarkdownContent` and checks every code block, the callouts, the tables and every in-page link, but layout, dark mode, RTL and phone width still need a look at `/en/docs/server-api`, `/ar/docs/server-api` and Settings → API keys.
- **The address shown in the API keys tab** is `NEXT_PUBLIC_API_URL`. Confirm it is the public API host in each deployed environment before an integrator copies it.
- `scripts/order-api-guide.js` is not linted: the ESLint project service does not include `scripts/*.js`, as for the other scripts there.
- The application was not booted against a real database and Redis in this story.

## Known gaps handed to US-05-06

- **There is no test mode.** The guide says so: an accepted COD order sends a real message and uses a credit. A sandbox key is a product decision, not part of this epic.
- **The API reads phones without the store's country**, unlike file import. If integrators send local numbers, passing the store's country in the API adapter is a small core-neutral change, but it alters which requests are accepted and needs a decision.
- **The drift check needs both repositories side by side.** A backend-only CI checkout must set `ORDER_API_GUIDE_FRONTEND_ROOT` or skip the check; the contract suite itself has no such dependency.
- The gaps listed in the US-05-04 evidence (no `trust proxy`, in-memory counters, 404 body under `/api/v1`) are unchanged and are stated to integrators only where they affect them (the limits).

## Rollout and recovery

- No migration and no backend runtime change. Publishing is deploying the frontend.
- Publish with the API pilot. To withdraw the guide, remove the two `server-api.md` files and the `ApiConnectionGuide` row; nothing else depends on them.
- A breaking change to the contract gets a new version path and a new guide, not edited examples.
