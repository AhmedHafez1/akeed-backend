# US-01-06 — Establish the dual-mode regression release gate

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Complete — repeated automated and dual-mode browser gate validated 2026-08-31
- **Dependencies:** [US-01-01](US-01-01-deterministic-test-baseline.md), [US-01-02](US-01-02-shopify-webhook-characterization.md), [US-01-03](US-01-03-normalization-and-cod-fixtures.md), [US-01-04](US-01-04-shopify-outcome-semantics.md), [US-01-05](US-01-05-entitlement-automation-sender-compatibility.md)

## User story and value

As a release owner, I want a repeatable Shopify and Standalone smoke checklist, so that shared changes cannot break authentication, layouts or merchant operations unnoticed.

**Business value:** Shared changes cannot break authentication, layouts or merchant operations unnoticed.

## Scope

Combine E01 evidence with embedded/Standalone smoke checks and repeatable validation commands.

**Out of scope:** Claiming Standalone order ingestion already works or selecting a new frontend test framework.

## Acceptance criteria

1. The gate runs backend tests and frontend typecheck/build plus non-fixing lint where available, recording outcomes separately.
2. Shopify smoke checks cover authentication, onboarding/billing status, dashboard, settings and merchant cancellation feedback.
3. Standalone smoke checks cover Supabase sign-in, organization provisioning, layout and existing empty/error states without asserting future features.
4. Arabic RTL and English LTR navigation are checked; any failure records an owner and blocks release of the affected change.

## Implementation notes

- **Backend:** Use existing Jest infrastructure; keep destructive live actions mocked or confined to authorized test stores.
- **Frontend:** Use current tools and a documented browser/manual checklist where no runner exists.
- **Data:** Use synthetic tenant accounts and preserve existing repository state.
- **Operations:** Publish gate commands and required evidence; distinguish code findings from older prose, including existing GraphQL usage.

## Test requirements

- Execute the full E01 suite and both-mode smoke checklist.
- Confirm no skipped tests, hidden failures or credential output.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Gate adoption is complete when a second run is reproducible from the documented instructions.

## Evidence and references

**Implementation evidence (2026-08-31):** [Single E01 evidence record and repeatable release checklist](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). The backend gate passed twice with 354 tests and 5 separate PostgreSQL contracts; frontend types/build/lint passed twice after fixing the standalone settings loader crash and embedded preview key warning. The owner's authenticated Chrome sessions enabled actual Shopify and standalone checks in English/LTR and Arabic/RTL, including existing organization bootstrap, onboarding/billing visibility, dashboard, settings and navigation. [Isolated frontend cancellation tooling](../../akeed-frontend/test/e01-smoke/README.md) exercised the real hooks/tables in both skins/locales twice (8/8 sequences) with no provider calls. Existing sessions were reused; no fresh password submission or new organization creation is claimed. Earlier environment failures, a recovered development chunk failure, transient onboarding errors and retained warnings remain documented rather than suppressed. No live messages, subscriptions, refunds, cancellations or application migrations were submitted by the agent.

**VERIFIED FROM CODE:** The repositories provide Jest backend tests and frontend TypeScript/build commands; frontend guidelines require both modes and both locales.

- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)
- [akeed-frontend/src/shared/lib/auth.ts](../../akeed-frontend/src/shared/lib/auth.ts)
- [akeed-frontend/src/features/dashboard](../../akeed-frontend/src/features/dashboard)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
