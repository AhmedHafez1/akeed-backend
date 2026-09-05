# US-07-02 — Establish assisted connection and template readiness

- **Epic:** [E07 — Assisted Merchant-Owned WhatsApp Pilot](README.md)
- **Delivery rank:** 2 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Operations
- **Status:** Backlog
- **Dependencies:** [US-07-01](../07-assisted-merchant-whatsapp-pilot/US-07-01-meta-operating-model-and-number-validation.md)

## User story and value

As a pilot merchant, I want guided help connecting my approved number, so that I can adopt my own sender without navigating unsupported setup alone.

**Business value:** I can adopt my own sender without navigating unsupported setup alone.

## Scope

Repeatable assisted onboarding checklist using E06 controls and E07 validation results.

**Out of scope:** Self-service Embedded Signup and onboarding any merchant whose eligibility remains unknown.

## Acceptance criteria

1. The procedure records merchant authorization, verified organization/number ownership and the completed eligibility gate before connection activation.
2. Credentials enter the secure connection workflow only; support messages, screenshots and checklists contain no raw token.
3. An initial and follow-up template are checked for the merchant WABA/languages, and a test send/reply/status cycle proves routing.
4. The merchant explicitly elects their sender and understands that existing Shopify accounts remain on Akeed until deliberately migrated.
5. Activation, support contact, fallback policy and disconnect recovery are recorded; incomplete setup stays pending and does not send real orders.

## Implementation notes

- **Backend:** Use connection validation and template readiness APIs; no direct credential edits or ad hoc worker overrides.
- **Frontend:** Reuse safe status/configuration controls with Arabic/English guidance and RTL support; assisted steps remain clearly labeled.
- **Data:** Persist readiness timestamps and safe audit evidence associated with the correct organization.
- **Operations:** Provide an operator checklist with stop conditions, authorized access requirements and handover to the merchant.

## Test requirements

- Walk the checklist with an eligible test merchant and separately simulate denied access/missing templates.
- Verify zero-token leakage and a cross-tenant connection attempt is rejected.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Activate one qualified merchant at a time within the approved cohort cap; pause on identity or routing mismatch.

## Evidence and references

**VERIFIED FROM CODE:** Existing organization WA fields do not constitute a completed connection, and templates/sending are currently global.

- [akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/shared/messaging/cod-template-catalog.ts](../../akeed-backend/src/shared/messaging/cod-template-catalog.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates)

