# E02 — Platform Boundaries and Reliability

- **Horizon:** NOW
- **Status:** Implemented locally — release blocked on staging migration/Redis drill and authenticated validation
- **Stories:** 7
- **Prerequisite epics:** [E01 — Shopify Baseline Stabilization](../01-shopify-baseline-stabilization/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Allow new commerce sources without directing their orders into Shopify or losing accepted work.

## Scope and boundaries

Canonical contracts, outcome registry, Shopify compatibility, billing separation, source identity, disconnect safety, and recoverable queue dispatch.

**Out of scope:** Native adapters, new payment providers, microservices, multi-source product support, and broad rewrites.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-02-01 — Define platform-neutral source and order contracts](US-02-01-canonical-commerce-source-contracts.md) | P0 | Technical enabler | [US-01-06](../01-shopify-baseline-stabilization/US-01-06-dual-mode-regression-release-gate.md) | Backlog |
| 2 | [US-02-02 — Introduce capability-aware commerce outcome dispatch](US-02-02-commerce-outcome-adapter-registry.md) | P0 | Technical enabler | [US-02-01](../02-platform-boundaries-and-reliability/US-02-01-canonical-commerce-source-contracts.md) | Implemented — contract environment pending |
| 3 | [US-02-03 — Move Shopify actions behind the adapter](US-02-03-shopify-adapter-and-core-decoupling.md) | P0 | Technical enabler | [US-02-02](../02-platform-boundaries-and-reliability/US-02-02-commerce-outcome-adapter-registry.md) | Implemented — contract environment pending |
| 4 | [US-02-04 — Separate Shopify billing from verification entitlement](US-02-04-provider-neutral-entitlements.md) | P0 | Technical enabler | [US-02-03](../02-platform-boundaries-and-reliability/US-02-03-shopify-adapter-and-core-decoupling.md) | Backlog |
| 5 | [US-02-05 — Enforce source-scoped identity and preserve history](US-02-05-source-identity-and-safe-disconnect.md) | P0 | Technical enabler | [US-02-04](../02-platform-boundaries-and-reliability/US-02-04-provider-neutral-entitlements.md) | Implemented — staging migration and authenticated validation pending |
| 6 | [US-02-06 — Recover events after queue dispatch failure](US-02-06-recoverable-webhook-dispatch.md) | P0 | Technical enabler | [US-02-05](../02-platform-boundaries-and-reliability/US-02-05-source-identity-and-safe-disconnect.md) | Implemented — staging migration and Redis outage drill pending |
| 7 | [US-02-07 — Verify adapter independence and migration compatibility](US-02-07-platform-boundary-release-gate.md) | P0 | Quality gate | [US-02-06](../02-platform-boundaries-and-reliability/US-02-06-recoverable-webhook-dispatch.md) | Implemented — external release validation pending |

## Measurable exit criteria

- Core workflow tests run without Shopify services and all Shopify characterization tests pass.
- Source identity and normal disconnect preserve tenant isolation and historical data.
- A database-success/queue-failure drill recovers accepted events without duplicate verification or usage.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.
