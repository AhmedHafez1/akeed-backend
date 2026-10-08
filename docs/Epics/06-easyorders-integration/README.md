# E06 — EasyOrders Integration

- **Horizon:** NEXT
- **Status:** Done — gate closed, ready for deploy (2026-10-08). All six stories are implemented and the US-06-06 gate is closed on the product owner's end-to-end test report. The adapter ships behind its three switches, all off by default; step-level pilot records are not in this repository (see the [gate evidence](evidence/US-06-06-release-gate.md#closure-2026-10-08)).
- **Stories:** 6
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md), [E03 — Standalone Foundation and Onboarding](../03-standalone-foundation-and-onboarding/README.md), [E05 — Standalone Order Ingestion API](../05-standalone-order-ingestion-api/README.md) (Done; shipped 2026-10-02, validated 2026-10-03)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Connect EasyOrders merchants through a native adapter that reuses the verified common workflow.

## Scope and boundaries

Provider validation, authorized connection, secure credentials, webhook normalization, status outcomes, onboarding health, and pilot acceptance.

**Out of scope:** Source switching, catalog/shipping integrations, and bespoke merchant workflows.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-06-01 — Validate EasyOrders authorization and event semantics](US-06-01-easyorders-integration-validation.md) | P0 | Validation spike | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md) (satisfied) | Done (2026-10-08) — [contract record](evidence/US-06-01-contract-record.md) written 2026-10-03; live verification accepted on the product owner's end-to-end report |
| 2 | [US-06-02 — Connect EasyOrders and secure its credentials](US-06-02-easyorders-authorized-connection.md) | P0 | Feature | [US-06-01](../06-easyorders-integration/US-06-01-easyorders-integration-validation.md) | Done — ready for deploy (2026-10-08) — [evidence](../../US-06-02-EASYORDERS-CONNECTION-EVIDENCE.md); behind `EASYORDERS_CONNECT_ENABLED` |
| 3 | [US-06-03 — Ingest and normalize EasyOrders order webhooks](US-06-03-easyorders-webhook-ingestion.md) | P0 | Feature | [US-06-02](../06-easyorders-integration/US-06-02-easyorders-authorized-connection.md) | Done — ready for deploy (2026-10-08) — [evidence](../../US-06-03-EASYORDERS-INGESTION-EVIDENCE.md); behind `EASYORDERS_INGESTION_ENABLED` |
| 4 | [US-06-04 — Synchronize approved outcomes to EasyOrders](US-06-04-easyorders-outcome-status-adapter.md) | P0 | Feature | [US-06-03](../06-easyorders-integration/US-06-03-easyorders-webhook-ingestion.md) | Done — ready for deploy (2026-10-08) — [evidence](../../US-06-04-EASYORDERS-OUTCOME-SYNC-EVIDENCE.md); behind `EASYORDERS_OUTCOME_SYNC_ENABLED` |
| 5 | [US-06-05 — Provide EasyOrders setup and connection-health guidance](US-06-05-easyorders-onboarding-health-and-disconnect.md) | P1 | Feature | [US-06-04](../06-easyorders-integration/US-06-04-easyorders-outcome-status-adapter.md) | Done — ready for deploy (2026-10-08); no switch of its own |
| 6 | [US-06-06 — Qualify the EasyOrders adapter for pilot release](US-06-06-easyorders-contract-and-pilot-release-gate.md) | P0 | Quality gate | [US-06-05](../06-easyorders-integration/US-06-05-easyorders-onboarding-health-and-disconnect.md) | Done — gate closed, ready for deploy (2026-10-08) — automated gate run 2026-10-03, [evidence](evidence/US-06-06-release-gate.md); closed on the product owner's end-to-end test report |

## Measurable exit criteria

- Provider authentication and event semantics are validated before enabling live ingestion.
- A pilot order moves from EasyOrders to Akeed and back through the approved status mapping.
- Rate-limit recovery, revocation, disconnects, and tenant isolation pass contract and live-pilot checks.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Native pilots use fresh/unprovisioned organizations, not active-source replacement.
US-06-01 evidence bar (product owner, 2026-10-03): US-06-02 to US-06-04 may be built against the interim [contract record](evidence/US-06-01-contract-record.md) with ingestion and remote status writes disabled; live onboarding and US-06-06 stayed blocked until its go-live verification was complete. That block was lifted on 2026-10-08, when the product owner reported the end-to-end test passed.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.