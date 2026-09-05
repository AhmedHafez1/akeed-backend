# US-04-04 standalone dashboard and actions evidence

**Validated:** 2026-09-05  
**Decision:** implemented locally; release remains blocked by US-04-05 merchant acceptance and target-environment provider validation

## Delivered behavior

- `GET /api/orders` now reports every organization-owned order through one SQL lifecycle projection. It supports merchant-local date ranges, exact comma-separated lifecycle filters, stable `(created_at,id)` cursor pagination, filter-aware totals, source identity, synthetic test labels, nullable verification details, capability-driven actions and page context.
- `GET /api/orders/stats` returns reconciled order totals, a separate verification summary, source/automation context, billing-period usage independent of the selected reporting range, localized-dashboard inputs and savings.
- Reporting uses the active source timezone, then the newest disconnected source timezone, then UTC. Local calendar bounds remain correct across DST transitions. Queries retain inactive-source history and are organization-scoped.
- Standalone now presents an order list at the existing confirmations URL. It renders orders without verifications, exact lifecycle badges and localized explanations, synthetic badges, retry and supported local cancellation actions, read-only permissions, loading/empty/error feedback and RTL-safe controls. Actions refetch server rows and totals after completion.
- English and Arabic messages include an exact 82-key `dashboard.orders` namespace. Lifecycle, reason, action, status, empty, loading, success, blocked, failed and read-only copy are mapped without rendering raw provider reasons. Date, number, percentage and currency formatting use the active locale and reporting timezone.
- Embedded Shopify hooks, endpoints, table behavior and existing translations remain intact. Standalone cancellation copy states that only Akeed is updated.

## Automated validation

| Check | Result |
| --- | --- |
| Focused backend orders/date-range tests | PASS — 3 suites, 41 tests |
| Backend full regression | PASS — 59 suites, 642 tests on the 2026-09-05 run before the final retryability-precedence edge fix; the post-fix rerun reached the same 59/642 count before stopping at the platform migration because Docker was unavailable in the shell environment |
| Backend build | PASS |
| Backend non-fixing lint | PASS — 0 errors; existing warnings only |
| Structured-log contract | PASS — 0 violations |
| E02 compatibility gate | PASS |
| E03 release gate | PASS — includes E02, 77 tenant/role tests, standalone provisioning (7), and standalone pilot (8) PostgreSQL contracts; the post-fix rerun reached the full 59/642 backend suite before the Docker-dependent platform migration step was unavailable |
| Manual-order PostgreSQL contract | PASS — 1 suite, 6 tests on the earlier disposable PostgreSQL run; the final post-fix rerun was unavailable because Docker was not executable in the shell environment |
| Frontend application typecheck | PASS |
| Frontend isolated fixture typecheck | PASS |
| Frontend non-fixing ESLint | PASS |
| Frontend production build | PASS — 19 routes |
| Locale message parsing | PASS — 1,141 English and 1,127 Arabic ICU messages; `dashboard.orders` 82/82 with no missing keys |
| Dual-mode fixture smoke | PASS — English/Arabic, RTL, viewer read-only, lifecycle filters, retry/cancel loading and feedback, immediate list/stats refresh, and embedded Shopify cancellation behavior inspected |

The PostgreSQL fixture covers two tenants, orders with and without verifications, lifecycle groups, synthetic rows, inactive-source history, date edges, pagination, totals/stat reconciliation and tenant filtering. The repository contract also asserts that in-flight and outcome-unknown rows do not expose retryability; the assertion is included in source and should be rerun when Docker is available.

## Remaining limits

- No production migration is required or performed for this story.
- No live Meta/provider send, callback reconciliation or target-environment rollout was performed.
- US-04-05 remains the merchant acceptance gate. External provider validation remains a release block.
