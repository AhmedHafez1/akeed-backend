# US-02-03 — Shopify adapter and core decoupling

Validation date: **2026-09-02**. Local working trees based on backend `991f7d88b244a721cc379797ab3a063bac585451` and frontend `57d63f15ff643d29f0355c495f7e9f09cddbee37`, including the pre-existing uncommitted US-02-02 registry work. No commit, deployment, migration, live message, or live cancellation is claimed.

Implementation is complete locally. Release validation remains pending for the dedicated PostgreSQL contract environment and authenticated/live release checks.

## Delivered behavior

- `ShopifyOutcomeAdapter` wraps the existing `ShopifyApiService`. `CommerceOutcomeRegistryService` resolves the persisted source tuple and active integration before selecting the adapter. The old global admin/tagging port bindings are removed.
- Customer confirmation/cancellation retain `Akeed: Verified` / `Akeed: Canceled` tags. Automatic no-reply retains `Akeed: No Reply`; neither customer cancellation nor escalation cancels a remote order.
- Merchant cancellation preserves **remote cancellation acceptance → guarded local merchant cancellation → best-effort canceled tag**. A separate neutral `merchant_cancellation_tagging` action preserves this ordering without relabeling a merchant action as a customer reply.
- The registry suppresses outbound commerce work for both `akeed-test-` IDs and persisted `isTest` orders, after source/capability checks. Unsupported providers are never routed into Shopify.
- Initial and follow-up sends require the order's actual integration, matching verification/order/integration ownership. Missing or mismatched linkage returns `missing_linked_integration` / `source_identity_mismatch` before billing reservation or messaging. There is no Shopify fallback lookup. Automation also checks the queued organization against the loaded records.
- Shopify eligibility implementation moved into the Shopify spoke. Core receives eligibility strategies through `ORDER_ELIGIBILITY_STRATEGIES`; its existing eligibility behavior is retained. Billing separation and the Shopify-only test-order creation endpoint remain owned by subsequent stories.
- Cancellation responses expose `providerOperationId` and `operation`. Pending operation metadata is merged atomically with the existing guarded local update and returned on idempotent repeats. Existing metadata, historical cancellations, and external IDs are not rewritten.
- The controller additionally emits the legacy `shopifyJobId` alias when a reference exists. Both frontend domain hooks use the shared neutral response type, per-row capabilities, and Arabic/English pending/unavailable feedback. Legacy responses without capabilities remain compatible; explicit unsupported capabilities hide cancellation controls and block submission in both hooks.

## GraphQL behavior and synchronization truth

The configured API version remains supported; the existing default is `2026-01`. Order operations use `POST https://{shop}/admin/api/{version}/graphql.json`. Merchant cancellation preserves `reason: CUSTOMER`, `notifyCustomer: false`, `refund: false`, `restock: true`, the existing staff note, and order GID conversion. Customer outcomes use `tagsAdd`.

A returned job reference maps to `pending_provider_operation`, not completed remote cancellation. The characterized no-job response still permits the local merchant transition, but maps to the additional `accepted_without_reference` state. This prevents inventing a reference or claiming completion. The existing five registry result states remain available. Historical cancellations without recorded synchronization state remain unknown.

GraphQL tag/user errors previously logged inside the API now propagate to the registry's failure result; callers still preserve the local verification outcome and best-effort tagging behavior. No new automatic retries or job polling were introduced. Transport ambiguity, simultaneous remote cancellation calls, or acceptance followed by failed local persistence still require reconciliation; this work does not claim exactly-once provider execution.

The [Shopify orderCancel documentation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel) was rechecked on 2026-09-02: it describes an asynchronous job, and marks `refund` deprecated in the latest API. This story preserves the characterized pinned request rather than migrating versions or refund semantics. Documentation review is not live provider/account validation. REST-oriented guidance in `AGENTS.md` and `.github/copilot-instructions.md` has been reconciled with the actual GraphQL implementation.

## Verification

| Check | Result |
| --- | --- |
| Backend `npm run test -- --runInBand` | **38 suites, 436 tests passed**, including all 399 existing fixtures and added adapter, source, capability, reference-persistence, and response-bridge tests |
| Focused adapter/service rerun after lint fixes | **2 suites, 57 tests passed** |
| Backend `npm run build` and `npx --no-install tsc --noEmit` | Passed |
| Backend non-fixing `npx --no-install eslint "{src,apps,libs,test}/**/*.ts"` | **0 errors, 19 existing unsafe-test-argument warnings** |
| Backend `npm run log:check` | Passed, 0 violations |
| Frontend `npx --no-install tsc --noEmit --incremental false` | Passed; includes both embedded and standalone consumers |
| Fixture `npx --no-install tsc --noEmit --incremental false -p test/e01-smoke/tsconfig.json` | Passed |
| Frontend `npm run lint` | Passed |
| Frontend `npm run build` with temporary `NEXT_DIST_DIR=.next-us-02-03` | Passed; temporary output and generated tsconfig additions removed afterward |
| Isolated browser cancellation fixture | Passed embedded/standalone × English/Arabic: dismissal, disabled loading controls, failure without refresh, retry, successful local row refresh, and pending-provider message. Standalone refreshes stats; embedded does not. Unsupported capability hides the action in all four combinations. Legacy capability omission and Enter-key confirmation/dismissal checked in both skins. Arabic document reports `lang=ar`, `dir=rtl`. |
| `npm run test:contract:shopify` | **Not run: harness fails before connecting because `E01_TEST_DATABASE_URL` is unset.** Docker is not available on PATH to run the disposable wrapper. This is not a passing PostgreSQL contract result. |

The browser fixture imports the real hooks/tables, substitutes only the API/auth module, and makes no provider calls. It is functional UI evidence, not authenticated full-layout styling, live Shopify, or standalone account evidence. One capability selection made before hydration was retried after the order row loaded; the settled capability behavior passed.

## E01 input-boundary review

The existing real HTTP/ValidationPipe characterization remains intact: whitelist transformation removes `transactions`, even though direct Shopify eligibility fixtures recognize transaction-only COD evidence. Moving the strategy and outcome adapter does not change the webhook DTO or retain additional raw fields. Direct strategy parity is **not** claimed for HTTP ingestion. See [E01 baseline evidence](E01-BASELINE-EVIDENCE.md).

An additive transaction DTO/raw-retention change needs an explicit ingestion contract decision and HTTP/security fixtures. It is not silently bundled into this outcome-boundary migration.

## Rollout and recovery

1. Provision the isolated database described in the [E01 evidence](E01-BASELINE-EVIDENCE.md) or use `scripts/test-shopify-contract.ps1` where Docker is available. Run the PostgreSQL gate; never substitute the application's database URL.
2. Deploy the backend compatibility bridge first, then deploy both frontend modes together. Confirm authenticated mode/locale smoke against the release revision and validate provider behavior before live rollout.
3. Keep `shopifyJobId` until all deployed consumers use the neutral fields. Remove it in a separately coordinated contract change, not during a partial deployment.
4. For a pending job, use the retained `providerOperationId` to inspect the provider. A missing reference requires checking the order directly. This implementation does not automatically poll or reconcile completion. Do not blindly replay an ambiguous cancellation. Tag failures leave local outcomes intact and are visible in registry synchronization logs.
5. Rollback is code-only, using the matching backend/frontend release pair. Retain JSON metadata and existing order IDs; no reverse data migration is needed. Older frontend versions can run against the bridge during rollback. Keep the pre-existing US-02-02 work when reverting only this story.

The E02 release gate remains open; this evidence does not mark the epic or live rollout complete.
