# E06 — EasyOrders Integration

- **Horizon:** NEXT
- **Status:** In progress (US-06-01 validation spike under way; US-06-02 to US-06-05 implemented, disabled; US-06-06 automated gate run, live pilot not run, release blocked)
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
| 1 | [US-06-01 — Validate EasyOrders authorization and event semantics](US-06-01-easyorders-integration-validation.md) | P0 | Validation spike | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md), [US-03-05](../03-standalone-foundation-and-onboarding/US-03-05-standalone-tenant-and-primary-source-guards.md), [US-05-06](../05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md) (satisfied) | In progress — interim [contract record](evidence/US-06-01-contract-record.md) written 2026-10-03; live verification on an active store pending |
| 2 | [US-06-02 — Connect EasyOrders and secure its credentials](US-06-02-easyorders-authorized-connection.md) | P0 | Feature | [US-06-01](../06-easyorders-integration/US-06-01-easyorders-integration-validation.md) | Implemented, disabled (2026-10-03) — [evidence](../../US-06-02-EASYORDERS-CONNECTION-EVIDENCE.md); live onboarding blocked on US-06-01 go-live verification |
| 3 | [US-06-03 — Ingest and normalize EasyOrders order webhooks](US-06-03-easyorders-webhook-ingestion.md) | P0 | Feature | [US-06-02](../06-easyorders-integration/US-06-02-easyorders-authorized-connection.md) | Implemented, disabled (2026-10-03) — [evidence](../../US-06-03-EASYORDERS-INGESTION-EVIDENCE.md); live traffic blocked on US-06-01 go-live verification |
| 4 | [US-06-04 — Synchronize approved outcomes to EasyOrders](US-06-04-easyorders-outcome-status-adapter.md) | P0 | Feature | [US-06-03](../06-easyorders-integration/US-06-03-easyorders-webhook-ingestion.md) | Implemented, disabled (2026-10-03) — [evidence](../../US-06-04-EASYORDERS-OUTCOME-SYNC-EVIDENCE.md); remote status writes blocked on US-06-01 go-live verification |
| 5 | [US-06-05 — Provide EasyOrders setup and connection-health guidance](US-06-05-easyorders-onboarding-health-and-disconnect.md) | P1 | Feature | [US-06-04](../06-easyorders-integration/US-06-04-easyorders-outcome-status-adapter.md) | Implemented, disabled (2026-10-03); live onboarding blocked on US-06-01 go-live verification |
| 6 | [US-06-06 — Qualify the EasyOrders adapter for pilot release](US-06-06-easyorders-contract-and-pilot-release-gate.md) | P0 | Quality gate | [US-06-05](../06-easyorders-integration/US-06-05-easyorders-onboarding-health-and-disconnect.md) | In progress, release blocked (2026-10-03) — automated gate run, [evidence](evidence/US-06-06-release-gate.md); live pilot ([script](evidence/US-06-06-live-pilot-script.md)) NOT RUN and US-06-01 go-live verification owed; recommendation no-go |

## Measurable exit criteria

- Provider authentication and event semantics are validated before enabling live ingestion.
- A pilot order moves from EasyOrders to Akeed and back through the approved status mapping.
- Rate-limit recovery, revocation, disconnects, and tenant isolation pass contract and live-pilot checks.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Native pilots use fresh/unprovisioned organizations, not active-source replacement.
US-06-01 evidence bar (product owner, 2026-10-03): US-06-02 to US-06-04 may be built against the interim [contract record](evidence/US-06-01-contract-record.md) with ingestion and remote status writes disabled; live onboarding and US-06-06 stay blocked until its go-live verification is complete.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.