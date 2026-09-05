# US-01-01 — Establish a deterministic test baseline

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Complete — evidence validated 2026-08-31; US-01-06 gate completed
- **Dependencies:** None — first story in the approved roadmap.

## User story and value

As a release owner, I want billing-period tests to use a controlled clock, so that calendar changes do not masquerade as product regressions.

**Business value:** Calendar changes do not masquerade as product regressions.

## Scope

Reproduce and repair the stale onboarding billing-period assertion; record repeatable baseline commands.

**Out of scope:** Changing billing windows or weakening assertions to make tests pass.

## Acceptance criteria

1. The 2026-08-30 result (242/243 backend tests passing; frontend TypeScript passing) is labelled historical; fresh results include execution date and commit.
2. The failing onboarding spec passes with time explicitly frozen or injected and restores the clock after each test.
3. The same assertions pass at controlled UTC dates immediately before and at the billing-period boundary; the host operating-system clock is unchanged.
4. The full backend suite and frontend typecheck are run without modifying application billing behavior or disabling tests.

## Implementation notes

- **Backend:** Use Jest clock controls or the existing clock seam in the onboarding test; keep business assertions intact.
- **Frontend:** Run the existing TypeScript check; do not introduce a frontend test framework solely for this story.
- **Data:** No schema or production-data changes.
- **Operations:** Record exact commands, tool versions, failures, and exit codes in the implementation evidence.

## Test requirements

- Run the affected spec independently and in the full suite.
- Repeat with different system-date assumptions; verify clock cleanup prevents order-dependent failures.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Test-only change; any newly discovered failure blocks the baseline gate and is reported separately.

## Evidence and references

**Implementation evidence (2026-08-31):** [E01 evidence and release checklist](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). Package A passes with a frozen May 15 clock and explicit May 31 boundary expectations. Production billing code is unchanged.

**VERIFIED FROM CODE:** The onboarding spec uses a May 2026 activation/period expectation. The previous repository assessment recorded one real-clock-dependent failure.

- [akeed-backend/src/modules/onboarding/onboarding.service.spec.ts](../../akeed-backend/src/modules/onboarding/onboarding.service.spec.ts)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
