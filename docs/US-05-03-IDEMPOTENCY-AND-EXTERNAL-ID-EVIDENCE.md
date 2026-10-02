# US-05-03 idempotency and external order identity evidence

**Validated:** 2026-10-02
**Revision:** backend working tree on `develop` (uncommitted). No migration, no frontend change.
**Decision:** implemented locally. The release is blocked: US-05-04 (throttle, body limit, error envelope) is required before any external use.

## Implemented behavior

### Core (`ManualOrderIngestionRepository`, `StandaloneOrderIngestionService`)

- **External-ID replay.** In `acceptWithinTransaction`, a non-held acceptance whose order insert hits `(integration_id, external_order_id)` loads the existing order of the same organization and source and compares its `rawPayload.submissionFingerprint` with the incoming one, using the existing strict fingerprint. Equal: the transaction is rolled back (private `IdentityReplayRollback`, the same idiom as `RowRollback`), so the event just inserted does not survive, and `accept()` returns the existing order with its owning event, `duplicate: true` and `replay: 'external_id'`.
- **External-ID conflict.** Different fingerprint, or no stored fingerprint (a redacted order): `ManualOrderIdentityConflictError`, mapped by `acceptOne` to the new channel-neutral `StandaloneIngestionExternalIdConflictError`. The transaction rolls back; nothing is written and nothing is logged as an error.
- **Held path unchanged.** With `event.hold` the collision still returns `already_imported` before any comparison, so `acceptMany` and file import report it per row exactly as before.
- **No dispatch on an external-ID replay.** `acceptOne` skips `dispatchById` when `replay === 'external_id'`, reads the verification if there is one, and answers the usual `{orderId, eventId, verificationId?, duplicate: true, held: false}`. A held import order stays held, a withdrawn one stays withdrawn, a released or processed one keeps its lifecycle.
- **Same-key replay** still takes the existing branch (`replay: 'event_key'`) and still calls `dispatchById` on its own event, so a request that failed before queueing is recovered by its retry.
- **SYSTEM-DESIGN §4.6 fixed (decision taken during planning).** A same-key retry arriving after the event was dispatched used to answer 503 `*_DISPATCH_FAILED`. `WebhookDispatchService.isAlreadyDispatched(eventId)` is new: true when the event has `dispatched_at`, is `processing` / `completed` / `skipped` / `failed`, or is under another caller's unexpired dispatch lease. `acceptOne` asks it only after a `not_claimed` outcome and answers success when it is true. An event still in back-off, an unreadable event and a `failed` dispatch keep the 503.
- **Logging.** The `<channel>-order-accept` success line carries `replay: 'event_key' | 'external_id'` on duplicates; no payload.

### API channel (`src/modules/order-api/`)

- `ApiOrderChannelAdapter.rethrowAsHttp` maps `StandaloneIngestionExternalIdConflictError` to 409 `API_ORDER_EXTERNAL_ID_CONFLICT`. Nothing else changed in the module. Manual codes and the manual adapter are untouched; manual cannot reach the new branch because its identity is derived from its key.

### One deviation from the approved plan

The plan added an `'already_dispatched'` value to `DispatchOutcome`. The Shopify contract suite pins `dispatchById(...) === 'not_claimed'` for a completed event, and it failed with that change. `dispatchById` and `DispatchOutcome` are therefore left exactly as they were, and the question is asked through the separate `isAlreadyDispatched` method. No Shopify expectation was edited.

## Validation results

| Check | Before (clean `develop`) | After |
| --- | --- | --- |
| `npx jest src/modules/order-ingestion` | PASS — 10 suites, 271 tests | PASS — 10 suites, 280 tests |
| `npx jest src/modules/order-ingestion src/modules/orders src/modules/order-imports` | PASS — 46 suites, 1680 tests | PASS — 46 suites, 1690 tests |
| `npx jest src/modules/order-api` | PASS — 2 suites, 76 tests | PASS — 2 suites, 80 tests |
| Full backend `npx jest` | PASS — 157 suites, 4138 tests (US-05-02 evidence) | PASS — 157 suites, 4163 tests |
| `npm run test:core:platform-neutral` | — | PASS — 9 suites, 144 tests |
| `test:contract:manual-orders` | PASS — 15 | PASS — 15 |
| `test:contract:order-imports` | PASS — 60 | PASS — 60 |
| `test:contract:order-import-release-gate` | 20 passed, **1 failed** | 20 passed, **1 failed** (same test) |
| `test:contract:entitlements` | PASS — 7 | PASS — 7 |
| `test:contract:shopify` | PASS — 11 | PASS — 11 |
| `test:contract:integration-keys` | — | PASS — 11 |
| `scripts/test-e045-contracts.ps1` (credit suites) | PASS — 6 suites, 170 tests | PASS — 6 suites, 170 tests |
| `test:contract:order-api` (disposable PostgreSQL 17) | PASS — 1 suite, 13 tests | PASS — 2 suites, 37 tests; repeated 5 more times, 37/37 each |
| `npx tsc --noEmit`, `npx eslint <touched>`, `prettier --check --end-of-line crlf <touched>`, `npm run log:check` | — | PASS — 0 errors, 0 log violations |

