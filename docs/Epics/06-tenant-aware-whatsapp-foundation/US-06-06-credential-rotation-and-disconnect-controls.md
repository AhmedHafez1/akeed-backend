# US-06-06 — Support authorized connection rotation and disconnect

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 6 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-06-05](../06-tenant-aware-whatsapp-foundation/US-06-05-durable-meta-webhook-tenant-routing.md)

## User story and value

As a organization owner or authorized operator, I want to revoke or rotate a sender safely, so that compromised or expired credentials do not cause uncontrolled messages.

**Business value:** Compromised or expired credentials do not cause uncontrolled messages.

## Scope

Role-protected credential rotation, readiness transitions, disconnect and audit events.

**Out of scope:** Deleting order history, silently switching existing conversations, or number migration.

## Acceptance criteria

1. Only owner/admin or explicitly authorized staff can rotate/disconnect their permitted connection; viewer/cross-tenant requests fail.
2. Rotation validates replacement credentials and phone/WABA identity before activation; failed validation leaves the last valid version intact.
3. Disconnect/revocation prevents new and queued sends on that connection, with blocked dispatches and retained history.
4. Explicit fallback consent can select Akeed for future verifications, while prior conversations stay blocked or are resolved operationally without silent sender changes.
5. Audit captures actor, connection, action, safe reason and timestamps, never access tokens.

## Implementation notes

- **Backend:** Make lifecycle transitions atomic and recheck connection state when workers execute; do not rely on cached UI state.
- **Frontend:** Use localized confirmation and consequences, including affected pending work; keyboard and RTL flows must work.
- **Data:** Retain connection/dispatch references and credential-version audit; retire superseded encrypted material under a documented policy.
- **Operations:** Define a safe recovery path and distinguish local disconnect from provider-side credential revocation.

## Test requirements

- Concurrent rotate/send, failed rotation, revoked token, viewer denial and cross-tenant mutation.
- Queued follow-up after disconnect and explicit future-only fallback selection.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Exercise with disposable pilot credentials first; rollback restores a valid configuration only with explicit authorization.

## Evidence and references

**VERIFIED FROM CODE:** Organization credential updates exist but sending does not consume them and connection lifecycle/audit is not modeled.

- [akeed-backend/src/modules/organizations/organizations.controller.ts](../../akeed-backend/src/modules/organizations/organizations.controller.ts)
- [akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts)
- [akeed-backend/src/shared/utils/token-encryption.util.ts](../../akeed-backend/src/shared/utils/token-encryption.util.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

