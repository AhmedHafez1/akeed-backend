# US-06-05 — Route durable Meta callbacks by connection identity

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 5 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-06-04](../06-tenant-aware-whatsapp-foundation/US-06-04-connection-template-readiness.md)

## User story and value

As a organization owner, I want only callbacks for my sender and customer to affect my orders, so that another tenant cannot spoof a verification outcome.

**Business value:** Another tenant cannot spoof a verification outcome.

## Scope

Meta event persistence, raw signature validation, phone-number metadata and dispatch-aware callback routing.

**Out of scope:** Trusting a verification UUID alone or supporting arbitrary merchant Meta apps before the operating-model gate.

## Acceptance criteria

1. Webhook payloads are signature-verified with the configured app secret and durably accepted before success acknowledgment.
2. DTO/parser includes metadata.phone_number_id and uses the ledger/connection identity to resolve statuses and replies.
3. Phone-number identity, verification organization and expected customer sender agree before applying a button outcome; context message ID is checked when available.
4. Missing/conflicting identity or unknown message correlation is quarantined and observable, never applied to another tenant.
5. Duplicate/out-of-order statuses and replies are idempotent; delayed delivery events do not erase terminal business outcomes or stronger delivery evidence.

## Implementation notes

- **Backend:** Add durable Meta event processing and safe routing; retain one configured Meta app signature model until E07 validates expansion.
- **Frontend:** Expose processing/quarantine diagnostics only to authorized users; merchant lifecycle must not imply unmatched callbacks succeeded.
- **Data:** Keep provider event/message IDs and phone metadata; restrict raw webhook payload access and retention.
- **Operations:** Return retryable failure if durable persistence fails; internal processing can retry after acknowledgment.

## Test requirements

- Wrong signature, wrong phone ID, forged UUID, wrong customer, old/new message IDs and two-tenant collisions.
- Persistence outage, duplicate messages, read-before-delivered and late reply after merchant cancellation.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Shadow-validate routing against recorded synthetic events before enforcement; never permit a cross-tenant compatibility bypass.

## Evidence and references

**VERIFIED FROM CODE:** Meta DTO omits phone-number metadata and the current service routes messages/statuses without connection validation.

- [akeed-backend/src/infrastructure/spokes/meta/dto/whatsapp-webhook.dto.ts](../../akeed-backend/src/infrastructure/spokes/meta/dto/whatsapp-webhook.dto.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.controller.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.controller.ts)
- [akeed-backend/src/shared/guards/meta-webhook-signature.guard.ts](../../akeed-backend/src/shared/guards/meta-webhook-signature.guard.ts)
- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)

