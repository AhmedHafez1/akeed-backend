# US-06-04 EasyOrders outcome synchronization evidence

**Validated:** 2026-10-03
**Revision:** backend `440230a` (platform-neutral tracking) and `d347175` (EasyOrders adapter), frontend `e075eaf`, all on `develop`
**Decision:** implemented locally and shipped disabled (`EASYORDERS_OUTCOME_SYNC_ENABLED=false`). **Update 2026-10-08:** ready for deploy; the product owner's end-to-end test report lifted the block on the side effects of `confirmed` and `canceled` and the echo behavior (no step-level record handed back). The switch stays off until deploy.

EasyOrders behavior is taken only from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), sections 2, 5, 6 and 8. No request was sent to EasyOrders while building or testing this story: the provider is a fake `fetch` in every test.

## What the code had, against the story's evidence note

The story said commerce actions were still Shopify-specific and had to move behind a common outcome contract first. That was already done in E02: `CommerceOutcomeAdapter` and `COMMERCE_OUTCOME_ADAPTERS` (`src/shared/commerce/commerce-outcome.ts`), `CommerceOutcomeRegistryService`, and `ShopifyOutcomeAdapter` behind them. Nothing was extracted. The story file now says so.

What was missing sat around that contract, and is the first commit (`440230a`), with no adapter opted in:

- Dispatch results were logged and dropped. There was no stored sync state and no retry.
- `order.update` webhook events had no handler.
- The dashboard only knew Shopify's merchant-cancel result.

## Decisions taken while building, for review

