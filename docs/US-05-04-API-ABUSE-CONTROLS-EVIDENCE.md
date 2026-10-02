# US-05-04 API abuse controls and safe operational errors evidence

**Validated:** 2026-10-02
**Revision:** backend and frontend working trees on `develop` (uncommitted). No migration, no new table.
**Decision:** implemented locally. The release stays blocked until US-05-05 (guide) and US-05-06 (gate and pilot).

## Implemented behavior

Request path of `/api/v1/*`:

```text
edge middleware (main.ts, ahead of Nest's body parser)
  correlation ID -> body read under the API's own limit -> one log line on finish
-> OrderApiIngressThrottleGuard   order-api:ip:<address>      (before authentication)
-> IntegrationApiKeyGuard         (unchanged)
-> OrderApiThrottleGuard          order-api:<integrationId>, then order-api:global
-> route pipe -> controller -> adapter -> submitOne           (unchanged)
-> OrderApiExceptionFilter        {code, message, correlationId}
```

- **Rate limits.** `OrderApiThrottleGuard` counts on the app's shared `ThrottlerStorage`, the same `storage.increment` call as `OrderImportUploadThrottleGuard`. The bucket is the integration, so a rotated or second key shares it. The global bucket is counted only for requests the integration bucket let through. A blocked request answers 429 `API_RATE_LIMITED` with `Retry-After` (seconds) and never reaches the route pipe, the adapter or `submitOne`. The controller carries `@SkipThrottle()`, as the import upload route does.
- **Pre-auth ceiling (decided during planning).** With the app-wide IP throttler skipped, a request with a bad or missing key had no limit at all. `OrderApiIngressThrottleGuard` counts by client address before the key lookup.
- **Body limit.** `applyOrderApiEdge(app)` mounts an Express middleware on `/api/v1` before Nest registers its parsers. It reads every body as JSON under `ORDER_API_MAX_BODY_BYTES`, whatever the content type, so a form-encoded body cannot reach the app-wide parser and its 100 KB limit. Over the limit: 413 `API_PAYLOAD_TOO_LARGE`, before authentication, validation or ingestion. A body that is not a JSON object or array: 400 `API_VALIDATION_FAILED`.
- **One envelope.** `OrderApiExceptionFilter` (controller-scoped, catches everything) and the edge share `toOrderApiFailure`. Every error body is `{code, message, correlationId}`; `API_VALIDATION_FAILED` also keeps `fieldErrors` (decided during planning). `statusCode` and `error` are gone from `/api/v1` error bodies. A coded exception keeps its code and authored message, so the adapter's `API_*` codes and the E04.5 credit codes are unchanged. Anything else answers a fixed message: `API_INTERNAL_ERROR` (500) or `API_REQUEST_REJECTED` (uncoded 4xx).
- **Correlation ID.** A client `X-Correlation-Id` is echoed only when it matches `^[A-Za-z0-9._-]{8,64}$`; otherwise a UUID is generated. Every response carries `X-Correlation-Id`. The edge also writes the ID over the request's `x-request-id`, so `X-Request-Id` and the key guard's log line carry the same value and a client-supplied `X-Request-Id` is no longer echoed on this route.
- **Request log.** One `buildBackendLog` line per request, written when the response ends: `action: order-api-request`, `outcome`, `requestId`, `correlationId`, `orgId`, `integrationId`, `keyId`, `keyPrefix`, `httpStatus`, `resultCode` (`accepted`, `duplicate` or the error code), `durationMs`, `orderId` when present, and `errorCode` (a PostgreSQL code or error class name) for an unexpected failure. It never reads the body or the `Authorization` header and never logs an error message.
- **Configuration.** `src/shared/config/order-api.config.ts`, parsed by `validateEnv`. Startup fails on a value outside its range or when per-integration ≤ global ≤ pre-auth does not hold.

| Variable | Default | Range |
| --- | --- | --- |
| `ORDER_API_RATE_LIMIT_PER_INTEGRATION` | 60 | 1–6000 |
| `ORDER_API_RATE_LIMIT_GLOBAL` | 300 | 1–60000 |
| `ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP` | 600 | 1–120000 |
| `ORDER_API_MAX_BODY_BYTES` | 32768 | 1024–102400 |

