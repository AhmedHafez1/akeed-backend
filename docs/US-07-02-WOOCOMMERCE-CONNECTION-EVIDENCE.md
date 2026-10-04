# US-07-02 WooCommerce connection evidence

**Validated:** 2026-10-04
**Revision:** backend `develop` at `1490631` (restricted client), `6fcf414` (connect switch), `79e27e4` (spoke); frontend `develop` at `3c0e1db` (skin selection), `6e4d5f9` (WooCommerce skin)
**Decision:** implemented locally and shipped disabled (`WOOCOMMERCE_CONNECT_ENABLED=false`, empty `WOOCOMMERCE_PILOT_ORG_IDS`). No real merchant may connect before order ingestion (US-07-03) is on and the US-07-06 gate has observed a real store. No order is ingested and nothing is written to a store's orders by this story.

WooCommerce behavior is taken only from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md). No request was sent to any store while building or testing this story: every store is an in-process fake (`test/contracts/woocommerce-provider-fake.ts`) placed under the real restricted outbound client as its DNS and its transport.

## Decisions taken with the product owner (2026-10-04)

| Question | Decision |
| --- | --- |
| The record contradicts itself on the start probe: its Detection paragraph lets any answer but 404, no answer, TLS failure and redirect continue; its table lists a 5xx or a non-JSON body as refused at start | A `5xx` at start is refused as `WOOCOMMERCE_REST_UNREACHABLE`. The body is never read at start. |
| Two callbacks on one link at the same moment can delete each other's webhooks (the record replaces webhooks outside any transaction) | `woocommerce_pending_installs.claimed_until` (not in the record's column list): one callback claims the install for 45 seconds before any store call, a second one is refused without counting an attempt, and every refusal releases the claim. |
| The record says the webhook URL token is generated at start and stored only as a hash, but the callback must put the token itself into the delivery URL | The token is generated in the callback from the CSPRNG. Its hash is written to the pending install just before the webhooks are created, so the ping finds a known token. Hash-only at rest, independent of the callback token. A retried callback issues a fresh token; the webhooks are replaced anyway. |

All three are recorded as a dated amendment at the end of the contract record.

Decisions made in the build, within the record: WooCommerce has its own `WOOCOMMERCE_PUBLIC_API_BASE_URL` and `WOOCOMMERCE_APP_BASE_URL` (the record left this open); the delivery path is read as raw bytes now, because the ping must be answered `200` whatever its body is; `return_url` ignores `user_id` (the status never exposes the install reference); the merchant goes to the store in the same tab.

## Implemented behavior

