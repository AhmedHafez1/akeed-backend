# E03 — Standalone Foundation and Onboarding

- **Horizon:** NOW
- **Status:** Implemented locally — release blocked
- **Stories:** 5
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Turn Standalone authentication and dashboard skins into a usable merchant account with its own commerce source.

## Scope and boundaries

Source provisioning, eligibility, manual/free entitlement, onboarding/settings, test sending, and source/role guards.

**Out of scope:** Real-order entry, public API keys, payment-provider integration, and source switching.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-03-01 — Provision a first-class Standalone commerce source](US-03-01-standalone-source-provisioning.md) | P0 | Feature | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md) | Implemented locally — release blocked |
| 2 | [US-03-02 — Activate pilot entitlements and backfill Standalone accounts](US-03-02-pilot-entitlements-and-backfill.md) | P0 | Technical enabler | [US-03-01](../03-standalone-foundation-and-onboarding/US-03-01-standalone-source-provisioning.md) | Implemented locally — release blocked |
| 3 | [US-03-03 — Deliver Standalone onboarding and source settings](US-03-03-standalone-onboarding-and-settings.md) | P0 | Feature | [US-03-02](../03-standalone-foundation-and-onboarding/US-03-02-pilot-entitlements-and-backfill.md) | Implemented locally — release blocked |
| 4 | [US-03-04 — Enable Standalone test verification through Akeed](US-03-04-standalone-test-verification.md) | P0 | Feature | [US-03-03](../03-standalone-foundation-and-onboarding/US-03-03-standalone-onboarding-and-settings.md) | Implemented locally — release blocked |
| 5 | [US-03-05 — Enforce organization roles and one primary source](US-03-05-standalone-tenant-and-primary-source-guards.md) | P0 | Quality gate | [US-03-04](../03-standalone-foundation-and-onboarding/US-03-04-standalone-test-verification.md) | Implemented locally — release blocked |

## Measurable exit criteria

- A new Supabase merchant completes onboarding and a test send without any Shopify integration.
- Backfill is idempotent and leaves Shopify merchants unchanged.
- Owner/admin and viewer permissions, entitlement readiness, and one-source rules pass isolation tests.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved. US-03-01 through US-03-05 are implemented locally; story-level evidence distinguishes fresh local validation from unrun target-environment gates and external dependencies. E03 is not released.
