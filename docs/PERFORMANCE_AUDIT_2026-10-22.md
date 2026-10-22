# Akeed performance audit — 22 October 2026

## Assessment and boundaries

The processing architecture has useful safeguards: bounded PostgreSQL pools, cursor pagination, batched customer-history reads, durable Shopify ingestion and dispatch claims, idempotent message accounting, separate import queues, and workbook parsing in worker threads. The first batch removes redundant dashboard reads and duplicate App Bridge acquisition calls. It changes neither order state transitions nor financial accounting.

Production latency, queue age, RSS, deployed configuration, and hosting headroom were not measured. The merchant count and hosting plans are supplied project context, not independently verified deployment telemetry. Local measurements below must not be interpreted as Railway/Supabase capacity guarantees.

Baseline revisions: backend `547fa12cd108028ebfde8b55dd9b77a0d19ddc31`, frontend `fc7ba477478b0d0297a1a17a1fbb12bd1452e6ba`. Both worktrees were clean when implementation began; earlier capacity-recovery work and its dashboard mock correction had already been committed. Revision, working-diff hashes, and unchanged source snapshots are recorded in `.tmp/performance-audit/baseline/`.

## Coverage and ranked findings

Review combined source-wide searches with request-to-repository and producer-to-worker tracing. It covered backend modules/shared infrastructure, database schema and migrations, auth, platform ingress/outcomes, billing/credit boundaries, scheduled recovery and retention, frontend layouts/routes, authenticated transports, query hooks and cache lifecycle. Findings concern inspected code; they are not claims that every execution branch was profiled.

| Priority | Root cause / affected code | Evidence and impact | Treatment, benefit and risk |
| --- | --- | --- | --- |
| First batch | `src/modules/verifications/verifications.service.ts`: `listByOrg` performed `countByOrg` alongside `countByTab`, including when the predicates were equivalent. | Verified duplicate aggregate read for unsearched lists without an explicit status filter. Repeated for each paginated request and polling refresh. | Reuse the existing selected-tab aggregate; retain filtered counts for explicit statuses/searches. One fewer SQL statement per eligible request. Low risk; tenant, batch and held-order behavior covered by tests. |
| First batch | Same service: outcome synchronization and customer history were awaited in sequence after page selection. | Verified independent reads on the response critical path; controlled-latency benchmark isolates the effect. History was already batched, not an N+1 query. | Run both reads through `Promise.all`, retaining optional synchronization and error propagation. Saves an enrichment stage when pool capacity is available. Low risk. |
| First batch | `akeed-frontend/src/shared/lib/auth.ts`: the token cache stored completed tokens, but no pending acquisition. | Verified eight simultaneous cold requests invoked App Bridge eight times. These are SDK calls; SDK-internal network behavior was not measured. | Share pending acquisition within the shop/host context; retain expiry margins, priming and one 401 retry. Eight calls become one. Generation checks preserve newer primed tokens; stale 401s cannot invalidate newer credentials. Requests awaiting credentials are canceled if the shop changes. Low risk with race tests. |
| High operational risk; deferred | `src/infrastructure/spokes/meta/whatsapp.service.ts`, `meta.module.ts`, and `shopify/services/shopify-api.service.ts` / `shopify-commerce.module.ts`: outbound sends/GraphQL calls have no explicit HTTP deadline. | Confirmed configuration gap; a stalled provider can hold worker capacity. Production incidence and an appropriate deadline are unmeasured. | Review provider deadlines separately. WhatsApp timeouts must retain `outcome_unknown` and no automatic resend; Shopify billing/cancellation mutations need operation-specific ambiguity handling. Medium implementation risk; excluded from this batch. |
| Medium; deferred | `src/shared/guards/payment-callback-rate-limit.guard.ts` and `billing-callback-rate-limit.guard.ts`: threshold-triggered cleanup only removes expired entries. | The payment guard retained 6,000 active synthetic keys despite its 5,000-key cleanup threshold. Above the threshold, repeated sweeps add linear work. This is a growth risk, not evidence of a production leak. | Define bounded admission and expiry cleanup without evicting active limits or bypassing throttling. Changes rejection policy and needs separate review. |
| Medium; deferred | `meta/whatsapp.webhook.controller.ts` / `whatsapp.webhook.service.ts`: ingress awaits sequential message/status processing and returns HTTP 200 even after processing errors. | Verified behavior; database work delays acknowledgement, and a caught failure can be acknowledged without durable ingress capture. No production losses established. | A durable ingress design could improve burst handling and recovery, but changes ordering, acknowledgement and replay behavior. Architectural approval required. |
| Investigate | `verifications.repository.ts`, `verification-needs-action.sql.ts`: separate overview aggregates, correlated test-order checks, and normalized substring search. | Query shapes verified. Ordinary column indexes do not directly answer the `regexp_replace` substring predicate; the tenant/date filter still bounds candidates. Existing organization/date/id and provider-message indexes were checked. | Use representative query plans before considering composite/expression indexes or aggregate changes. No new production index or migration in this batch. |
| Investigate | Frontend `verificationQueries.ts`, `useDashboardData.ts`, `useConfirmationsList.ts`, `useDashboardOverview.ts`, and import query hooks. | Lists refetch loaded pages while awaiting outcomes; overview and import queries have separate polls. React Query already deduplicates matching keys and clears tenant data when the standalone user changes. | Measure long sessions with multiple loaded pages before changing freshness or pagination behavior. No polling, cache-key or UX change in this batch. |
| Investigate | Dashboard route/shared layout and feature barrels; backend auth logging; co-hosted queue processors and import parser. | Dashboard manifest entry JavaScript is substantial; both mode skins are reachable from the route. Successful auth is logged per request. Worker concurrency spans multiple queues while database pool slots are shared; parsing permits two workers with separate heap ceilings. | Profile route/module contribution, log bytes, RSS and oldest-job age. Do not increase pool/worker limits, remove operational logs, or change parsing limits without measurements. No retained-memory leak was established. |