- **Restricted outbound client** (`src/shared/http/restricted-http.ts`, its own commit). `https:` on 443 only, no URL credentials; the host is resolved once and every address must be public (private, loopback, link-local, CGNAT, multicast, unspecified, reserved and documentation ranges, IPv6 ULA and link-local, IPv4-mapped and NAT64 by their embedded IPv4, anything outside `2000::/3`); the connection is pinned to the checked address with the hostname kept for SNI and the certificate; certificates are always verified; any `3xx` is an error and is never followed; one 10-second deadline; body capped at 1 MiB (2 MiB on request); only `Authorization`, `Content-Type`, `Accept`, `User-Agent` are sent; errors carry a code and the host only. Nothing existing was moved onto it.
- **Source-connect switch** (its own commit). `isSourceConnectEnabled` is true while EasyOrders or WooCommerce connect is on. EasyOrders specs are unchanged.
- **Data.** Migration `0051_woocommerce_connection.sql`, additive and re-runnable, with its `_journal.json` entry and the schema tables. `woocommerce_pending_installs` (canonical `store_url`, `callback_token_hash`, `install_reference`, `webhook_token_hash` NULL until the callback, `expires_at`, `consumed_at`, `superseded_at`, `claimed_until`, `attempts`, `last_error_code`) and `woocommerce_connections` (composite FK to `integrations (id, org_id)`, canonical `store_url`, `store_verified_at`, three `v1:` ciphertext columns with CHECKs, `webhook_token_hash` unique, the two webhook ids, `woo_version`, `health`, `rejected_deliveries`, `last_rejected_at`, `connected_by`, `connected_at`, and a partial unique index on `store_url WHERE store_verified_at IS NOT NULL`). RLS on both with no policy, grants revoked from `PUBLIC`, `anon`, `authenticated`. Rollback: drop both tables; no existing row is rewritten. Added to the migration list of `test/order-imports.contract-spec.ts`.
- **Start install.** `POST /api/woocommerce/install` with `{ storeUrl, locale }`: Supabase session, owner or admin, switch on, organization on the allow-list. The address is canonicalized per section 2 (raw text checked before `URL` normalizes it). An organization with any source is refused before any request leaves. One unauthenticated `GET {store}/wp-json/wc/v3` through the restricted client: `404` is `WOOCOMMERCE_REST_NOT_FOUND`, `5xx` or no answer `WOOCOMMERCE_REST_UNREACHABLE`, refused address, redirect and TLS each have their code. Then a 15-minute context bound to the organization, the user and the canonical store URL; earlier open contexts are retired. Answers `{ authorizeUrl, storeUrl, expiresAt }`: the only response that carries the callback token.
- **Callback.** `POST /api/woocommerce/install/callback/:token`: public, 20 per minute per address, no CORS entry, `Cache-Control: no-store`, answers `200 {}`. Order: switch (`404`); context by token hash, usable, organization still listed, claim (`401 WOOCOMMERCE_INSTALL_CONTEXT_INVALID`, nothing counted); body (`consumer_key`, `consumer_secret` bounded printable ASCII, `user_id` equal to the reference as string or number, else `WOOCOMMERCE_CALLBACK_INVALID`; `key_permissions` not `read_write` is `WOOCOMMERCE_PERMISSION_DENIED`); store verified for another organization (`WOOCOMMERCE_STORE_UNAVAILABLE`, before any store call); `GET system_status` with Basic auth against the context's URL within a 30-second budget, `401`/`403` mapped, `environment.home_url` canonicalized must equal the store URL (`WOOCOMMERCE_STORE_URL_MISMATCH`); context re-checked; webhook token hash written; list (up to 10 pages of 100), delete Akeed's own, create `order.created` and `order.updated` with one 32-byte secret (second failure removes the first, `WOOCOMMERCE_WEBHOOK_SETUP_FAILED`); one transaction stores the connection and provisions the source. A refused or faulted final transaction removes the two webhooks again.
- **Provisioning.** One `woocommerce` integration with source identity `woocommerce:<orgId>`, the Starter / `not_required` pilot entitlement and the Standalone onboarding defaults (`assume_cod_when_payment_missing` false), plus its connection row.
- **Status.** `GET /api/woocommerce/connection`: any member. State, canonical store URL, expiry, last refusal code, health. No key, secret, token, link or install reference.
- **Delivery URL.** `POST /api/woocommerce/webhooks/:token`, raw body for every content type (1 MiB). A request whose `X-WC-Webhook-Topic` is not `order.created`/`order.updated` on a known token (a connection, or an install that can still connect) is answered `200` and stores nothing. Every order delivery and every unknown token answers `404 WOOCOMMERCE_INGESTION_UNAVAILABLE` until US-07-03.
- **Logging.** Lines carry organization, pending install, integration, store host and code. `consumer_key`, `consumer_secret`, `authorize_url` and their camel-case forms joined `REDACTED_KEYS`. No request log in the app records paths, so the tokens in the callback and delivery paths are not logged by Akeed (the hosting platform's access log is outside the app).
- **Frontend.** WooCommerce in the signup source picker behind `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED`. The route guard remembers the signup choice and setup mounts that platform's connect skin (an unknown choice still gets EasyOrders). The skin: enter the address (checked first), waiting with polling, denied (`success=0`), unsupported store with the record's message per code, error (including an expired request), connected; plus loading, unavailable, pilot required, source exists and read-only. Arabic and English, RTL; the store is named by its canonical address in a left-to-right `bdi`. The denied, unsupported and error screens say where to delete an unused API key. The authorize link goes to the browser's navigation only.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Owner/admin starts for an entered URL; expiring single-use context bound to the organization and canonical store; authorize link with `read_write` | Contract: "valid install", "the authorize link", "who may connect", "store address", "install context". Unit: `woocommerce-store-url.spec.ts`, `woocommerce-install-link.spec.ts`, `woocommerce-auth.service.spec.ts` ("binds a 15-minute context…"). |
| 2. Callback is the proof; `return_url` only a hint; bound by the path token and `user_id`; keys proven against the context's store; replayed, expired, mismatched or cross-tenant callbacks change nothing | Contract: "install context", "credential check", "store binding" (keys for another store), "tenant isolation", "accepts user_id coming back as a JSON number". Frontend: `wooCommerce.types.test.ts` (hint parsing, "a success hint never shows a connection that does not exist"), `WooCommerceConnectPage.test.tsx` (denied changes nothing). |
| 3. Every request through one restricted client | Unit: `restricted-http.spec.ts` (94 tests). Contract: "SSRF at start", "SSRF at the callback" (including DNS rebinding between start and callback), "sends every request to an address the name resolved to". |
| 4. Keys encrypted, proven, never exposed | Contract: "secrets and grants" (every key, secret and token generated in the run against every response, log line and stored column), "refuses plaintext", "logs the host of a store and never its path". Unit: auth service "never writes a key, a token, the store path or what the store reported into a log line". |
| 5. Webhooks created with a per-install URL and an Akeed secret; ids stored; ping answered; failure leaves nothing half-connected and the link can be retried | Contract: "valid install", "webhook creation", "delivery URL before ingestion" (ping during the callback), "concurrency and partial failure". |
| 6. Only a fresh organization gets the source, with the pilot entitlement; any other source rejected without mutation; one store, one organization | Contract: "valid install", "existing source", "store binding" (connected elsewhere, two organizations racing, unique index), "source-choosing signup". |
| 7. Unsupported stores refused with their own code and localized message | Contract: "store address", "unsupported store", "credential check", "SSRF". Frontend: message parity test and the unsupported-screen tests in both locales. |

## Test requirements

| Case | Where |
| --- | --- |
| Valid install | Contract "valid install" (root domain, subdirectory, admin, trailing slash on `home_url`, numeric `user_id`) |
| Denied (`success=0`) | Frontend `WooCommerceConnectPage.test.tsx` "shows the denied state on success=0…"; backend: nothing is called or stored without a callback |
| Expired and replayed context | Contract "install context" |
| Bad credentials | Contract "credential check" (401, 403, wrong `key_permissions`, five refusals) |
| Cross-tenant callback | Contract "store binding" (keys for another store on this link), "tenant isolation" |
| Concurrent connects | Contract "two callbacks on one link…", "two open contexts…", "concurrent starts…", "a new install started while a callback holds the open context…", "lets one of two organizations racing for the same store win" |
| Existing active source | Contract "existing source" (Standalone, Shopify, EasyOrders, inactive, appeared after start) |
| Retry after a partial failure | Contract "rolls the whole provisioning back…", "stores nothing when the store cannot be reached…", "replaces a webhook left behind…" |
| Webhook creation failure | Contract "webhook creation" (first, second, list, forbidden, method refused) |
| SSRF | Contract "SSRF at start" and "SSRF at the callback"; unit `restricted-http.spec.ts` |
| Store in a subdirectory | Contract "connects a store in a subdirectory…" |
| No key, secret or token in a response, log or column | Contract "secrets and grants"; unit auth service log test; frontend "without putting the link on the page", "no credential" |

## Validation results (as run, 2026-10-04)

Backend:

| Check | Result |
| --- | --- |
| Before any change: `npx jest` | PASS: 183 suites, 4667 tests |
| Before any change: Shopify, Standalone provisioning, EasyOrders connection, order imports contract scripts | PASS: 11, 10, 59, 60 |
| After commit 1 (client): `npx jest`, `test:core:platform-neutral`, `log:check` | PASS: 184 suites, 4761 tests; 12 suites, 176 tests; 0 violations |
| After commit 1: Shopify, Standalone provisioning, EasyOrders connection contracts | PASS: 11, 10, 59 |
| After commit 2 (switch): `npx jest`, `test:core:platform-neutral`, `log:check` | PASS: 185 suites, 4777 tests; 12 suites, 176 tests; 0 violations |
| After commit 2: Shopify, Standalone provisioning, EasyOrders connection contracts | PASS: 11, 10, 59 |
| After commit 3 (spoke): `npx tsc --noEmit -p tsconfig.json` | PASS |
| `npx eslint <touched files>` | PASS, no errors |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS |
| `npm run log:check` | PASS, 0 violations |
| `npx jest` (full unit suite) | PASS: 192 suites, 5015 tests (WooCommerce spoke specs: 7 suites, 238 tests) |
| `npm run test:core:platform-neutral` | PASS: 12 suites, 176 tests |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-07-02-build` | PASS (used instead of `npm run build`, which deletes `dist`; output removed) |
| `scripts/test-woocommerce-connection-contract.ps1` (disposable PostgreSQL 17) | PASS: 112 tests |
| `scripts/test-easyorders-connection-contract.ps1` | PASS: 59 tests |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS: 58 tests |
| `scripts/test-order-imports-contract.ps1` (applies 0051 twice) | PASS: 60 tests |
| `scripts/test-shopify-contract.ps1` | PASS: 11 tests |
| `scripts/test-standalone-provisioning-contract.ps1` | PASS: 10 tests |
| `scripts/test-source-identity-contract.ps1` | PASS: 1 test |

Frontend:

| Check | Result |
| --- | --- |
| Before any change: `npx vitest run` | PASS: 96 files |
| After commit 1 (skin selection): `npm run test`, `npm run lint` | PASS: 97 files, 1030 tests; 0 errors, the 4 existing warnings |
| After commit 2: `npm run test` | PASS: 99 files, 1080 tests |
| `npm run lint` | PASS: 0 errors, the 4 existing warnings |
| `npx tsc --noEmit` | No error in `src/`. 9 errors remain in stale generated files (`.next/types`, `.next/shopify/dev/types`, `.next/e01-validation-build/types`: `validator.ts` and the admin layout's `params` type); they are there with this change stashed too. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS |
| `NEXT_DIST_DIR=.next-us0702 npx next build` | PASS. The `tsconfig.json` edit it makes was reverted and the directory removed. |

Not run:

- The E01 to E06 release gates (`npm run test:gate:*`). US-07-06 runs them. The Shopify, Standalone and EasyOrders contract suites and the full unit suites above, which include their specs, pass unchanged.
- A browser check. Every connect screen is behind login and the picker needs `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED=true`; the screens are covered by component tests in both locales, not by eye.
- Any request to a real store, and the migration against a shared database. `0051` was applied only to disposable containers; the app applies it on its next boot.
- A real certificate failure: the client is shown to have no way to skip verification and to map Node's certificate errors, and a non-TLS peer over a real socket is refused, but no live bad certificate was used. US-07-06 covers it.

## Open items and known limits

1. **The delivery URL answers `404` to orders until US-07-03**, so a store connected now has its webhooks disabled after five orders (contract record section 3). Do not connect a real merchant before ingestion is built and on.
2. **Races the claim does not close.** Two different links of one organization, or two organizations with working keys on the same store, calling back at the same instant can still delete each other's webhooks. The database stays consistent (one source, one connection); the store may be left without Akeed's webhooks. US-07-05 health will show the webhooks as missing; the fix is to reconnect.
3. **Setup stops at the connected screen.** The setup checklist, health, disconnect and reconnect are US-07-05, so a WooCommerce organization cannot reach the dashboard yet. Settings has no WooCommerce panel yet.
4. **The callback's content type is unknown (finding 1.12).** The app-wide JSON parser reads it; a store that posts anything but JSON is refused as `WOOCOMMERCE_CALLBACK_INVALID`. Observation 1 of US-07-06 settles it.
5. **An unused API key can stay in the store** after a denied, refused or abandoned install. The screens tell the merchant where to delete it.
6. **The callback and delivery route are throttled by the in-memory throttler** (20 and 1,200 per minute per address), per instance.

## Operational notes

- Enable for a pilot: set `WOOCOMMERCE_PUBLIC_API_BASE_URL` and `WOOCOMMERCE_APP_BASE_URL`, turn on `WOOCOMMERCE_CONNECT_ENABLED`, then `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED` in the frontend. The merchant signs up choosing WooCommerce; staff add the organization's UUID to `WOOCOMMERCE_PILOT_ORG_IDS` and restart. Do not do this before US-07-03 is on (open item 1).
- Disable: turn `WOOCOMMERCE_CONNECT_ENABLED` off. Start and callback answer `404`; connected rows stay; status still reads.
- Logs: `woocommerce-install-start`, `woocommerce-install-callback` (with `errorCode` on refusal), `woocommerce-install-webhook-cleanup`, `woocommerce-install-claim-release`.
