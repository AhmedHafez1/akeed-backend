# US-02-06 recoverable webhook dispatch evidence

**Validated:** 2026-09-03  
**Revision:** working tree; not committed  
**Scope:** durable webhook acceptance, source-scoped deduplication, BullMQ dispatch recovery, replay fencing, deterministic fallback identity, and operational recovery

## Acceptance evidence

1. Order webhooks are acknowledged after the PostgreSQL event is durably inserted. A BullMQ failure is recorded on that row and does not turn a durable acceptance into an HTTP failure. Redelivery and the periodic reconciler both claim and dispatch the existing row after Redis recovers.
2. Dispatch uses an atomic conditional update and a short lease. Only the claim winner can call `queue.add`; BullMQ job IDs are deterministic per event and dispatch generation: `webhook-event-<event UUID>-dispatch-<attempt>`. Processing has a separate atomic lease, so a concurrent job observes `busy`, while completed, skipped, or failed rows observe `terminal` and do not invoke business logic. A new generation lets a genuinely stale event be queued even when BullMQ retains an earlier completed collision job.
3. Retryable worker failures return the event to `pending` for BullMQ's next attempt. Exhausted worker retries remain `failed`. Expired processing leases become reconciliation candidates; completed events are never dispatch or processing candidates.
4. The unique event identity is now `(platform, store_domain, idempotency_key)`, allowing unrelated source stores to use the same provider delivery string. A missing Shopify webhook ID deterministically uses `fallback:order.create:<provider order ID>`. A missing store domain or provider order ID is rejected before persistence; no timestamp participates in identity.
5. Migration `0025_recoverable_webhook_dispatch.sql` adds dispatch attempts, errors, next-attempt time, dispatch/processing leases, and the `webhook_dispatch_health` view without exposing payloads or credentials. Automatic reconciliation is bounded to 100 rows per pass and 8 attempts by default. It is feature-gated for a dry-run-first rollout.

Synchronous billing/GDPR audit rows share `webhook_events`, so `dispatch_required` explicitly separates queue outbox records from audit-only persistence. Migration backfills only pending `order.create` rows as dispatch candidates.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `WEBHOOK_RECONCILIATION_ENABLED` | `false` | Starts the periodic reconciler after the dry run is approved. |
| `WEBHOOK_RECONCILIATION_DRY_RUN` | `false` | Reports candidate counts without claiming or enqueueing. |
| `WEBHOOK_RECONCILIATION_INTERVAL_MS` | `15000` | Delay between bounded scans. |
| `WEBHOOK_RECONCILIATION_BATCH_SIZE` | `25` (maximum 100) | Maximum candidates per scan. |
| `WEBHOOK_DISPATCH_MAX_ATTEMPTS` | `8` | Terminal dispatch threshold. |
| `WEBHOOK_DISPATCH_LEASE_MS` | `30000` | Dispatch claim lease. |
| `WEBHOOK_PROCESSING_STALE_MS` | `600000` | Legacy processing-row stale threshold when no lease exists. |

## Rollout and safe manual recovery

1. Pause webhook workers, take the normal database snapshot, deploy the compatible code, and apply migration `0025`.
2. Run `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/webhook-dispatch-dry-run.sql` and retain the grouped counts. Keep `WEBHOOK_RECONCILIATION_ENABLED=false` while reviewing unexpected stores, ages, or volumes.
3. Start with `WEBHOOK_RECONCILIATION_ENABLED=true`, `WEBHOOK_RECONCILIATION_DRY_RUN=true`, and a small batch. Confirm structured `webhook-dispatch-reconcile` logs match the SQL inventory.
4. Set `WEBHOOK_RECONCILIATION_DRY_RUN=false`, resume workers, and monitor `public.webhook_dispatch_health`. Alert on increasing oldest pending age, repeated attempts, stale processing, or any terminal dispatch failure.
5. For one investigated terminal dispatch failure, run `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -v webhook_event_id='<uuid>' -f scripts/webhook-dispatch-recover.sql`. Its predicates cannot reset completed, skipped, pending, processing, or non-dispatch failures. Confirm exactly one returned row; zero rows means stop and re-check the event.

Rollback the application by disabling reconciliation first. Leave the additive dispatch columns and source-scoped uniqueness in place so accepted rows remain observable and recoverable.

## Verification results

Run from `akeed-backend` unless noted:

| Check | Result |
| --- | --- |
| `npm test -- --runInBand` | PASS — 45 suites, 480 tests |
| Focused webhook dispatch, producer, processor, Shopify service tests | PASS — 4 suites, 29 tests |
| Updated Shopify HTTP and verification-hub regressions | PASS — 2 suites, 60 tests |
| `./scripts/test-shopify-contract.ps1` | PASS — disposable PostgreSQL 17, 9 tests; complete `0025` applied |
| `./scripts/test-source-identity-contract.ps1` | PASS — disposable PostgreSQL 17, 1 test |
| `npm run build` | PASS |
| ESLint on all changed TypeScript files | PASS — no errors or warnings |

The contract wrapper uses only a disposable PostgreSQL container on a random loopback port with synthetic data and removes only the container it created.

## Remaining release validation

- Apply `0025` to staging, retain the dry-run counts, then perform a real Redis-stop/restore drill while verifying one order, one verification, and one quota charge.
- Keep reconciliation disabled in production until the staging drill and monitoring review pass.