- **Frontend.** The API keys tab shows "Last used {date and time}" or "Never used" for every key, beside the existing revoked date. An uncoded 429 from key management now has its own copy (`apiKeys.errors.RATE_LIMITED`) in Arabic and English.

### Where the code lives

- `src/modules/order-api/edge/`: `order-api.edge.ts`, `order-api-throttle.guard.ts`, `order-api-exception.filter.ts`, `order-api-outcome.interceptor.ts`, `order-api-request-state.ts`, `order-api.errors.ts`.
- `src/shared/config/order-api.config.ts`, `src/shared/http/correlation-id.ts` (the pattern lives in `shared` because the boundary spec forbids regex literals in `order-api`).
- Edited: `order-api.controller.ts` (decorators only; the method body is unchanged), `order-api.module.ts`, `main.ts`, `env-validation.ts`, `.env.example`, `docs/ENVIRONMENT.md`.
- Nothing changed in `order-ingestion`, `integration-keys`, `shared/logging` or any repository.

### Architecture guard changed, and why

`ingestion-boundary.spec.ts` pinned four files in `modules/order-api` and forbade `orgId` / `integrationId` anywhere in the module. The throttle and the request log must name the integration. The spec now:

- pins the four channel files and the six `edge/` files separately;
- keeps the "no `orgId` / `integrationId`" rule for the channel files;
- adds a rule for `edge/`: no import from `order-ingestion`, a repository, the DTO or the channel adapter, and no read of `.body`, `.rawBody` or `headers.authorization`;
- matches the three-guard `@UseGuards` order instead of the single key guard.

The import, `submitOne`-only and "no limit, pattern or currency list" rules still cover every file of the module, `edge/` included.

## Validation results

| Check | Before (clean `develop`) | After |
| --- | --- | --- |
| `npx jest src/modules/order-ingestion` | PASS — 10 suites, 280 tests | PASS — 10 suites, 281 tests |
| `npx jest src/modules/orders src/modules/order-imports src/modules/order-api` | PASS — 38 suites, 1490 tests | — (see next two rows) |
| `npx jest src/modules/order-api` | 2 suites, 80 tests (US-05-03 evidence) | PASS — 4 suites, 153 tests |
| `npx jest src/modules/order-api src/shared/config src/shared/http src/modules/order-ingestion src/modules/orders src/modules/order-imports` | — | PASS — 58 suites, 1986 tests |
| Full backend `npx jest` | 157 suites, 4163 tests (US-05-03 evidence) | PASS — 161 suites, 4268 tests |
| `npm run test:core:platform-neutral` | — | PASS — 9 suites, 144 tests |
| `test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `test:contract:order-imports` | PASS — 60 | PASS — 60 |
| `test:contract:order-import-release-gate` | 20 passed, **1 failed** | 20 passed, **1 failed** (same test) |
| `test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `test:contract:shopify` | PASS — 11 | PASS — 11 |
| `test:contract:order-api` | PASS — 2 suites, 37 tests | PASS — 2 suites, 37 tests |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS — 6 suites, 170 tests | PASS — 6 suites, 170 tests |
| `npx tsc --noEmit`, `npx eslint <touched>`, `prettier --check --end-of-line crlf <touched>`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |
| Frontend `npx tsc --noEmit`, `npm run lint` | — | PASS — 0 errors (4 existing unused-variable warnings) |
| Frontend `npx vitest run src/features/settings` | — | PASS — 17 files, 256 tests |

Contract suites ran on disposable `postgres:17-alpine` containers, never the app database.

**Pre-existing failure, not fixed here.** `order-import-release-gate.contract-spec.ts` › *AC4 … two batches with overlapping references* throws `HttpException: Import not found.` It failed on the clean tree (twice) and fails identically after; it is also recorded in the US-05-01, US-05-02 and US-05-03 evidence.

**Not run:** `test:contract:integration-keys` (the key guard and its repository are unchanged).

**Expectations changed, and why.** Only `order-api.http.spec.ts`, and only error bodies: `UNIFORM_401` and the validation, unready-source and external-ID-conflict assertions dropped `statusCode` / `error` and gained `correlationId`. Every status code and every `code` is unchanged. No success-body expectation changed; the two order-api contract suites are untouched and pass.

