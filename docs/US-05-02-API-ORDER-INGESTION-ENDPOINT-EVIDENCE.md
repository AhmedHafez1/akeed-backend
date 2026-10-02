# US-05-02 API order ingestion endpoint evidence

**Validated:** 2026-10-02
**Revision:** backend working tree on `develop` (uncommitted). No frontend change.
**Decision:** implemented locally. The release is blocked: US-05-03 (replay semantics) and US-05-04 (throttle, body limit, error envelope) are required before any external use.

## Implemented behavior

### Part A — core (`src/modules/order-ingestion/`)

- **`StandaloneSourceResolver.resolveForIntegration(orgId, integrationId, codes)`.** It runs the same checks as `resolveWritable` through one shared private method: exactly one active source, owned by the organization, Standalone, onboarding completed. It also requires that source to be `integrationId`; a key of a replaced source gets 409 `sourceUnavailable`. There is no role check, and the code map type (`StandaloneIntegrationSourceCodeMap`) has no `roleRequired` entry.
- **Shared readiness gate** (`standalone-readiness-gate.ts`). `StandaloneReadinessCodeMap` holds the per-channel vocabulary (`entitlementRequired`, `autoVerifyDisabled`, `planLimitReached`, `setupIncomplete`). `assertSendReady(blockers, codes)` is the body of the former `assertManualCreateReady`, moved with the same precedence, messages and key order: entitlement → auto-verify → credit (E04.5 code as `code` and `reason`) → slot / plan limit → fail closed.
- **`StandaloneOrderIngestionService.submitOne(principal, input, options)`.** Resolve (session user → `resolveWritable`; integration principal → `resolveForIntegration`) → `StandaloneSendReadinessService.evaluate(source, { required: 1 })` → `assertSendReady` → `acceptOne`. Both principals end in the same `StandaloneIngestionContext`; `keyId` and `prefix` never reach the acceptance input. The service now takes `StandaloneSendReadinessService` in its constructor.
- **Manual moved onto it.** `OrdersService.createManualOrder` keeps role check → Idempotency-Key → phone, then calls `submitOne` with `MANUAL_ORDER_SOURCE_CODES` and `MANUAL_ORDER_READINESS_CODES`. `assertManualCreateReady` is deleted.
- **Channel metadata.** `'api'` is appended to `STANDALONE_INGESTION_CHANNELS`, `IDEMPOTENCY_KEY_PREFIX` (`'api:'`) and `LOG_ACTION_PREFIX` (`'api-order'`). The normalizer, the eligibility strategies and `verification-core` are unchanged.
- **Shared rules for the import extras** (`canonical-order.rules.ts`): `CANONICAL_EXTRA_TEXT_MAX_LENGTH` (1,000, the file import's cell cap) and `isCanonicalOrderDate` (`YYYY-MM-DD`, a real calendar day: the form a file import stores).

### Part B — API channel (`src/modules/order-api/`)

Four files: controller, request DTO, channel adapter, module.

- **`POST /api/v1/orders`**, `IntegrationApiKeyGuard`, answers 202 `{orderId, verificationId?, status: 'accepted', duplicate}`. The body is declared `object` with a route pipe (`expectedType`, `whitelist`, `forbidNonWhitelisted`), so validation answers 400 `API_VALIDATION_FAILED` with `fieldErrors` behind the global pipe.
- **`CreateApiOrderDto`.** Required `externalOrderId`, `customerName`, `customerPhone`, `totalPrice`, `currency`, `paymentMethod`; optional `orderNumber`, `orderDate`, `city`, `address`, `notes`. Every limit, pattern, list and normalizer is read from `canonical-order.rules.ts`. Unknown fields, including `orgId`, `integrationId` and `platform`, are rejected.
- **`ApiOrderChannelAdapter`.** `toCanonicalOrderInput`: `externalOrderId` → `normalizeOrderReference` (`ref:<normalized>`), `orderNumber` defaults to `externalOrderId` as written, phone through `PhoneService.standardize`, extras only when filled. `rethrowAsHttp`: conflict → 409 `API_ORDER_IDEMPOTENCY_CONFLICT`, acceptance → 503 `API_ORDER_ACCEPTANCE_FAILED`, dispatch → 503 `API_ORDER_DISPATCH_FAILED`.
- **Code maps.** Source: `API_SOURCE_UNAVAILABLE` (no source, wrong source, second source, non-Standalone), `API_SETUP_INCOMPLETE`. Readiness: `API_ENTITLEMENT_REQUIRED`, `API_AUTO_VERIFY_DISABLED`, `API_PLAN_LIMIT_REACHED`. A missing or malformed `Idempotency-Key` is `API_VALIDATION_FAILED`. Credit denials keep their E04.5 codes.

## Validation results

| Check | Before (clean `develop`) | After |
| --- | --- | --- |
| `npx jest src/modules/order-ingestion` | part of the row below | PASS — 10 suites, 271 tests |
| `npx jest src/modules/order-ingestion src/modules/orders src/modules/order-imports` | 1638 passed, **1 failed** (44 suites) | PASS — 46 suites, 1680 tests |
| `npx jest src/modules/order-api` (adapter, HTTP) | n/a | PASS — 2 suites, 76 tests |
| Full backend `npx jest` | — | PASS — 157 suites, 4138 tests |
| `npm run test:core:platform-neutral` | — | PASS — 9 suites, 144 tests |
| `npm run test:acceptance:e04` | — | PASS — 6 tests |
| `test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `test:contract:order-imports` | PASS — 60 | PASS — 60 |
| `test:contract:order-import-release-gate` | 20 passed, **1 failed** | 20 passed, **1 failed** (same test) |
| `test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `test:contract:shopify` | PASS — 11 | PASS — 11 |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS — 6 suites, 170 tests | PASS — 6 suites, 170 tests |
| `test:contract:integration-keys` | — | PASS — 11 |
| `test:contract:order-api` (new, disposable PostgreSQL 17) | n/a | PASS — 13 tests |
| `npx tsc --noEmit`, `npx eslint <touched>`, `prettier --check --end-of-line crlf <touched>`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |

**Manual unchanged (AC8).** `orders.service.spec.ts`, `manual-order-envelope.golden.spec.ts`, `manual-order.channel-adapter.spec.ts` and the manual contract suite pass with no edit to any expected body or code. The only edits in those files are constructor wiring: the ingestion service is now built with the readiness service. The same wiring edit was made in `standalone-order-ingestion.*.spec.ts`, `test/contracts/release-gate-harness.ts`, `test/order-imports.contract-spec.ts` and `test/standalone-manual-mvp.acceptance-spec.ts`.

**Expectations changed outside the manual suites, and why.**

1. `standalone-order-envelope.spec.ts` › *rejects an envelope from an unknown channel* used `'api'` as its unknown channel. `'api'` is now a known channel by AC5, so the test uses `'webhook'`. Its equivalence case now also covers the API envelope.
2. `release-gate-architecture.spec.ts` › *has no import-specific retry, cancel or order-list route* expected 13 order-import routes while the controller has 14 (`PATCH :id/rows/:rowNumber/phone`). This failed on clean `develop` and was recorded as pre-existing in the US-05-01 evidence. The count is corrected to 14 because this story extends the same file; the assertion that matters (no retry, cancel or order-list route) is unchanged.

**Pre-existing failure, not fixed here.** `order-import-release-gate.contract-spec.ts` › *AC4 … two batches with overlapping references* throws `HttpException: Import not found.` It fails identically before and after, on two baseline runs, and touches no file this story changed. It belongs to E04.6 follow-up.

**Coverage against the test requirements:**

- **`resolveForIntegration`:** happy path with no role, wrong integration, no active source, second active source, another organization's row, non-Standalone, onboarding incomplete.
- **Gate precedence:** every manual body asserted byte for byte (serialized, so key order counts), each pair of blockers in precedence order, credit passthrough from both `credit_denied` and `slot_unavailable`, fail closed on `source_inactive`, `setup_incomplete` and `order_ineligible`.
- **`submitOne`:** both principals, call order (resolve → evaluate → accept), nothing accepted when the resolver or the gate refuses, credential metadata absent from the acceptance input.
- **Schema validation (HTTP):** 26 field cases plus three `Idempotency-Key` cases, each answering `API_VALIDATION_FAILED` with the field named and nothing read or written.
- **Bad key:** missing header, malformed, non-Bearer, unknown, right prefix with a wrong secret, revoked, and a query-string key beside a valid header: all the byte-identical 401, before validation.
- **Tenant spoofing:** `orgId`, `integrationId`, `platform` and `storeDomain` in the body are rejected; two keys always write into their own organization and source; a key bound to another organization's source stores nothing in either (PostgreSQL).
- **Unready source:** each `API_*` source and readiness code, plus two E04.5 credit codes, with no acceptance and no dispatch.
- **Non-COD:** accepted with 202 and no verification id; over PostgreSQL the order is stored and visible in the dashboard projection as `ineligible`, the event is `skipped` with `non_cod_payment_method`, and there is no verification, dispatch, credit hold or send.
- **Every `API_ORDER_*` code:** conflict, acceptance failure (the database error text is not leaked) and both dispatch failures.
- **Unit equivalence** (`channel-equivalence.spec.ts`): the API and file-import adapters give the same `CanonicalOrderInput`, the same stored canonical order in the same key order, and the same fingerprint, with and without extras. The manual form differs only in its `manual-<hash>` identity. Only `ingestionType`, the namespaced key and the import batch metadata differ.
- **Architecture:** `ingestion-boundary.spec.ts` now covers `modules/order-api/`: exactly four files, no forbidden import, `submitOne` as the only call into ingestion, no declared limit, pattern or currency list, and no `orgId` / `integrationId` anywhere in the module. `release-gate-architecture.spec.ts` pins where the `'api'` literal may appear.

## Known gaps handed to later stories

- **Same-key replay after dispatch answers 503, not 202** (SYSTEM-DESIGN §4.6). The contract suite reproduces it: a retry after the first dispatch logs `api-order-dispatch` / `not_claimed`. The retry has no second effect (one order, one event, one send, one credit hold; asserted), but the response is wrong for a lost-response retry. Manual behaves the same today, and fixing it changes a manual response, so it is left to US-05-03, which owns replay semantics.
- **`orderDate` is checked for format only.** The file import's age window (too old, in the future) is an import-review rule and is not applied to API orders.
- **The app-wide IP throttler (60/min) still applies to the route** until US-05-04 replaces it with the per-integration throttle. There is no body limit, error envelope, correlation ID or per-request log line yet.
- The application was not booted against a real database and Redis in this story; module wiring is covered by type-checking and the HTTP spec's testing module, not by a full `AppModule` start.

## Rollout and recovery

- No migration. Rollback is removing `OrderApiModule` from `app.module.ts`; orders already accepted through the API stay valid Standalone orders (`ingestionType: 'api'` is accepted by the normalizer as long as `'api'` stays in the channel list).
- Do not expose the endpoint to integrators before US-05-03 and US-05-04.
