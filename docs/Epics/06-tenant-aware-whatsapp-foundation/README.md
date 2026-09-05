# E06 — Tenant-Aware WhatsApp Foundation

- **Horizon:** NEXT
- **Status:** Backlog
- **Stories:** 7
- **Prerequisite epics:** [E02 — Platform Boundaries and Reliability](../02-platform-boundaries-and-reliability/README.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Support merchant-owned senders safely while keeping existing merchants on the Akeed sender.

## Scope and boundaries

Connections, encryption migration, message ledger, connection/template resolution, Meta routing, rotation/disconnect, and regression gates.

**Out of scope:** Self-service Meta onboarding, Business App coexistence promises, automatic merchant migration, and multiple active merchant senders.

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-06-01 — Introduce tenant-owned messaging connections](US-06-01-messaging-connections-and-credential-migration.md) | P0 | Technical enabler | [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md) | Backlog |
| 2 | [US-06-02 — Record every verification message dispatch](US-06-02-per-message-dispatch-ledger.md) | P0 | Technical enabler | [US-06-01](../06-tenant-aware-whatsapp-foundation/US-06-01-messaging-connections-and-credential-migration.md) | Backlog |
| 3 | [US-06-03 — Resolve tenant senders while preserving Akeed fallback](US-06-03-tenant-sender-resolution-and-fallback.md) | P0 | Feature | [US-06-02](../06-tenant-aware-whatsapp-foundation/US-06-02-per-message-dispatch-ledger.md) | Backlog |
| 4 | [US-06-04 — Resolve template ownership and readiness per connection](US-06-04-connection-template-readiness.md) | P0 | Feature | [US-06-03](../06-tenant-aware-whatsapp-foundation/US-06-03-tenant-sender-resolution-and-fallback.md) | Backlog |
| 5 | [US-06-05 — Route durable Meta callbacks by connection identity](US-06-05-durable-meta-webhook-tenant-routing.md) | P0 | Technical enabler | [US-06-04](../06-tenant-aware-whatsapp-foundation/US-06-04-connection-template-readiness.md) | Backlog |
| 6 | [US-06-06 — Support authorized connection rotation and disconnect](US-06-06-credential-rotation-and-disconnect-controls.md) | P0 | Feature | [US-06-05](../06-tenant-aware-whatsapp-foundation/US-06-05-durable-meta-webhook-tenant-routing.md) | Backlog |
| 7 | [US-06-07 — Prove messaging isolation and fallback compatibility](US-06-07-messaging-isolation-and-fallback-release-gate.md) | P0 | Quality gate | [US-06-06](../06-tenant-aware-whatsapp-foundation/US-06-06-credential-rotation-and-disconnect-controls.md) | Backlog |

## Measurable exit criteria

- Every initial/follow-up dispatch records its sender and provider message identity.
- Callbacks agree with the stored connection and cannot cross tenants.
- Akeed fallback is backward-compatible and credential migration/rotation is recoverable.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

This epic can proceed alongside E03–E05 after E02. Its release must preserve the Akeed global sender.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