Existing Shopify webhook persistence/deduplication, queue backoff/retention, tenant predicates, provider-outcome claims, credit reservations, scheduler identities, reconciler overlap guards and shutdown cleanup were preserved. No application bootstrap, production load test, production query, external message send, dependency addition or production migration was performed.

## Implemented changes and validation

Application changes are confined to the verification list service and frontend authenticated transport. Tests are in `verifications.list-performance.spec.ts`, the existing service/overview contracts, and `akeed-frontend/src/shared/lib/auth.session-token.test.ts`.

Acceptance covers all tabs, normalized searches, explicit statuses, held-only/mixed pages, batch filters, empty organizations, cursor ties, tenant isolation, concurrent enrichment, read failures, optional synchronization, cold/warm tokens, expiry/fallback TTL, acquisition failures, concurrent/late 401s, priming, context changes and standalone auth. The pre-existing mock correction was already present and was not reimplemented.

Validation: all **7,155 backend unit tests across 301 suites** and **1,849 frontend tests across 151 files** passed. All **30 disposable PostgreSQL contract/benchmark tests** passed, including the new tab-count and cross-tenant import checks. Both production builds and TypeScript checks passed. Repository-wide non-fixing lint followed by changed-file rechecks found **zero errors**, with 20 existing backend warnings and one existing frontend unused-import warning. Changed source, tests and benchmark scripts also passed formatting checks.

## Before/after results

### Real PostgreSQL, same data and four-connection pool

The actual service and repository were exercised on PostgreSQL 17 with 14 synthetic tenants × 500 orders each. Entitlement reads were stubbed; optional outcome-sync enrichment was absent in this scenario. This fixture therefore isolates the aggregate-count saving; the controlled-read benchmark below includes both enrichment reads.

| Concurrent requests | SQL statements/request | p50 before → after | p95 before → after | Event-loop p95 before → after |
| --- | --- | --- | --- | --- |
| 1 | 7 → 6 | 25.61 → 22.78 ms | 31.65 → 29.91 ms | 11.46 → 11.21 ms |
| 4 | 7 → 6 | 79.78 → 74.05 ms | 89.78 → 91.23 ms | 19.35 → 20.05 ms |
| 8 | 7 → 6 | 147.43 → 139.80 ms | 177.87 → 177.75 ms | 20.33 → 24.30 ms |

The stable result is **one fewer SQL statement (14.3% in this fixture)**. Median latency improved approximately 5–11%; tail latency was mixed, including a small increase at concurrency four. No uniform p95 or event-loop improvement is claimed.

Query plans used `idx_verifications_org_created_id` for page retrieval, `idx_verifications_org_created_status` for aggregation, primary/unique order indexes for joins, and `idx_orders_phone` for history. Captured SQL execution times were approximately 0.85 ms for the page, 1.07 ms for tab counts, and 0.39 ms for customer history. The aggregate still performs correlated test-order checks (1,626 shared-buffer hits in this fixture); it remains a profiling candidate rather than justification for a migration. A sequential scan of the tiny integrations table cost approximately 0.06 ms and is not a demonstrated bottleneck.

Observed SQL-harness peak heap ranged from 144.7–156.2 MiB before and 150.4–156.7 MiB after; peak RSS ranged from 254.1–280.4 MiB before and 259.7–285.3 MiB after. These samples include Jest, compilation and garbage collection in a reused process. They establish neither a memory regression in the application nor a memory-saving result. Windows timer resolution and harness work also affect event-loop readings.

