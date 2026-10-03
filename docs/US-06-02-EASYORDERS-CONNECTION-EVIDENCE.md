# US-06-02 EasyOrders authorized connection evidence

**Validated:** 2026-10-03
**Revision:** backend and frontend working trees on `develop`, on top of backend `f5f7e50` and frontend `0e86641`
**Decision:** implemented locally and shipped disabled (`EASYORDERS_CONNECT_ENABLED=false`). No real merchant may connect until the US-06-01 go-live verification has observed the real install callback. Order ingestion (US-06-03) and remote status writes (US-06-04) are not part of this story.

EasyOrders behavior is taken only from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md). No request was sent to EasyOrders while building or testing this story: the provider is a fake `fetch` in every test.

## Decisions taken with the product owner (2026-10-03)

| Question the record left open | Decision |
| --- | --- |
| Which call proves a key, and what counts | `GET orders/<random UUID>` with `Api-Key`. Fail closed: only a 2xx or the exact inactive-store `400` passes. A `404` does not. An active store will probably be refused until the owed run shows the real responses. |
| `store_id` in the callback | A claim (`store_verified_at` NULL). Only a verified store holds the one-store slot. US-06-03 verifies it. |
| How a merchant chooses EasyOrders | A visible source picker on signup, shown only when the frontend switch is on. Start-install is gated by the backend switch and an organization allow-list. |
| Setup inputs in this story | The two webhook secrets only. Currency and phone country are US-06-05. |

## Implemented behavior

- **Data.** Migration `0047_easyorders_connection.sql`, additive and re-runnable, plus the `_journal.json` entry and the schema tables.
  - `easyorders_pending_installs`: the single-use install context. Hashes of the callback token and of the webhook URL token, the URL hint, expiry, consumed and superseded timestamps, an attempt counter and the last refusal code.
  - `easyorders_connections`: one row per integration, composite FK to `integrations (id, org_id)`. Ciphertext for the API key and the two webhook secrets, with CHECKs that refuse anything but a `v1:` envelope; the webhook token hash (unique) and hint; `health`; the claimed `store_id`; a partial unique index on `store_id WHERE store_verified_at IS NOT NULL`.
  - RLS on both tables with no policy, and every `anon` / `authenticated` grant revoked.
  - Rollback: drop both tables. No existing row is rewritten.
- **Source-choosing signup.** `POST /api/organizations` accepts `sourceMode: "connect"`, which creates the organization and owner membership with no source. A member's second call never provisions, so a source-less organization is never turned into a Standalone one.
- **Start install.** `POST /api/easyorders/install`: owner or admin, Supabase session, switch on, organization on the allow-list, no integration row. Returns the authorized-app link (permissions `orders:read,orders:update`, both tokens in URL paths) and its expiry. Starting again retires the earlier context.
- **Callback.** `POST /api/easyorders/install/callback/:token`: public, throttled to 20 per minute per IP, CORS answered for `https://app.easy-orders.net` only. Validates the context, the body shape and the store claim, probes the key outside any transaction, then provisions in one transaction and answers an empty `204`.
- **Provisioning.** One `easyorders` integration with source identity `easyorders:<orgId>`, the Starter / `not_required` pilot entitlement and the Standalone onboarding defaults (`assume_cod_when_payment_missing` is `false`), plus its connection row.
- **Webhook secrets.** `PUT /api/easyorders/connection/webhook-secrets`: owner or admin, encrypted, write-only.
- **Status.** `GET /api/easyorders/connection`: any member. State, store id, health, URL hint, whether each secret is set. No credential.
- **Frontend.** Source picker on signup; `AuthGuard` sends a source-less account that chose a store platform to setup; the onboarding page mounts the EasyOrders skin with connect, waiting, not-completed, error and connected states in Arabic and English. The install link is navigated to in a new tab and never rendered; the secret fields are masked and emptied after a save.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Owner/admin starts with minimum permissions and a single-use expiring context bound to their organization | Contract: "valid install", "who may connect", "install context". Unit: `easyorders-install-link.spec.ts` (permissions, tokens in paths), `easyorders-auth.service.spec.ts` (hashes only, 15 minutes, caller binding). |
| 2. Callback validated per the contract; credentials checked; replay and mismatched store cannot replace credentials | Contract: "rejects a replayed callback and leaves the stored credentials untouched", "credential check", "store binding". Unit: `easyorders-api.client.spec.ts` (probe table, including 404 refused). |
| 3. Keys and secrets encrypted, never returned or logged; unauthorized roles cannot connect | Contract: "webhook secrets", "secrets and grants", "refuses a viewer". Disconnect does not exist yet (see open items). |
| 4. A successful install provisions one easyorders source with the pilot entitlement and onboarding settings | Contract: "provisions one easyorders source with the pilot entitlement, the onboarding defaults and encrypted credentials". |
| 5. Existing sources rejected without mutation; signup chooses its source first | Contract: "existing source", "source-choosing signup". Unit: `organizations.source-mode.spec.ts`. Frontend: `SignupSource.test.tsx`, `AuthGuard.test.tsx`, `auth.provisioning.test.ts`. |

## Test requirements

