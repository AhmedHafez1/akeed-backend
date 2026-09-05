# US-07-03 — Show connection readiness and sender visibility

- **Epic:** [E07 — Assisted Merchant-Owned WhatsApp Pilot](README.md)
- **Delivery rank:** 3 of 5
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-07-02](../07-assisted-merchant-whatsapp-pilot/US-07-02-assisted-merchant-connection-procedure.md)

## User story and value

As a merchant, I want to see whether my sender is ready and what needs attention, so that I understand which number contacts customers and how to fix blocked sends.

**Business value:** I understand which number contacts customers and how to fix blocked sends.

## Scope

Localized readiness/status UI, actionable errors and explicit Akeed-versus-merchant identity.

**Out of scope:** Public self-service Meta onboarding and exposing confidential credentials.

## Acceptance criteria

1. The UI distinguishes not configured, pending, ready, degraded, disconnected and revoked states using backend truth.
2. It displays the active sender's safe identity, template/language readiness and last verification time, without tokens.
3. Blocked/fallback states explain whether future sends use Akeed, remain blocked or need assisted action; no misleading success state is shown.
4. Only owner/admin sees permitted mutations; viewer and error states remain readable and accessible.
5. Arabic/English, RTL/LTR, keyboard focus and responsive layouts work; existing Shopify merchants still see their default Akeed identity.

## Implementation notes

- **Backend:** Expose connection summary/capability DTOs with safe operational reasons; do not synthesize readiness from populated fields.
- **Frontend:** Add status presentation to existing settings/dashboard domain and skin patterns using shared API/auth helpers.
- **Data:** Read existing connection/ledger state; do not add a competing frontend-only readiness store.
- **Operations:** Link errors to the assisted support/runbook path with a safe correlation reference.

## Test requirements

- Every connection state, missing template, expired token, delayed refresh and network failure.
- Role/mode/locale/accessibility matrix and secret-redaction snapshots.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Pilot-only merchant connection controls; default Shopify experience remains compatible.

## Evidence and references

**VERIFIED FROM CODE:** Standalone/embedded settings skins exist but no runtime merchant connection-readiness model is consumed.

- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-frontend/src/features/dashboard](../../akeed-frontend/src/features/dashboard)
- [akeed-backend/src/modules/organizations/organizations.controller.ts](../../akeed-backend/src/modules/organizations/organizations.controller.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

