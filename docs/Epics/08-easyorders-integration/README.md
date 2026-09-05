# E08 — EasyOrders Integration

- **Horizon:** NEXT
- **Status:** Backlog
- **Stories:** 6
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md), [E03 — Standalone Foundation and Onboarding](../03-standalone-foundation-and-onboarding/README.md), [E05 — Standalone Order Ingestion API](../05-standalone-order-ingestion-api/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Connect EasyOrders merchants through a native adapter that reuses the verified common workflow.

## Scope and boundaries

Provider validation, authorized connection, secure credentials, webhook normalization, status outcomes, onboarding health, and pilot acceptance.

**Out of scope:** Merchant-owned WhatsApp as a prerequisite, source switching, catalog/shipping integrations, and bespoke merchant workflows.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-08-01 — Validate EasyOrders authorization and event semantics](US-08-01-easyorders-integration-validation.md) | P0 | Validation spike | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md) | Backlog |
| 2 | [US-08-02 — Connect EasyOrders and secure its credentials](US-08-02-easyorders-authorized-connection.md) | P0 | Feature | [US-08-01](../08-easyorders-integration/US-08-01-easyorders-integration-validation.md) | Backlog |
| 3 | [US-08-03 — Ingest and normalize EasyOrders order webhooks](US-08-03-easyorders-webhook-ingestion.md) | P0 | Feature | [US-08-02](../08-easyorders-integration/US-08-02-easyorders-authorized-connection.md) | Backlog |
| 4 | [US-08-04 — Synchronize approved outcomes to EasyOrders](US-08-04-easyorders-outcome-status-adapter.md) | P0 | Feature | [US-08-03](../08-easyorders-integration/US-08-03-easyorders-webhook-ingestion.md) | Backlog |
| 5 | [US-08-05 — Provide EasyOrders setup and connection-health guidance](US-08-05-easyorders-onboarding-health-and-disconnect.md) | P1 | Feature | [US-08-04](../08-easyorders-integration/US-08-04-easyorders-outcome-status-adapter.md) | Backlog |
| 6 | [US-08-06 — Qualify the EasyOrders adapter for pilot release](US-08-06-easyorders-contract-and-pilot-release-gate.md) | P0 | Quality gate | [US-08-05](../08-easyorders-integration/US-08-05-easyorders-onboarding-health-and-disconnect.md) | Backlog |

## Measurable exit criteria

- Provider authentication and event semantics are validated before enabling live ingestion.
- A pilot order moves from EasyOrders to Akeed and back through the approved status mapping.
- Rate-limit recovery, revocation, disconnects, and tenant isolation pass contract and live-pilot checks.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

E06/E07 are not prerequisites: EasyOrders can use the existing Akeed sender. Native pilots use fresh/unprovisioned organizations, not active-source replacement.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

