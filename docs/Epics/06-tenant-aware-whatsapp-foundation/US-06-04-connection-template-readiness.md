# US-06-04 — Resolve template ownership and readiness per connection

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 4 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-06-03](../06-tenant-aware-whatsapp-foundation/US-06-03-tenant-sender-resolution-and-fallback.md)

## User story and value

As a merchant using my own sender, I want only approved templates from my WABA to be used, so that verification messages do not fail because another business owns the template.

**Business value:** Verification messages do not fail because another business owns the template.

## Scope

Connection-scoped template mapping, language readiness and send-time validation.

**Out of scope:** Unrestricted template creation, every existing Akeed variant, and self-service template review.

## Acceptance criteria

1. Template selection resolves against the chosen connection/WABA and includes approved language/name/parameter mapping.
2. Akeed fallback retains its current template catalog and defaults.
3. Merchant pilots enable only verified initial/follow-up templates and available languages; missing/rejected templates block sends with an actionable reason.
4. Approval/readiness changes are checked or refreshed before activation and surfaced without falling back to another business's template.
5. Template errors never expose credentials or cause an unapproved sender change.

## Implementation notes

- **Backend:** Separate the Akeed catalog from per-connection bindings and validate body/button parameter shape.
- **Frontend:** Show safe readiness and supported language/variant options through localized settings; unsupported choices are not selectable.
- **Data:** Store template identity/status per connection, verification timestamp and mapping version used by each dispatch.
- **Operations:** Use the assisted pilot's minimal approved set; template readiness is distinct from token validity.

## Test requirements

- Same template name in two WABAs, missing language, rejected/paused template and parameter mismatch.
- Global catalog regression and readiness changes between scheduling and send.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable merchant sending only after a template test passes for that connection; retain prior mapping for audit.

## Evidence and references

**VERIFIED FROM CODE:** The current template catalog maps global Akeed variants, and send-time selection is not organization-aware.

- [akeed-backend/src/shared/messaging/cod-template-catalog.ts](../../akeed-backend/src/shared/messaging/cod-template-catalog.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — Message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates)
- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

