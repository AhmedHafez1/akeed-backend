# E07 — Assisted Merchant-Owned WhatsApp Pilot

- **Horizon:** NEXT
- **Status:** Backlog
- **Stories:** 5
- **Prerequisite epics:** [E06 — Tenant-Aware WhatsApp Foundation](../06-tenant-aware-whatsapp-foundation/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Validate merchant demand, number eligibility, and support economics before investing in self-service onboarding.

## Scope and boundaries

Meta validation spike, assisted connection, readiness UX, support/recovery drills, and pilot go/no-go evidence.

**Out of scope:** Full Embedded Signup implementation, guaranteed coexistence, automatic number migration, and broad rollout.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-07-01 — Validate the Meta operating model and number eligibility](US-07-01-meta-operating-model-and-number-validation.md) | P0 | Validation spike | [US-06-07](../06-tenant-aware-whatsapp-foundation/US-06-07-messaging-isolation-and-fallback-release-gate.md) | Backlog |
| 2 | [US-07-02 — Establish assisted connection and template readiness](US-07-02-assisted-merchant-connection-procedure.md) | P0 | Operations | [US-07-01](../07-assisted-merchant-whatsapp-pilot/US-07-01-meta-operating-model-and-number-validation.md) | Backlog |
| 3 | [US-07-03 — Show connection readiness and sender visibility](US-07-03-merchant-connection-readiness-visibility.md) | P1 | Feature | [US-07-02](../07-assisted-merchant-whatsapp-pilot/US-07-02-assisted-merchant-connection-procedure.md) | Backlog |
| 4 | [US-07-04 — Exercise support and recovery runbooks](US-07-04-pilot-support-and-recovery-drills.md) | P0 | Operations | [US-07-03](../07-assisted-merchant-whatsapp-pilot/US-07-03-merchant-connection-readiness-visibility.md) | Backlog |
| 5 | [US-07-05 — Evaluate the merchant WhatsApp pilot](US-07-05-pilot-go-no-go-decision.md) | P0 | Quality gate | [US-07-04](../07-assisted-merchant-whatsapp-pilot/US-07-04-pilot-support-and-recovery-drills.md) | Backlog |

## Measurable exit criteria

- Meta operating model and per-merchant number eligibility have dated evidence.
- Each pilot merchant passes template, send, callback, rotation, and disconnect checks.
- Product and operations record an explicit expand/hold/stop decision without automatically enabling self-service.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

The Meta operating-model/number-eligibility spike is a hard gate before assisted onboarding. No account or number is migrated merely by completing this backlog.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

