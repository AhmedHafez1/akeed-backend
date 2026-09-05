# E04 — Standalone Manual Order MVP

- **Horizon:** NEXT
- **Status:** In progress — 5 of 5 implemented locally; release blocked
- **Stories:** 5
- **Prerequisite epics:** [E03 — Standalone Foundation and Onboarding](../03-standalone-foundation-and-onboarding/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Let non-Shopify merchants verify a real COD order entirely from the Akeed dashboard.

## Scope and boundaries

Session-authenticated manual creation, localized UI, shared processing, local outcomes, dashboard visibility, and merchant acceptance.

**Out of scope:** Public ingestion API, CSV, hosted forms, custom delivery connectors, and external status callbacks.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story                                                                                                                | Priority | Type         | Direct dependencies                                                                                            | Status                                |
| ---- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1    | [US-04-01 — Add session-authenticated manual order creation](US-04-01-manual-order-creation-command.md)              | P0       | Feature      | [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md) | Implemented locally — release blocked |
| 2    | [US-04-02 — Build accessible manual order entry](US-04-02-localized-manual-order-entry.md)                           | P0       | Feature      | [US-04-01](../04-standalone-manual-order-mvp/US-04-01-manual-order-creation-command.md)                        | Implemented locally — release blocked |
| 3    | [US-04-03 — Process manual orders through the shared lifecycle](US-04-03-manual-order-verification-lifecycle.md)     | P0       | Feature      | [US-04-02](../04-standalone-manual-order-mvp/US-04-02-localized-manual-order-entry.md)                         | Implemented locally — release blocked |
| 4    | [US-04-04 — Present Standalone lifecycle, usage and supported actions](US-04-04-standalone-dashboard-and-actions.md) | P0       | Feature      | [US-04-03](../04-standalone-manual-order-mvp/US-04-03-manual-order-verification-lifecycle.md)                  | Implemented locally — release blocked |
| 5    | [US-04-05 — Validate the complete Standalone merchant journey](US-04-05-manual-mvp-merchant-acceptance.md)           | P0       | Quality gate | [US-04-04](../04-standalone-manual-order-mvp/US-04-04-standalone-dashboard-and-actions.md)                     | Implemented locally — release blocked |

## Measurable exit criteria

- An Arabic or English merchant can create an order and see its verification lifecycle and usage.
- Repeated submissions and worker retries do not multiply orders, verifications, or usage.
- Unauthorized writes are denied and Shopify remains regression-compatible.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved. US-04-01 through US-04-05 are implemented locally with dated evidence; US-04-05 remains the merchant acceptance gate and is release-blocked by the missing disposable database contract, inherited migration infrastructure, authenticated target walkthrough, and authorized live pilot. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.
