# US-06-03 — Resolve tenant senders while preserving Akeed fallback

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 3 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-06-02](../06-tenant-aware-whatsapp-foundation/US-06-02-per-message-dispatch-ledger.md)

## User story and value

As a merchant, I want messages sent through the connection I selected, so that customer communications use a predictable business identity.

**Business value:** Customer communications use a predictable business identity.

## Scope

Tenant-aware connection resolution at dispatch time and explicit backward-compatible fallback policy.

**Out of scope:** Automatically migrating Shopify merchants or silently failing over an opted-in merchant sender.

## Acceptance criteria

1. Merchants without an explicitly enabled merchant connection use the existing Akeed environment sender for new verifications.
2. An enabled ready merchant connection is selected only for its own organization and recorded on the dispatch before sending.
3. Each follow-up revalidates and uses its verification's original sender connection; connection changes do not silently split the conversation.
4. Invalid/revoked/degraded elected credentials block or defer sending with a visible reason; they do not silently switch to Akeed.
5. An explicit authorized switch to Akeed affects future verifications; queued work tied to the old connection is handled by the disconnect policy.

## Implementation notes

- **Backend:** Pass resolved connection credentials into the Meta client per call; remove fixed constructor sender selection while preserving its system fallback.
- **Frontend:** Provide safe chosen-sender/reason metadata for later status UI; do not expose tokens.
- **Data:** Persist verification/dispatch sender association; credential rotation may update credentials for the same phone identity, not rewrite history.
- **Operations:** Document the default fallback versus explicit migration distinction and audit any sender-policy change.

## Test requirements

- No merchant connection, enabled ready connection, wrong tenant, revoked token and missing environment fallback.
- Follow-up after rotation/disconnect and unchanged Shopify default.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Keep merchant-connection sending behind explicit activation; first prove global-only behavior is identical to E01.

## Evidence and references

**VERIFIED FROM CODE:** MessagingPort lacks organization/connection context and WhatsAppService currently fixes token/phone ID in its constructor.

- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

