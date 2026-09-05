# US-06-07 — Prove messaging isolation and fallback compatibility

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 7 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-06-06](../06-tenant-aware-whatsapp-foundation/US-06-06-credential-rotation-and-disconnect-controls.md)

## User story and value

As a release owner, I want end-to-end evidence before tenant-owned sending is enabled, so that platform expansion cannot misroute customer messages or callbacks.

**Business value:** Platform expansion cannot misroute customer messages or callbacks.

## Scope

E06 credential, template, send, webhook, migration and Shopify regression gates.

**Out of scope:** Declaring any merchant's existing Business App number eligible without E07 validation.

## Acceptance criteria

1. Two merchant connections plus the Akeed system sender cannot cross credentials, templates, phone identities, messages or outcomes.
2. Initial/follow-up ledger entries retain all provider IDs and route delayed callbacks after subsequent sends.
3. Ambiguous provider acceptance, duplicate work, connection revocation and callback persistence outage have safe tested behavior.
4. Global-only Shopify flows pass E01; existing merchants are still on the Akeed sender.
5. Migration/backfill reconciliation and rollback safeguards are documented; no encrypted credential or historical association is lost.

## Implementation notes

- **Backend:** Combine provider fakes with repository/queue integration tests and explicit zero-cross-tenant assertions.
- **Frontend:** Test localized connection/template errors and unchanged embedded views.
- **Data:** Compare connection/ledger backfill counts and legacy IDs; mark unreconstructable history as unknown.
- **Operations:** Block pilot enablement on any tenant-routing or sender-policy defect and record approval evidence.

## Test requirements

- Full E06 acceptance matrix, E01 regression and controlled credential/callback fault drills.
- Verify phone/customer identity mismatches cannot finalize another organization's verification.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Release infrastructure with merchant sending off by default; E07 controls assisted activation.

## Evidence and references

**VERIFIED FROM CODE:** Current global sender and mutable message-ID design require a staged compatibility gate, not an immediate all-tenant migration.

- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)