**Unchanged suites.** `standalone-order-ingestion.accept-many.spec.ts`, `manual-order-ingestion.repository.spec.ts`, `test/manual-order-ingestion.contract-spec.ts`, `test/order-imports.contract-spec.ts`, `test/order-import-release-gate.contract-spec.ts` and `test/shopify.contract-spec.ts` have no edit.

**Expectations changed, and why.**

1. `test/order-api.contract-spec.ts` › *a retry with the same key and content never creates a second order, event or send* tolerated a refusal, because the retry answered 503 before the §4.6 fix. It now requires `{orderId, status: 'accepted', duplicate: true}`.
2. `orders.service.spec.ts`: no existing expectation edited. One case added (a same-key retry whose event is already dispatched answers 202 `duplicate: true`) and the dispatcher mock gained `isAlreadyDispatched`, defaulting to `false`. This is the one intended manual change: 503 becomes 202 in that case only.
3. `test/jest-order-api-contract.json` now also matches `order-api-idempotency.contract-spec.ts`.

**Pre-existing failure, not fixed here.** `order-import-release-gate.contract-spec.ts` › *AC4 … two batches with overlapping references* throws `HttpException: Import not found.` It fails identically before and after and is recorded in the US-05-01 and US-05-02 evidence.

**Coverage against the test requirements** (`test/order-api-idempotency.contract-spec.ts`, real repositories and services over PostgreSQL). Replay and conflict cases compare the organization's orders, events, verifications, dispatch-ledger rows and credit reservations row for row, plus the send and queue counters, before and after.

- **Concurrent identical requests:** 8 with one key, and 8 with 8 different keys. One order, one event, one verification, one dispatch row, one credit hold, one send; every request answers 202 and exactly one is `duplicate: false`.
- **Concurrent conflicting requests:** 6 requests of two contents with one key (the losers get `API_ORDER_IDEMPOTENCY_CONFLICT`) and with six keys (the losers get `API_ORDER_EXTERNAL_ID_CONFLICT`). One order and one event in both.
- **Reordered JSON keys:** the body reversed, with all four extras, replays.
- **Credential rotation:** a different key id and prefix for the same source replays the same key, conflicts on changed content, and replays under a new key.
- **Fault after commit, before the response:** a retry while the job is queued and again after it ran both answer `duplicate: true` with one dispatch; a request whose dispatch throws answers 503 `API_ORDER_DISPATCH_FAILED` with the order and event committed, and its retry queues the event and sends once.
- **Two integrations:** the same key and external id with different content create two independent orders; a new key replays each source's own order, and the other source's content is a conflict only where it differs.
- **An API key equal to a manual key:** a new order, stored as `api:<key>` beside the manual key, and the API key replays its own order.
- **File import then API, batch held, released and withdrawn** (the real upload → map → commit → start → release / stop services): identical order → `duplicate: true` and the hold state, event and verification untouched; a changed note or a dropped city → 409.
- **Import-generated `IMP-…` order number:** an API order whose `orderNumber` defaults to its external id → 409; the same request naming the `IMP-…` number → `duplicate: true`.
- **Held path:** a second held acceptance of the same reference still returns `already_imported`, for identical and for different content.

Unit: the service spec covers the no-dispatch replay, the conflict mapping, the same-key re-dispatch, the already-dispatched answer, a failed state read and the logged replay kind; `webhook-dispatch.service.spec.ts` covers every state `isAlreadyDispatched` distinguishes and pins that `dispatchById` still answers `not_claimed`; the adapter and HTTP specs cover 409 `API_ORDER_EXTERNAL_ID_CONFLICT`.

## Known gaps handed to later stories

- **A recovered same-key retry still writes a `webhook-dispatch` / `not_claimed` warning** in `WebhookDispatchService`, because `dispatchById` was left untouched. The request itself logs success. Worth quieting when the per-request log line lands in US-05-04.
- **A concurrent same-key loser trusts the winner's dispatch lease.** If the winner's enqueue then fails, the winner answers 503 and the loser has already answered 202; the event stays `dispatch_required` and the recovery sweep or the winner's retry queues it.
- **A redacted order cannot be replayed.** `redactCustomerByOrderIds` empties `rawPayload`, so a later request for that identity is a 409, not a duplicate.
- **An existing order with no acceptance event** answers 503 `*_ACCEPTANCE_FAILED`. The event is written in the same transaction as the order, so this needs a manually deleted event to occur.
- **`AcceptOneResult.held` is `false` on an external-ID replay of a held import order**: it describes this request, which held nothing. No channel exposes it.
- The application was not booted against a real database and Redis in this story.
- Throttle, body limit, error envelope and correlation ID remain US-05-04.

## Rollout and recovery

- No migration. Rollback is reverting the commit: the external-ID branch then throws `ManualOrderAcceptanceStateError` again (503), and no stored data needs repair, because replays and conflicts write nothing.
- Do not expose the endpoint to integrators before US-05-04.
