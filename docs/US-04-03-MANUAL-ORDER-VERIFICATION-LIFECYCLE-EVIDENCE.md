# US-04-03 manual order verification lifecycle evidence

**Validated:** 2026-09-05  
**Decision:** implemented locally; release remains blocked by dashboard presentation, merchant acceptance and target-environment provider validation

## Delivered behavior

- Strictly normalizes persisted Standalone schema-v1 manual events while taking organization and source identity only from the trusted queue record.
- Links each manual event to its accepted order through an additive, composite tenant-safe foreign key and preserves Shopify rows during backfill.
- Creates or reuses one verification. Non-COD and missing-payment signals are terminal ineligible results; readiness and entitlement failures are durable blocked results that can be retried after recovery.
- Applies the current initial delay and quiet hours on redispatch, then retains the existing follow-up and no-reply schedule.
- Adds local-only Standalone confirmation, customer cancellation, automatic no-reply and merchant no-reply cancellation outcomes with no external commerce request. Merchant cancellation remains terminal for late customer replies.
- Adds a per-message initial/follow-up dispatch ledger. Claim and usage reservation are transactional; provider acceptance and the verification projection are transactional; accepted, in-flight and unknown outcomes cannot send or reserve twice.
- Treats exceptions, missing provider IDs and expired send claims as `provider_outcome_unknown`. Usage remains reserved and merchant/automatic retries remain blocked until an audited staff resolution.
- Adds staff accepted/not-accepted resolution, ledger-first callback lookup with legacy fallback, and legacy `wa_message_id` backfill as `legacy_unknown` without inventing message kind.
- Extends `GET /api/orders` with a stable lifecycle object and adds owner/admin-only `POST /api/orders/:orderId/verification/retry`. The frontend has the typed contract only; US-04-04 owns rendering and controls.

## Automated validation

| Check | Result |
| --- | --- |
| Full backend Jest regression | PASS — 58 suites, 628 tests |
| Focused normalizer, lifecycle, ledger, callback, outcome and staff-resolution tests | PASS |
| PostgreSQL manual-order contract | PASS — 1 suite, 5 tests |
| PostgreSQL Shopify contract | PASS — 1 suite, 9 tests |
| PostgreSQL migration rehearsal | PASS — 1 suite, 4 tests; includes 0028 backfill, constraints and a second application |
| Backend build | PASS |
| Backend non-fixing ESLint | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in tests |
| Backend structured-log check | PASS — 0 violations |
| Frontend application typecheck | PASS |
| Frontend non-fixing ESLint | PASS |
| Frontend production build | PASS |
| E03 compatibility gate | PASS |

The tests cover eligibility, configured delay/quiet hours, follow-up/no-reply, local outcomes, late replies, concurrency and retry deduplication, quota/source recovery, unknown provider outcomes, staff resolution, authorization and tenant isolation. Standalone outcome tests assert zero Shopify or external commerce calls; Shopify characterization retains its active-connection requirement.

## Migration, rollout and rollback

With workers paused, run `0028_manual_order_lifecycle_dispatch_ledger.sql`, retain the emitted preflight/backfill counts, deploy the Standalone normalizer and ledger-aware worker, then resume workers. The migration links matching manual events, backfills legacy message IDs, and requeues only linked events previously skipped as `no_normalizer:standalone`.

Rollback is application-only: disable new manual processing and deploy the prior worker. Do not reverse the additive schema or delete accepted orders, events, dispatches or usage history.

## Remaining limits

- No production migration or target-environment worker rollout was performed.
- No live Meta send, delayed callback or staff reconciliation was performed.
- US-04-04 still owns merchant rendering and retry controls; US-04-05 owns end-to-end merchant acceptance.
- The dispatch ledger is partial US-06-02 groundwork only. Tenant connection identity, merchant sender selection, credential lifecycle and the E06 release gate remain incomplete.