| Case | Where |
| --- | --- |
| Valid install | Contract "valid install" (active, inactive store, admin) |
| Denied install | EasyOrders sends no signal for a decline (Cancel behavior is UNKNOWN in the record). Covered as a context that expires with no callback: contract "rejects an expired context", frontend "shows the not-connected state". |
| Expired / replayed context | Contract "install context" |
| Spoofed callback / store | Contract "rejects an unknown token", "a malformed token", "rejects a store that is verified for another organization" |
| Invalid key | Contract "credential check" (401 and 404), "kills a context after five refused callbacks" |
| Cross-tenant callback | Contract "tenant isolation" |
| Concurrent connect | Contract "two callbacks on one link", "two open contexts for one organization", "concurrent starts" |
| Existing active source | Contract "existing source" (Standalone, Shopify, inactive, appeared after start) |
| Retry after partial failure | Contract "stores nothing when EasyOrders cannot be reached, and the same link works on retry", "rolls the whole provisioning back when a write fails" (fault injected by a trigger) |
| Secrets never in responses or logs | Contract "never puts a key, token or webhook secret in a response, a log line or a stored column" (every key, token and secret generated in the run, against all responses, all captured log lines and all three tables); unit "never writes the key, the token or the store into a log line"; frontend "without putting the link on the page", "never shows them", "without logging the secrets" |

## Validation results (as run, 2026-10-03)

Backend:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-06-02-build` | PASS. Used instead of `npm run build`, which deletes `dist` under the running dev server. Same compiler configuration; `nest build` itself was not run. |
| `npx eslint <touched files>` | PASS, no errors |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS |
| `npm run log:check` | PASS, 0 violations |
| `npx jest` (full unit suite) | PASS — 167 suites, 4359 tests |
| `npm run test:core:platform-neutral` | PASS — 9 suites, 144 tests |
| `scripts/test-easyorders-connection-contract.ps1` (disposable PostgreSQL 17) | PASS — 43 tests |
| `scripts/test-shopify-contract.ps1` | PASS — 11 tests |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS — 10 tests |
| `scripts/test-order-imports-contract.ps1` (applies 0047 twice) | PASS — 60 tests |
| `scripts/test-integration-api-keys-contract.ps1` | PASS — 11 tests |
| `scripts/test-source-identity-contract.ps1` | PASS — 1 test |

Frontend:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS — 0 errors, 4 warnings that were already there (unused variables in embedded dashboard files) |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS |
| `npm run test` | PASS — 87 files, 848 tests |
| `NEXT_DIST_DIR=.next-us0602 npx next build` | PASS. The `tsconfig.json` edit it makes was reverted and the directory removed. |

Not run:

- The E02 to E05 release gates (`npm run test:gate:*`). No Shopify file was changed; the Shopify contract suite and the full unit suite, which include the Shopify specs, pass unchanged.
- A browser check. Both dev servers were running under the developer's control and were not restarted; the picker needs `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED=true` in the frontend environment, and every connect screen is behind login. The screens are covered by component tests in both locales, not by eye.
- Any call to EasyOrders, and any migration against a shared database. `0047` was applied only to disposable containers; the app applies it on its next boot.

## Open items and known limits

1. **Go-live is blocked** on the US-06-01 owed run. In particular the fail-closed probe is expected to refuse an active store until the response to a valid key on an unknown order is observed; the callback's headers and any extra body fields (for example a webhook secret) are unknown, and extra fields are ignored today.
2. **No disconnect or reconnect.** AC 3 names disconnect roles; the endpoint is US-06-05. Until then any existing integration row, active or not, blocks a connect.
3. **The webhook URLs given to EasyOrders answer `404` until US-06-03.** Whether EasyOrders disables a failing webhook is unknown. Acceptable only because no real merchant connects before then.
4. **Entitlement is the Starter / `not_required` plan even when Standalone credit billing is on.** Prepaid-credit accounting is Standalone-only in core; moving EasyOrders to credits is a core change and a product decision.
5. **Setup stops at the connected screen.** The store and test steps are Standalone-specific; the EasyOrders versions, with currency and phone country, are US-06-05. An EasyOrders organization therefore cannot reach the dashboard yet.
6. **A source-less organization that is not on the allow-list waits for staff.** It has no path to Standalone, by design (no conversion).
7. **The setup shell's stepper still shows the Standalone steps** above the EasyOrders screen.
8. **An orphan API key and webhooks stay at EasyOrders** after a refused or abandoned install. Akeed cannot delete them without a working key; the not-completed and error screens tell the seller to delete them.
9. **The callback is throttled by the app-wide in-memory throttler** (20 per minute per IP on this route), per instance.

## Operational notes

- Enable for a pilot: set `EASYORDERS_PUBLIC_API_BASE_URL` and `EASYORDERS_APP_BASE_URL`, turn on `EASYORDERS_CONNECT_ENABLED`, then `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED` in the frontend. The merchant signs up choosing EasyOrders; staff add the new organization's UUID to `EASYORDERS_PILOT_ORG_IDS` and restart.
- Disable: turn `EASYORDERS_CONNECT_ENABLED` off. Connected integrations keep their rows; nothing ingests either way.
- Logs: `easyorders-install-start`, `easyorders-install-callback` (with `errorCode` on refusal), `easyorders-webhook-secrets-save`, `sourceless-organization-provision`.