| Topic | Decision |
| --- | --- |
| Which sources get a sync row | Only an adapter that sets `tracksSynchronization`. Shopify and Standalone do not, so they write no row, retry nothing and show nothing new. |
| Switch off | The adapter has no capability. Every action is recorded `unsupported`, the merchant cancel action is not offered, and no request is made. |
| What counts as confirmed success | A `2xx` on the status write, or a read that shows the target status. Timeout, network failure and `5xx` on the write are ambiguous and force a read-back. |
| Unreadable order read | Fails closed, nothing written: no `store_id` (`store_unverified`), another store (`store_mismatch`), no status (`remote_state_unreadable`). The response shape of `GET orders/:id` is not in the contract record. |
| Status webhooks | Never cause an action. The echo of Akeed's own write is `reflected_outcome`; any other change is `remote_status_observed`. A merchant's change in the store does not change the verification. |
| Who retries | Background retry only for outcomes the hub dispatches (customer confirmation and cancellation, and the merchant's manual confirmation, which takes the same path and maps to `confirmed`). A merchant no-reply cancellation keeps its remote-first flow: a failure is answered to the merchant and nothing retries behind them. |
| Retry bounds | 5 attempts, backing off 30 s, 2 min, 8 min, 30 min. A wait the provider or the budget names is honored up to 10 minutes, up to 5 times, without spending an attempt. |
| Stored key that is not an envelope | `decryptToken` returns text it cannot parse unchanged. The adapter treats that as `credentials_unreadable` and never sends it as a key. |
| Queue wiring | Tracking and its worker are in `CommerceOutcomeSyncModule`, apart from `CommerceOutcomeModule`, so the registry still loads without Redis (the Shopify adapter spec relies on that). |

## Implemented behavior

- **Data.** Migration `0049_commerce_outcome_syncs.sql`, additive and re-runnable, plus the `_journal.json` entry and the schema table. One row per order and outcome action: state (`pending`, `succeeded`, `failed`, `unsupported`), attempts, deferrals, a short provider status, an error code, the assisted-action flag and the next attempt time. Composite foreign keys to `integrations (id, org_id)` and `orders (id, org_id)`. RLS on, grants revoked: API-only.
  - Rollback: `DROP TABLE "commerce_outcome_syncs"`. No existing row is rewritten and verification results are unaffected.
- **Registry.** For a tracking adapter: `pending` before the adapter runs, then the result. A tracking failure is logged and never changes the dispatch answer.
- **Retry worker.** Queue `commerce-outcome-sync`. The row is the truth; a job names the row. A retry that cannot be queued becomes `failed` / `retry_not_scheduled`.
- **Adapter.** Read, then write only from `pending`, then read back after a lost answer. Uses the connection and key of the order's own integration, inside the 30 per minute budget.
- **Status events.** `WebhookQueueProcessor` routes `order.update` to `EasyOrdersStatusUpdateHandler` after the same source checks as an order.
- **API.** `remote_sync` on `GET /api/verifications` rows (null for sources that do not track). `POST /api/verifications/:id/outcome-sync/retry`: owner or admin; `409 OUTCOME_SYNC_NOT_RETRYABLE` when there is no failed, retryable sync for the row's current result.
- **Frontend.** Standalone confirmations: a "Store update" section in the details sheet, apart from the verification history, with the state, a sentence per failure code and a retry for owners and admins; a second line under the row's status badge while an update is pending or failed. Arabic and English. The embedded (Shopify) skin is unchanged.

Shopify code is unchanged. Shared changes: optional fields on the outcome result types, the registry's optional tracker, `retryInBackground` on the hub's dispatch, the processor's `order.update` case.

## Acceptance criteria

| AC | Evidence |
| --- | --- |
| 1. Approved mapping: confirmation to `confirmed`, customer and merchant-authorized cancellation to `canceled` | Contract: "approved mapping" (three actions, request and row asserted). Unit: `easyorders-outcome.adapter.spec.ts` "approved mapping", mapping table in `easyorders-status-update.handler.spec.ts`. The "only after side effects are validated" part is the switch: writes stay off until the go-live run. |
| 2. Automatic no_reply stays local and unsupported; never reuses merchant cancellation authority | Contract: "keeps automatic no-reply local: unsupported, and nothing is sent". Unit: "never sends a request for automatic_no_reply_tagging", "does not retry a merchant action behind the merchant". The mapping has no entry for it. |
| 3. Own integration and key; unsupported and invalid current states explicit | Contract: "tenant isolation" (three tests), "does not overwrite an order that is already delivered / canceled / refunded". Unit: "current remote state", "connection". |
| 4. Retryable failures keep local intent and show pending or failed; no false success | Contract: "stays pending, keeps the local result, and reconciles on the retry", "gives up after bounded attempts and leaves a failure the merchant can retry", "a revoked key". Unit: `commerce-outcome-sync.policy.spec.ts`, `commerce-outcome-sync-tracking.spec.ts`, "never claims success when the read-back fails as well". Frontend: `StoreSyncSection.test.tsx`, `remoteSync.test.ts`. |
| 5. No loops or duplicate harmful actions; terminal remote states not overwritten | Contract: "status webhook feedback loop" (four tests), "does not write again for a repeated outcome". Unit: `easyorders-status-update.handler.spec.ts`, `webhook-queue.processor.order-update.spec.ts`. |

## Test requirements

| Case | Where |
| --- | --- |
| All approved mappings | Contract "approved mapping"; adapter spec. |
| Unsupported no_reply | Contract "keeps automatic no-reply local"; adapter and tracking specs. |
| Invalid terminal state | Contract "does not overwrite an order that is already ..."; adapter spec "never overwrites". |
| Wrong-tenant dispatch | Contract "refuses a dispatch that names another tenant's order, and never uses that tenant's key", "does not let another organization reopen a failed sync"; `verifications.outcome-sync.spec.ts` (viewer, other organization). |
| Timeout after potential success | Contract "timeout after a possible success" (three tests); adapter spec "a write whose answer was lost" (five tests). |
| Throttling | Contract "waits for a 429, without spending an attempt"; adapter spec "throttling"; policy spec. |
| Revoked key | Contract "a revoked key"; adapter spec "credentials and store health". |
| Webhook feedback loop | Contract "recognizes its own write coming back and does nothing", "recognizes the echo of a write whose answer never arrived". |
| Secrets | Contract "never logs, returns or stores a key, a token or a secret". |

## Validation results (as run, 2026-10-03)

Backend (`akeed-backend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | PASS, no errors. |
| `npx tsc -p tsconfig.build.json --outDir .tmp/us-06-04-build` | PASS. Used instead of `npm run build`, which deletes `dist` under a running dev server. `nest build` itself was not run. |
| `npx eslint <touched files>` | PASS, no errors or warnings. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run log:check` | PASS, 0 violations. |
| `npx jest` | PASS, 179 suites, 4602 tests. |
| `npm run test:core:platform-neutral` | PASS, 11 suites, 173 tests. |
| `scripts/test-easyorders-outcome-sync-contract.ps1` | PASS, 25 tests (applies 0047, 0048, and 0049 twice). |
| `scripts/test-easyorders-ingestion-contract.ps1` | PASS, 49 tests. |
| `scripts/test-easyorders-connection-contract.ps1` | PASS, 43 tests. |
| `scripts/test-order-imports-contract.ps1` | PASS, 60 tests (0049 added to its migration list). Failed once first: its hand-written `orders` table lacked the `(id, org_id)` unique key that migration 0024 gives the real one and 0049 references. The fixture was corrected. |
| `scripts/test-shopify-contract.ps1` | PASS, 11 tests. |
| `scripts/test-source-identity-contract.ps1` | PASS, 1 test. |

The existing Shopify specs and `commerce-outcome-registry.service.spec.ts` were not edited.

Frontend (`akeed-frontend`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS, no errors. |
| `npm run lint` | PASS, 0 errors, 4 warnings that were already there. |
| `npx prettier --check --end-of-line crlf <touched files>` | PASS. |
| `npm run test` | PASS, 91 files, 916 tests. |
| `NEXT_DIST_DIR=.next/e01-validation-build npx next build` | PASS. `tsconfig.json` was not changed by it. |

Not run:

- The E02 to E05 release gates (`npm run test:gate:*`).
- The remaining contract suites: manual order ingestion, order import release gate, order API, standalone provisioning, entitlements, platform-boundary migration, integration keys, verification overview, Paymob checkout and the E04.5 credit and billing suites.
- Any browser check. The changed screen is behind login; Arabic/RTL, English, light and dark still need a person's eyes.
- Anything against EasyOrders, a shared database or a deployed environment. Migration 0049 was applied only to disposable PostgreSQL containers.
- The retry worker against a real Redis. Its logic is tested with the queue faked.

## Open items and known limits

1. Remote writes stay off. Enabling them needs go-live step 10 of the contract record: transitions from `pending`, the side effects of `confirmed` and `canceled`, and whether an API change echoes as a status webhook.
2. The response shapes of `GET orders/:id` and of the status write are not in the contract record. The code assumes the order object at the top level with `store_id` and `status`, and fails closed otherwise. If the real shape differs, every write fails visibly until this is adjusted.
3. The rate budget is in memory, per API instance, and assumes the limit is per store (US-06-03 open item 4).
4. A sync that the registry refuses before the adapter runs on the first try (`source_identity_mismatch`) writes no row, because there is no order to attach it to. It is logged.
5. A sync stuck `pending` because the process died between the write and the result is retried only if its job was already queued. There is no sweeper for `pending` rows without a job; `next_attempt_at` is stored so one can be added.
6. A failed store update does not put the row in "needs action". It shows on the row and in the details sheet only.
7. `EasyOrdersOrderNormalizer` (US-06-03) passes whatever `decryptToken` returns as the key. The table's `v1:` check makes a non-envelope value unlikely, but it has the same pass-through the adapter now guards against. Not changed here.
8. The connection-health surface for `credentials_rejected` beyond the sheet's sentence is US-06-05.
9. Shared dashboard copy still says "Canceled in Shopify" (US-06-03 open item 10). It is only reachable from the embedded skin, so it was left.

## Operational notes

- **Enable:** deploy (migration 0049 runs at boot), confirm the store is connected and healthy, then set `EASYORDERS_OUTCOME_SYNC_ENABLED=true`. Needs Redis for the retry queue.
- **Disable:** set it back to `false`. New outcomes are recorded `unsupported`; a queued retry records `unsupported` on its next run and stops.
- **Logs to watch:** `easyorders-outcome-sync` (`errorCode`, `providerStatus`), `commerce-outcome-dispatch`, `commerce-outcome-sync-retry`, and the tracker's own failures `commerce-outcome-sync-begin`, `-settle`, `-schedule` (alert: a sync state may be stale).
- **A merchant reports an order not updated:** read `commerce_outcome_syncs` for the order (`state`, `error_code`, `provider_status`, `attempts`), then `easyorders_connections.health`. `remote_state_conflict` means the store had already moved the order; `source_credentials_rejected` needs a reconnect.
