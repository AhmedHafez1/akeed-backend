# US-04-02 — Build accessible manual order entry

- **Epic:** [E04 — Standalone Manual Order MVP](README.md)
- **Delivery rank:** 2 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented locally — release blocked (2026-09-05)
- **Dependencies:** [US-04-01](../04-standalone-manual-order-mvp/US-04-01-manual-order-creation-command.md)

## User story and value

As a Arabic- or English-speaking merchant, I want a clear order-entry form, so that I can submit accurate verification requests with minimal training.

**Business value:** I can submit accurate verification requests with minimal training.

## Scope

Standalone form, validation, submission feedback and retry-safe UX.

**Out of scope:** Embedded Shopify manual entry, bulk upload and hosted public forms.

## Acceptance criteria

1. The form captures phone, name/reference where available, amount, currency and payment choice/default with clear required-field indicators.
2. Labels, validation, buttons and feedback are translated in Arabic/English and work in RTL/LTR layouts.
3. Keyboard navigation, focus-on-error and screen-reader field associations work; submit is disabled while pending.
4. Retries preserve entered values and the original submission token; a successful new-order action resets the token.
5. Success links to the created order/verification; accepted/pending is visibly different from sent/delivered.

## Implementation notes

- **Backend:** Use US-04-01 field errors and acceptance DTO without a parallel validation contract.
- **Frontend:** Add a Standalone skin/domain hook using existing form and translation conventions; avoid mode branching in UI JSX.
- **Data:** Do not persist API keys or sensitive customer drafts in browser storage by default.
- **Operations:** Display safe retry guidance for offline/server failures and do not encourage repeated new submissions.

## Test requirements

- Keyboard and screen-reader checks, RTL/LTR layouts, validation and long customer/reference text.
- Double click, timeout retry, blocked source, viewer and backend error states.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Expose only when Standalone onboarding is ready; preserve dashboard navigation in both modes.

## Evidence and references

**IMPLEMENTED AND LOCALLY VERIFIED (2026-09-05):** The Standalone dashboard now provides the localized accessible manual-order modal, permission/source fail-closed states, 30-second abort, memory-only same-token recovery, duplicate-safe success, and the corrected Standalone verifications route. The embedded Shopify skin remains unchanged.

- [Manual order Standalone skin](../../akeed-frontend/src/features/orders/skins/standalone/ManualOrderEntryStandalone.tsx)
- [Manual order state and retry hook](../../akeed-frontend/src/features/orders/domain/useManualOrderEntry.ts)
- [Standalone dashboard integration](../../akeed-frontend/src/features/dashboard/skins/standalone/DashboardStandaloneSkin.tsx)
- [Manual order API helper](../../akeed-frontend/src/features/orders/api/manualOrderApi.ts)
- [Verification page permission](../../akeed-backend/src/modules/verifications/verifications.controller.ts)
- [Implementation evidence](../../akeed-backend/docs/US-04-02-LOCALIZED-MANUAL-ORDER-ENTRY-EVIDENCE.md)
- [UI/API recovery contract](../../akeed-backend/docs/MANUAL_ORDER_CREATION.md)

**LOCAL RESULT:** Frontend application and fixture typechecks, zero-warning frontend lint, production build, 22 targeted backend tests, the 590-test backend regression, backend build/non-fixing lint/structured-log checks, the E03 compatibility gate, the five-case PostgreSQL manual-order contract, and English/Arabic loopback browser checks pass.

**EXTERNAL PLATFORM DEPENDENCY:** Authenticated target-environment owner/admin/viewer and connected/disconnected-source validation was not run. US-04-03 through US-04-05, live Meta messaging/callbacks, and inherited provider gates still block release. No sent or delivered state is claimed by this story.
