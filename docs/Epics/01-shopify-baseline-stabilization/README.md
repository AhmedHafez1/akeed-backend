# E01 — Shopify Baseline Stabilization

- **Horizon:** NOW
- **Status:** Complete — packages A/B/C and US-01-06 validated 2026-08-31
- **Stories:** 6
- **Prerequisite epics:** None
- **Roadmap:** [Expansion backlog](../README.md)

**Adopted delivery plan (2026-08-31):** [Scope review and implementation plan](REVIEW-AND-IMPLEMENTATION-PLAN.md) is implemented as package A (US-01-01), B (US-01-02/03), C (US-01-04/05), and the US-01-06 release gate. See the [single implementation evidence record](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md) for tests, repeated release checks and known limitations.

**Closure validation (2026-08-31):** The repeated automated gate passes: 354 backend tests, 5 isolated PostgreSQL contracts, backend build/full types/non-fixing lint and frontend types/build/lint. Authenticated Chrome checks cover both modes and locales using the owner's existing development sessions; standalone organization bootstrap passes. Two frontend smoke findings are fixed: the standalone settings Polaris-loader crash and embedded preview key warning. Eight isolated cancellation sequences pass through the real hooks/tables with providers excluded. Transient development failures and remaining baseline limitations are preserved in the evidence. This completes E01's compatibility gate, not a deployment or live-provider reliability approval.

## Business objective

Protect the revenue-producing Shopify workflow with deterministic evidence before changing shared architecture.

## Scope and boundaries

Test baseline, webhook and normalization characterization, lifecycle semantics, entitlement/automation compatibility, and dual-mode release checks.

**Out of scope:** Platform refactoring, new integrations, tenant-owned senders and billing/provider behavior changes. Closure includes the two small frontend rendering corrections found by the required smoke gate; production billing and Shopify GraphQL behavior remain unchanged.

## Prioritized user stories

Package A precedes B and C; B and C are independent. Delivery ranks remain traceability labels rather than artificial sequential dependencies. US-01-06 requires all five implementation stories.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-01-01 — Establish a deterministic test baseline](US-01-01-deterministic-test-baseline.md) | P0 | Technical enabler | None | Complete |
| 2 | [US-01-02 — Characterize Shopify webhook security and duplicates](US-01-02-shopify-webhook-characterization.md) | P0 | Quality gate | US-01-01 | Complete |
| 3 | [US-01-03 — Protect Shopify normalization and COD eligibility](US-01-03-normalization-and-cod-fixtures.md) | P0 | Quality gate | US-01-01 | Complete |
| 4 | [US-01-04 — Protect Shopify confirmation and cancellation semantics](US-01-04-shopify-outcome-semantics.md) | P0 | Quality gate | US-01-01 | Complete |
| 5 | [US-01-05 — Protect entitlement, automation and the Akeed sender](US-01-05-entitlement-automation-sender-compatibility.md) | P0 | Quality gate | US-01-01 | Complete |
| 6 | [US-01-06 — Establish the dual-mode regression release gate](US-01-06-dual-mode-regression-release-gate.md) | P0 | Quality gate | US-01-01 through US-01-05 | Complete |

## Measurable exit criteria

- Backend regression suite is green with a deterministic clock and no weakened assertions.
- Fixtures protect all existing Shopify outcomes and billing/send invariants.
- Both frontend modes have recorded smoke results and a repeatable release checklist.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved. E01 implementation and release-gate evidence is dated 2026-08-31 and identifies the actual commits plus uncommitted closure changes. The prior review and 2026-08-30 baseline remain historical. Characterization and browser checks do not establish live-provider readiness, recoverable dispatch or exactly-once sending; the linked E02/E06 repairs remain open.