### Controlled repository latency

Actual `listByOrg`, 14 synthetic tenants × 1,000 in-memory rows, mocked 20 ms reads, and a ten-slot synthetic pool:

| Concurrent requests | Read calls/request | p50 before → after | p95 before → after |
| --- | --- | --- | --- |
| 1 | 8 → 7 | 127.01 → 95.28 ms | 128.16 → 96.53 ms |
| 4 | 8 → 7 | 159.59 → 124.41 ms | 189.58 → 143.54 ms |
| 8 | 8 → 7 | 223.81 → 190.61 ms | 255.03 → 217.10 ms |

This demonstrates removal of a dependent wait stage when enrichment reads can overlap. It is a synthetic causality check, not a production response-time forecast. JSON also records observed memory and event-loop percentiles for every scenario.

### Frontend work and payload

Eight concurrent cold requests now require **one App Bridge acquisition instead of eight** (87.5% fewer SDK calls); four concurrent requests require one instead of four. Warm-cache reuse and the existing expiry policy are preserved. A regression test also verifies that warm requests retain the original two context-storage writes rather than adding repeated context resolution.

| Concurrent requests | SDK calls/batch | p50 before → after | p95 before → after |
| --- | --- | --- | --- |
| 1 | 1 → 1 | 31.54 → 30.53 ms | 32.24 → 33.51 ms |
| 4 | 4 → 1 | 31.29 → 25.15 ms | 32.37 → 32.09 ms |
| 8 | 8 → 1 | 31.33 → 31.25 ms | 32.08 → 32.57 ms |

With a mocked 20 ms provider, requests already waited for SDK calls concurrently before this change. Times vary with Windows timers and runtime scheduling; no frontend latency or memory improvement is claimed. The verified saving is SDK work, including shared refresh and protection against stale generations even when App Bridge returns an identical token string.

The dashboard manifest contained 20 entry JavaScript files in both builds. Payload changed from 2,785,165 to 2,788,072 raw bytes and 710,089 to 710,904 gzip bytes: **+815 gzip bytes**, approximately 0.11%, for the authentication safeguards. These totals exclude runtime-loaded chunks and are not browser transfer measurements. No bundle-size reduction is claimed.

## Reproduction

Runtime: Node 22.22.0 on Windows x64. Benchmarks use five warmup batches and twenty measured batches at concurrency 1, 4 and 8. Per-request latency samples include queue waits. Provider calls are mocked; synthetic read delays model causality, not real network latency. Heap/RSS samples include the test/runtime machinery, and are not memory-leak or memory-saving evidence.

From the backend directory, reproduce saved-code comparisons with the same harness and explicit revisions:

```powershell
node --expose-gc scripts/perf/performance-audit.cjs --target=backend --ref=547fa12cd108028ebfde8b55dd9b77a0d19ddc31 --output=D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/backend-before.json
node --expose-gc scripts/perf/performance-audit.cjs --target=backend --source=D:/Software_Development/Akeed/akeed-backend/src/modules/verifications/verifications.service.ts --output=D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/backend-after.json
node --expose-gc scripts/perf/performance-audit.cjs --target=frontend --ref=fc7ba477478b0d0297a1a17a1fbb12bd1452e6ba --output=D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/frontend-before.json
node --expose-gc scripts/perf/performance-audit.cjs --target=frontend --source=D:/Software_Development/Akeed/akeed-frontend/src/shared/lib/auth.ts --output=D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/frontend-after.json
```

The PostgreSQL benchmark reuses the existing dashboard contract scaffold. Its URL guard requires loopback PostgreSQL, database `akeed_e01_test`, and user `e01_test`; application `DATABASE_URL` is never used. It seeds 14 synthetic tenants with 500 orders/verifications each, uses a four-connection test pool, and creates only existing-equivalent indexes inside the disposable namespace. It compares both service versions against the same data, checks identical responses, and saves `EXPLAIN (ANALYZE, BUFFERS)` plans.

```powershell
$env:PERFORMANCE_AUDIT_BASELINE_SOURCE = 'D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/baseline/verifications.service.ts'
$env:PERFORMANCE_AUDIT_SQL_OUTPUT = 'D:/Software_Development/Akeed/akeed-backend/.tmp/performance-audit/sql-benchmark.json'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-verification-overview-contract.ps1
Remove-Item Env:PERFORMANCE_AUDIT_SQL_OUTPUT,Env:PERFORMANCE_AUDIT_BASELINE_SOURCE
```

Without the optional benchmark variables, the normal SQL contracts run and the performance test is skipped. If reconstructing the saved baseline on another checkout, obtain that file from the backend revision above. JSON measurements and validation logs live in `.tmp/performance-audit/` and are intentionally untracked.
