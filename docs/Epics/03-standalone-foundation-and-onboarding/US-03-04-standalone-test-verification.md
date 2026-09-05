# US-03-04 — Enable Standalone test verification through Akeed

- **Epic:** [E03 — Standalone Foundation and Onboarding](README.md)
- **Delivery rank:** 4 of 5
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Feature
- **Status:** Implemented locally — release blocked
- **Dependencies:** [US-03-03](../03-standalone-foundation-and-onboarding/US-03-03-standalone-onboarding-and-settings.md)

## User story and value

As a Standalone merchant, I want to test the message before submitting real orders, so that I can confirm setup and customer experience safely.

**Business value:** I can confirm setup and customer experience safely.

## Scope

Source-aware test-send API and existing dashboard test panel.

**Out of scope:** Real commerce actions, test sends bypassing authorization, or merchant-owned sender onboarding.

## Acceptance criteria

1. An authorized owner/admin with a ready Standalone source can send a synthetic test using the Akeed sender.
2. Invalid phone, missing entitlement/source and provider failure return actionable errors without any Shopify lookup.
3. The test retains existing test-send quota/limit behavior and clearly identifies synthetic data; no external commerce action is executed.
4. Test response and callback can be observed from the current panel in Arabic/English with RTL, without promising completed real-order ingestion.

## Implementation notes

- **Backend:** Replace Shopify-only test integration lookup with trusted current-source resolution; reuse the shared messaging path.
- **Frontend:** Adapt StandaloneTestVerificationPanel and expose sending/success/error states without double submission.
- **Data:** Use the existing synthetic-order convention and ensure it cannot collide with real source IDs.
- **Operations:** Rate-limit test sends using existing controls or a documented safe test-only limit; never log full tokens.

## Test requirements

- Valid Standalone test, unauthorized viewer, invalid phone, provider failure and repeat-click protection.
- Assert zero Shopify calls and preserve embedded test behavior.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Pilot with authorized test recipients; do not silently enable real-order automation merely because a test succeeds.

## Evidence and references

**VERIFIED FROM CODE:** The current test service explicitly requires an active Shopify integration, while a Standalone test panel exists.

- [akeed-backend/src/modules/verifications/test-verification.service.ts](../../akeed-backend/src/modules/verifications/test-verification.service.ts)
- [akeed-frontend/src/features/dashboard/skins/standalone/components/StandaloneTestVerificationPanel.tsx](../../akeed-frontend/src/features/dashboard/skins/standalone/components/StandaloneTestVerificationPanel.tsx)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

## Implementation evidence

See [US-03-04 standalone test verification evidence](../../akeed-backend/docs/US-03-04-STANDALONE-TEST-VERIFICATION-EVIDENCE.md).