## Coverage against the test requirements

`order-api.http.spec.ts` runs the production edge, guards, pipe, controller, adapter, ingestion service, source resolver and readiness service over real HTTP, mounted as `main.ts` mounts them; only repositories and billing reads are faked.

- **Burst:** the request after the limit answers 429 `API_RATE_LIMITED` with an integer `Retry-After` from 1 to 60.
- **Concurrent load:** 10 simultaneous requests against a limit of 3 give exactly 3 × 202 and 7 × 429, and exactly 3 `submitOne`, acceptance and dispatch calls.
- **Rotated-key bypass:** a second key of the throttled integration is refused; another integration is still served; the global limit refuses an integration that is under its own limit.
- **Unauthenticated flood:** after the pre-auth ceiling, a bad-key request answers 429 and the key lookup is not called.
- **Retry after throttling succeeds:** `order-api-throttle.guard.spec.ts` (real `ThrottlerStorageService`, fake timers) refuses one second before `Retry-After` elapses and allows right after. This is proven at the guard, not over HTTP.
- **Oversized bodies:** exactly the limit passes; one byte over, a large field, a chunked body with no declared length, a form-encoded body and an oversized body without a key all answer 413. Malformed JSON, form data, plain text and a JSON string answer 400.
- **Never reaches ingestion:** for every throttled and oversized case the `submitOne` spy, the source lookup, the plan-slot check, the credit check, the acceptance repository and the dispatcher are not called.
- **Envelope:** authentication, validation, both conflicts, unready source, 503, an unexpected error, 413 and 429 answer exactly `{code, message, correlationId}` (validation adds `fieldErrors`).
- **Correlation ID:** generated when absent; a safe value is echoed in the header, the body and the log; markup, a phone number, a short value and a JSON fragment are replaced and appear nowhere; `X-Request-Id` equals it and a forged `X-Request-Id` is not logged.
- **Redaction:** on the authentication, query-string key, validation, both conflict, database-error and oversized paths, no captured log line and no response body contains the key, its secret part, its hash, the phone, the customer name, the address or the notes. On the database-error path neither contains the SQL text or the other tenant's organization and integration IDs. Each request writes exactly one `order-api-request` line, and the accepted-order test pins its exact field set.

## Known gaps handed to later stories

- **A failed acceptance's cause is still logged by the ingestion service.** On 503 `API_ORDER_ACCEPTANCE_FAILED` the response and the request line are clean (tested), but `StandaloneOrderIngestionService` logs the underlying error through `normalizeError`, as it does for manual orders. If a database error message ever quoted row values, they would reach that line. This is core logging, shared by all channels, and was not changed here.
- **No `trust proxy`.** Behind a proxy `req.ip` is the proxy's address, so the pre-auth bucket is one shared ceiling for the route (the default 600 sits above the global 300 for that reason). Per-client pre-auth limits need `trust proxy` set for the deployment's proxy chain.
- **`express` is imported at runtime by `order-api.edge.ts`** (`json`) and is not a direct dependency in `package.json`; it resolves through `@nestjs/platform-express`. Declaring it is a one-line dependency change that was left for approval.
- **Unknown paths under `/api/v1`** (for example `/api/v1/unknown`) get a correlation ID and a request log line, but their 404 body comes from the app-wide filter, not the envelope.
- **In-memory counters.** Correct for one backend instance; a restart clears them. Redis-backed throttler storage is required before a second instance (deferred in the README).
- The `webhook-dispatch` / `not_claimed` warning on a recovered same-key retry (US-05-03 gap) is still written; `WebhookDispatchService` was not touched.
- The application was not booted against a real database and Redis in this story. The mount order of the edge ahead of Nest's parser is proven by the HTTP suite, which builds the app the same way.
- Effective limits and the "send us the correlation ID" triage path are in `docs/ENVIRONMENT.md`; the integrator-facing guide is US-05-05.

## Rollout and recovery

- No migration. Set the four variables only to move away from the defaults; tune them from observed pilot traffic without changing the public contract.
- Integrators must read `code`, not `statusCode`, from error bodies. Nothing was released before this change, so no client is affected.
- Rollback is reverting the commit: the route returns to the app-wide IP throttler, the 100 KB parser and the previous error body.
