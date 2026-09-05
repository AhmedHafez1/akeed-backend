# US-07-01 — Validate the Meta operating model and number eligibility

- **Epic:** [E07 — Assisted Merchant-Owned WhatsApp Pilot](README.md)
- **Delivery rank:** 1 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Validation spike
- **Status:** Backlog
- **Dependencies:** [US-06-07](../06-tenant-aware-whatsapp-foundation/US-06-07-messaging-isolation-and-fallback-release-gate.md)

## User story and value

As a product owner, I want evidence for a supported merchant-number onboarding path, so that Akeed does not promise coexistence or ownership behavior Meta will not permit.

**Business value:** Akeed does not promise coexistence or ownership behavior Meta will not permit.

## Scope

Primary-document review and authorized live validation for a capped assisted pilot.

**Out of scope:** Building Embedded Signup, automatically migrating numbers, or assuming Business App coexistence.

## Acceptance criteria

1. A dated decision record identifies the Akeed Meta app, required business/WABA access, credential ownership and supported onboarding route.
2. For each candidate, record Business App usage, number/account eligibility, permitted coexistence or migration behavior and merchant consent; no secrets enter the record.
3. An authorized test proves required templates, sending and callback subscription with the selected path, or the spike explicitly blocks that merchant/path.
4. The pilot cohort cap, support owner, success measurements and fallback/disconnect consent are documented before onboarding begins.
5. Any need for a different Meta app/signature model is flagged as a blocked dependency/change decision rather than bypassing E06 routing controls.

## Implementation notes

- **Backend:** Validate the existing single-app signature/connection assumptions against Meta; prototype only in authorized test resources during implementation.
- **Frontend:** Use findings to define truthful readiness and eligibility copy; do not promise a universal connect-existing-number button.
- **Data:** Store redacted eligibility evidence and safe account/number identifiers, with restricted access to merchant-specific records.
- **Operations:** Obtain authorization for every external test and record a supported/unsupported/unknown result per merchant.

## Test requirements

- Demonstrate approved template send, signed callback and phone-number match on a qualified test connection.
- Review denied/ineligible/no-access cases and confirm they stop onboarding.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Hard gate for US-07-02; an inconclusive spike is not implementation success or permission to migrate a number.

## Evidence and references

**VERIFIED FROM CODE:** Akeed currently uses one configured Meta app secret and global sender; the repository cannot establish external number eligibility.

- [akeed-backend/src/shared/guards/meta-webhook-signature.guard.ts](../../akeed-backend/src/shared/guards/meta-webhook-signature.guard.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.controller.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.controller.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta Blueprint — Embedded Signup](https://www.facebookblueprint.com/student/path/253152-whatsapp-embedded-signup-course)
- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates)

