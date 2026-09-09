# E05 — Standalone Order Ingestion API

- **Horizon:** NEXT
- **Status:** Backlog
- **Stories:** 6
- **Prerequisite epics:** [E04.5 — Standalone Paymob Usage-Based Billing MVP](../04.5-standalone-paymob-usage-billing/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Serve custom websites and delivery businesses through one secure server-to-server ingestion contract.

## Scope and boundaries

API-key lifecycle, POST /api/v1/orders, idempotency, abuse controls, documentation, and fault/isolation acceptance.

**Out of scope:** Browser SDK, bespoke delivery adapters, CSV automation, and generic outbound callbacks.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-05-01 — Manage integration API keys securely](US-05-01-integration-api-key-lifecycle.md) | P0 | Feature | [US-04.5-08](../04.5-standalone-paymob-usage-billing/US-04.5-08-sandbox-and-production-release-gate.md) | Backlog |
| 2 | [US-05-02 — Accept orders through the Standalone ingestion API](US-05-02-authenticated-order-ingestion-endpoint.md) | P0 | Feature | [US-05-01](../05-standalone-order-ingestion-api/US-05-01-integration-api-key-lifecycle.md) | Backlog |
| 3 | [US-05-03 — Make API retries idempotent and conflict-safe](US-05-03-idempotency-and-conflict-handling.md) | P0 | Technical enabler | [US-05-02](../05-standalone-order-ingestion-api/US-05-02-authenticated-order-ingestion-endpoint.md) | Backlog |
| 4 | [US-05-04 — Add API abuse controls and safe operational errors](US-05-04-api-abuse-controls-and-audit.md) | P0 | Technical enabler | [US-05-03](../05-standalone-order-ingestion-api/US-05-03-idempotency-and-conflict-handling.md) | Backlog |
| 5 | [US-05-05 — Publish server-side integration guidance](US-05-05-server-integration-guide.md) | P1 | Feature | [US-05-04](../05-standalone-order-ingestion-api/US-05-04-api-abuse-controls-and-audit.md) | Backlog |
| 6 | [US-05-06 — Verify API tenant isolation and failure recovery](US-05-06-api-security-and-recovery-release-gate.md) | P0 | Quality gate | [US-05-05](../05-standalone-order-ingestion-api/US-05-05-server-integration-guide.md) | Backlog |

## Measurable exit criteria

- Valid clients can durably submit orders and safely retry lost responses.
- Keys, orders, idempotency results, usage, and errors cannot cross tenants.
- Revocation, throttling, conflicting replay, and outage recovery pass automated acceptance.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

