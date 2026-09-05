# US-03-03 — Deliver Standalone onboarding and source settings

- **Epic:** [E03 — Standalone Foundation and Onboarding](README.md)
- **Delivery rank:** 3 of 5
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Feature
- **Status:** Implemented locally — release blocked
- **Dependencies:** [US-03-02](../03-standalone-foundation-and-onboarding/US-03-02-pilot-entitlements-and-backfill.md)

## User story and value

As a Standalone merchant, I want setup and settings that match my platform, so that I can configure verification without Shopify-only errors or billing screens.

**Business value:** I can configure verification without Shopify-only errors or billing screens.

## Scope

Platform-neutral onboarding resolution and Standalone configuration UI.

**Out of scope:** Meta self-service connection, source switching and paid subscription selection.

## Acceptance criteria

1. Standalone users see source identity, merchant name, language, COD default, automation and timezone settings without Shopify installation/subscription prompts.
2. Setup progress is persisted and reloadable; completion requires a source, pilot entitlement and valid required settings.
3. Only owner/admin may update configuration; viewers can read but cannot activate or change automation.
4. Arabic and English layouts, RTL, validation errors, loading and retry states are covered; embedded Shopify onboarding is unchanged.

## Implementation notes

- **Backend:** Resolve current integration from authenticated organization/platform context, never a fallback Shopify lookup.
- **Frontend:** Use domain hooks/resolvers and existing skin patterns; use authenticated API helpers and translation keys.
- **Data:** Reuse integration settings and onboarding state; avoid a second independent settings store.
- **Operations:** Expose incomplete/blocked setup reasons; onboarding completion is not proof of Meta connection readiness.

## Test requirements

- New/reloading Standalone onboarding, validation errors and unavailable backend.
- Owner/admin/viewer authorization plus embedded-mode regression and both locales.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable after source and entitlement backfill; existing completed Shopify onboarding must not reset.

## Evidence and references

**IMPLEMENTED 2026-09-04:** Dedicated Standalone onboarding/settings, explicit idempotent completion, role guards, source/readiness errors, route gating, localized recovery states, and isolated browser coverage are implemented locally. See [US-03-03 implementation evidence](../../akeed-backend/docs/US-03-03-STANDALONE-ONBOARDING-AND-SETTINGS-EVIDENCE.md) for commands, results, limitations, recovery, and basic test instructions.

**VERIFIED FROM CODE:** OnboardingStateService resolves Shopify and Standalone settings skins already exist.

- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)
- [akeed-backend/src/modules/onboarding/settings.controller.ts](../../akeed-backend/src/modules/onboarding/settings.controller.ts)
- [akeed-frontend/src/features/onboarding](../../akeed-frontend/src/features/onboarding)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)

**REQUIRES RELEASE VALIDATION:** Local acceptance coverage passes. The disposable PostgreSQL contracts, inherited E02 staging/authentication gate, target-environment owner/admin/viewer smoke, and dependent US-03-04/05 work remain release blockers.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
