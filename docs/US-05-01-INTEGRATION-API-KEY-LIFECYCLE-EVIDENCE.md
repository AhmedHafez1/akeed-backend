# US-05-01 integration API key lifecycle evidence

**Validated:** 2026-10-02
**Revision:** backend and frontend working trees on `develop` (uncommitted)
**Decision:** implemented locally. The release is blocked: issuance must not reach production before US-05-02 to US-05-04 (no pilot switch, by product decision 2026-10-02).

## Implemented behavior

- **Data.** Migration `0046_integration_api_keys.sql`, additive and re-runnable, plus a `_journal.json` entry and the `integrationApiKeys` schema table.
  - Composite FK to `integrations (id, org_id)`, a unique non-secret `prefix`, and CHECKs on the prefix format, the hash format, the name length and revocation consistency.
  - Indexes `(integration_id, revoked_at)` and `(org_id, created_at DESC)`.
  - RLS by `org_id`. `anon` and `authenticated` lose every grant, then get back `SELECT` on the metadata columns only, under an org policy. A member can never read `key_hash` and can never insert, update or delete through PostgREST.
  - Added to the order-imports contract migration list.
- **Key format.** `ak_live_<8 [a-z0-9]>_<43 base64url>`: 32 random bytes, stored only as their SHA-256 hash. The parser is strict and canonical: one secret has exactly one spelling.
- **Management API** (session auth, `Cache-Control: no-store`):
  - `GET /api/integration-keys` returns metadata only and is open to every member.
  - `POST /api/integration-keys` is for owners and admins. It returns the full key once.
  - `DELETE /api/integration-keys/:id` is for owners and admins. It revokes immediately and idempotently, and does not require a ready source.
  - The source comes from `StandaloneSourceResolver.resolveWritable(user, API_KEY_SOURCE_CODES)` through the existing ingestion-service facade. A new `API_KEY_SOURCE_CODES` map sits beside `MANUAL_ORDER_SOURCE_CODES`. Integrations are never queried again.
  - An integration may hold at most 5 active keys (409 `API_KEY_LIMIT_REACHED`). The cap is enforced under a per-integration advisory lock.
- **`IntegrationApiKeyGuard`.**
  - It accepts only `Authorization: Bearer <key>` and refuses key-like query parameters, even next to a valid header.
  - It looks keys up by prefix, compares hashes in constant time (an unknown prefix still runs a comparison) and refuses revoked keys.
  - It answers a uniform 401 `API_KEY_INVALID` for every failure.
  - It writes `last_used_at` at most once a minute with a conditional update that cannot undo a revocation.
  - It attaches `{orgId, integrationId, keyId, prefix}` and never builds `StandaloneIngestionContext`.
  - `IntegrationKeysModule` exports it for US-05-02.
- **Audit.** `integration-api-key-create` / `integration-api-key-revoke` log the actor, organization, integration, key id and prefix through `buildBackendLog`, never the secret or the hash. `key_hash`, `keyhash` and `plaintext` are added to `REDACTED_KEYS`.
- **Frontend.** A Settings → "API keys" tab, Standalone only (embedded `SETTINGS_TABS` are unchanged).
  - It shows a list with the prefix only, a server-only note, a create dialog with a one-time reveal and copy, and a revoke confirmation. Viewers see the list without actions.
  - AR/EN copy, RTL-safe logical properties and semantic tokens.
  - The secret lives only in the dialog's state. It is cleared on Done or close, and goes with the component when the merchant navigates. The create mutation has `gcTime: 0` and is `reset()` right after the secret is copied into state. Escape and outside clicks can't dismiss the reveal.

## Validation results

| Check | Before (clean `develop`) | After |
| --- | --- | --- |
| `npx jest src/modules/integration-keys` (secret, service, guard, controller pipes) | n/a | PASS — 4 suites, 66 tests |
| `npm run test:contract:integration-keys` (disposable PostgreSQL 17) | n/a | PASS — 11 tests |
| `npx jest src/modules/order-ingestion src/modules/orders src/modules/order-imports` | 1638 passed, **1 failed** | 1638 passed, **1 failed** (same test) |
| Full backend `npx jest` | — | 3982 passed, **1 failed** (same test) |
| `npm run test:core:platform-neutral` | — | PASS — 9 suites, 144 tests |
| `test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `test:contract:order-imports` (now also applies 0046) | PASS — 60 | PASS — 60 |
| `test:contract:order-import-release-gate` | 20 passed, **1 failed** | 20 passed, **1 failed** (same test) |
| `test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `test:contract:shopify` | PASS — 11 | PASS — 11 |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS (exit 0) | PASS — 6 suites, 170 tests (exit 0) |
| Backend `npx tsc --noEmit`, `npx eslint <touched>`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |
| Frontend `npx tsc --noEmit`, `npm run lint` | — | PASS — 0 errors (4 pre-existing warnings) |
| Frontend `npm run test` (Vitest) | — | PASS — 79 files, 762 tests (includes 11 new `ApiKeysTab` tests) |
| Authenticated browser check of the tab (AR/EN, light/dark) | — | NOT RUN — behind Supabase login; needs the user's session |

**Pre-existing failures.** Both reproduce on clean `develop` before any US-05-01 change and touch no file this story changed.

1. `release-gate-architecture.spec.ts` › *has no import-specific retry, cancel or order-list route* expects 13 order-import routes, but the controller has 14 (`POST :id/resume` appears to postdate the count).
2. `order-import-release-gate.contract-spec.ts` › *AC4 … two batches with overlapping references* throws `HttpException: Import not found.`

Both belong to E04.6 follow-up and are not fixed here.

**Coverage against the test requirements:**
- **Owner/admin/viewer matrix:** unit and contract tests. Viewers list keys but get 403 `API_KEY_ROLE_REQUIRED` on create and revoke, before any key is generated or stored.
- **Cross-tenant:** a contract test. Lists are scoped by org, another organization's key revokes as 404, principals carry their own org and integration, and a spliced prefix+secret fails.
- **One-time exposure:** the secret appears only in the create response. Neither the list JSON, the DB row nor the captured logs contain the secret or the hash. The frontend test also checks the DOM, the mutation cache and `localStorage`/`sessionStorage`.
- **Revoked, unknown and malformed keys, and a query-string key:** all get the byte-identical 401 body, in unit tests and against the real DB.
- **Rotation under concurrency:** 20 parallel authentications with the old and new key race a revocation. The new key never fails. After the revoke commits, the old key always fails. Concurrent `last_used_at` writes never clear `revoked_at`.
- **Cap under concurrency:** 8 parallel creates produce exactly 5 keys and 3 × 409.
- **Deferred:** the "same `StandaloneIngestionContext` as the session path" test is completed in US-05-02, once `resolveForIntegration` exists (as the story states).

## Rollout and recovery

- Do not deploy `develop` to production before US-05-02 to US-05-04 land. There is no pilot switch: the tab and endpoints go live with the deploy.
- Migration 0046 is additive. Rollback is `DROP TABLE integration_api_keys` and removing the module registration; no existing data is touched.
- A leaked key is cut off by revoking it in Settings → API keys, which takes effect on the next request. Accepted orders are kept. Rotation means creating the new key, deploying it, then revoking the old one; idempotency is scoped to the source, so nothing resets.

## Remaining release blockers

- US-05-02: the order endpoint, `resolveForIntegration` and the principal → context equivalence test.
- US-05-03 / US-05-04: idempotency extensions, throttling, body limit, error envelope, last-used and revoked display polish.
- An authenticated visual check of the tab in both locales and themes.
