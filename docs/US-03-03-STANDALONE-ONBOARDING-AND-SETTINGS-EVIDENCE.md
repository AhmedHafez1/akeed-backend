# US-03-03 Standalone onboarding and settings evidence

**Validated:** 2026-09-04  
**Revision:** backend and frontend working trees  
**Decision:** local implementation passes; release remains blocked by the inherited E02 gate, the US-03-01/02 deployment sequence, the unavailable isolated database contract environment, and unfinished US-03-04/05

## Implemented behavior

- Supabase Standalone accounts now have a dedicated localized onboarding flow instead of the former onboarding/dashboard redirect loop. Pending accounts are gated to onboarding, completed accounts leave onboarding for the dashboard, and failed state checks expose retry and sign-out recovery.
- The onboarding state identifies the source as `standalone` and returns its stable `standalone:<orgId>` identity, COD fallback, role-derived configuration/completion permissions, completion readiness, and machine-readable blocker codes.
- Owner/admin users can save merchant name, default language, COD fallback, auto-verification, timezone, first-send delay, follow-up, escalation, and quiet hours. The existing integration remains the only settings store. Viewer reads are preserved while both settings PATCH routes and Standalone completion return `403`.
- `POST /api/onboarding/complete` is Supabase/Standalone-only and idempotent. It requires exactly one active Standalone source, a valid pilot entitlement, merchant name, language, an explicit COD fallback value, valid automation values, and timezone. Incomplete setup returns `409 ONBOARDING_BLOCKED` with blocker codes and does not discard settings saved first.
- Missing, inactive, and ambiguous Standalone sources return stable error codes. Organization bootstrap reuses an existing owner/admin/viewer membership without creating another organization or changing its role.
- Standalone settings show source identity, COD fallback, automation/timezone controls, pilot access and usage, and a localized read-only explanation for viewers. First-send delay is limited to 24 hours; follow-up and escalation are limited to 168 hours.
- Existing embedded Shopify source resolution, onboarding steps, billing completion, and plan behavior were not changed. Standalone completion does not claim Meta connection or WhatsApp test readiness.

No database migration is required for this story.

## Validation results

| Check | Result |
| --- | --- |
| Focused Standalone settings/completion HTTP suite | PASS — 1 suite, 13 tests |
| Full backend Jest regression | PASS — 51 suites, 555 tests |
| Backend build and structured-log check | PASS — 0 log violations |
| Backend non-fixing ESLint | PASS — 0 errors; 19 existing unsafe-argument warnings in tests |
| Frontend application type-check | PASS |
| Isolated fixture type-check | PASS |
| Frontend non-fixing lint | PASS |
| Frontend production build | PASS — required normal network access for the configured Google Font |
| Standalone English owner browser flow | PASS — save, reload-safe state, explicit completion, dashboard exit |
| Standalone Arabic viewer browser flow | PASS — localized read-only controls with `lang=ar`, `dir=rtl` |
| Standalone blocked/unavailable browser flows | PASS — saved progress retained on entitlement block; localized retry shown for unavailable backend |
| Embedded English/Arabic settings smoke | PASS — Shopify billing controls retained; Arabic rendered with `lang=ar`, `dir=rtl` |
| Standalone provisioning and pilot PostgreSQL contracts | NOT RUN — `E01_TEST_DATABASE_URL` is not configured; both gates fail closed without using the application database |

Browser checks used only the isolated loopback fixture at `127.0.0.1:3098`. No authenticated account, application database, migration, pilot activation, Shopify subscription, provider call, real order, Meta connection, or WhatsApp send was used.

## Basic test procedure

### Isolated UI test

1. From `akeed-frontend`, run `npm run smoke:e01` and open `http://127.0.0.1:3098/en/onboarding?role=owner`.
2. Confirm the friendly Standalone source and copyable stable identity. Change merchant/settings values, save progress, reload, and verify they remain. Complete setup and confirm the synthetic dashboard destination.
3. Repeat with `role=admin`. Use `role=viewer` and verify all configuration/completion controls are disabled.
4. Use `entitlement=blocked`; save a merchant name, attempt completion, and verify the pilot blocker while the saved value remains. Use `backend=unavailable` and verify retry recovery.
5. Repeat under `/ar/onboarding` and inspect `lang=ar`, `dir=rtl`, keyboard operation, translated validation, and advanced controls.
6. Open `/en/billing?entitlement=shopify&skin=embedded&tab=billing` and its `/ar` equivalent to confirm the existing Shopify billing skin still renders.

### Authenticated owner/viewer smoke

1. Deploy US-03-01/02 first and activate only an approved synthetic pilot through the audited US-03-02 workflow. Do not repair source or entitlement state by direct table edits.
2. Sign in as the pending owner. Confirm protected dashboard navigation lands on `/{locale}/onboarding` without a redirect loop or Shopify plan/install prompt.
3. Save progress, sign out/in or reload, then complete. Confirm the dashboard opens and Settings reloads the same integration values.
4. Sign in as an existing viewer of the same organization. Confirm onboarding/settings are readable, controls explain the read-only role, and direct PATCH/completion requests return `403` without role, organization, or settings mutation.
5. Repeat the critical path in Arabic. A completed onboarding state is only configuration readiness; do not mark Meta/test sending ready until US-03-04 passes.

## Deployment, monitoring, and recovery

Deploy the backend and frontend contract changes together after US-03-01/02 source and entitlement reconciliation. Start with pilot activation disabled, smoke an approved owner/admin/viewer organization in both locales, then enable only the already approved pilot batch. Monitor `ONBOARDING_SOURCE_MISSING`, `ONBOARDING_SOURCE_INACTIVE`, `ONBOARDING_SOURCE_AMBIGUOUS`, `ONBOARDING_BLOCKED`, and authorization failures by non-sensitive organization/integration identifiers.

If onboarding checks fail, leave pilot activation disabled, inspect the structured source/blocker code, and use retry/sign-out recovery. Do not create a replacement organization, change a viewer role, or select a source by inference. Application rollback is a coordinated backend/frontend rollback to the previous compatible versions; no schema rollback is needed and integration settings saved before a blocked completion should be retained.

## Remaining release blockers

- Supply a disposable PostgreSQL URL and run `npm run test:contract:standalone-provisioning` and `npm run test:contract:standalone-pilots` without pointing either command at the application database.
- Complete the inherited US-02-07 staging migration/Redis/authenticated dual-mode release gate and deploy/reconcile US-03-01/02.
- Perform authenticated owner/admin/viewer English/Arabic smoke checks in the target environment.
- Complete US-03-04 before presenting Meta/test verification as available and US-03-05 before the E03 release gate.
