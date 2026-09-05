# US-07-04 — Exercise support and recovery runbooks

- **Epic:** [E07 — Assisted Merchant-Owned WhatsApp Pilot](README.md)
- **Delivery rank:** 4 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Operations
- **Status:** Backlog
- **Dependencies:** [US-07-03](../07-assisted-merchant-whatsapp-pilot/US-07-03-merchant-connection-readiness-visibility.md)

## User story and value

As a support operator, I want tested procedures for sender incidents, so that I can restore service without unsafe credential or tenant changes.

**Business value:** I can restore service without unsafe credential or tenant changes.

## Scope

Credential rotation, revocation, disconnect, template failure and ambiguous-send incident drills.

**Out of scope:** Silent sender failover, unauthorized provider changes or blanket resending.

## Acceptance criteria

1. Runbooks state actor authorization, diagnosis, safe actions, expected data changes, verification steps and escalation conditions.
2. Drills cover expired/revoked credentials, template unavailability, failed callback routing, queued work on disconnect and uncertain provider acceptance.
3. Historical messages and customer outcomes remain intact; future-only Akeed fallback requires explicit authorized selection.
4. Support records redacted correlation IDs, time to diagnose/recover and unresolved outcomes; no secret is copied into tickets.
5. Any wrong-tenant/wrong-sender behavior immediately pauses new merchant activation and follows the release hold procedure.

## Implementation notes

- **Backend:** Use supported lifecycle and reconciliation controls, not database patching or manual provider calls outside authorization.
- **Frontend:** Verify incident messages and operator/merchant visibility across both languages and RTL.
- **Data:** Reconcile connection/dispatch/verification state before and after each drill; preserve immutable identity associations.
- **Operations:** Assign support ownership and document the distinction between local disconnect and provider-side revocation.

## Test requirements

- Execute each runbook against disposable pilot resources, including a failed recovery branch.
- Replay a delayed callback after rotation/disconnect and verify correct historical routing.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

No cohort expansion until all required drills have successful evidence or a documented blocking defect.

## Evidence and references

**VERIFIED FROM CODE:** The current global sender has no tenant lifecycle runbooks; E06 introduces the controls that these operational stories must prove.

- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)

