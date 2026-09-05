# US-04-05 — Validate the complete Standalone merchant journey

- **Epic:** [E04 — Standalone Manual Order MVP](README.md)
- **Delivery rank:** 5 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Implemented locally — release blocked (2026-09-05)
- **Dependencies:** [US-04-04](../04-standalone-manual-order-mvp/US-04-04-standalone-dashboard-and-actions.md)

## User story and value

As a product owner, I want evidence that a non-Shopify merchant can complete the workflow, so that the MVP solves an actual operational task instead of only exposing screens.

**Business value:** The MVP solves an actual operational task instead of only exposing screens.

## Scope

Signup-to-real-order acceptance, fault recovery, permissions and dual-mode release checks.

**Out of scope:** Public API launch or merchant-owned-number onboarding.

## Acceptance criteria

1. A fresh Supabase merchant completes setup, test send, manual order submission and a customer outcome without Shopify records or calls.
2. A merchant can understand ineligible, pending, failed and no_reply states and complete an allowed local action.
3. Concurrent/repeated submission and callback retries produce one order/verification with correct usage.
4. Viewer/cross-tenant attempts fail in the backend and UI; Arabic/English, RTL/LTR and keyboard journeys pass.
5. All E04 stories and E01 regression gates have recorded evidence before MVP release.

## Implementation notes

- **Backend:** Run a composed integration test with provider fakes plus an authorized live test-recipient pilot.
- **Frontend:** Record merchant walkthrough, accessibility and recovery checks against the production-like build.
- **Data:** Use synthetic tenants and reconcile order/verification/usage counts after every failure drill.
- **Operations:** Document support triage for accepted-but-unsent orders and an explicit release hold on isolation failures.

## Test requirements

- End-to-end happy path plus invalid phone, timeout, Redis failure, revoked session and inactive source.
- Verify no Shopify service is invoked for any Standalone path.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Start with assisted pilot users; rollback disables new manual entry without deleting accepted orders or queued work.

## Evidence and references

**LOCAL IMPLEMENTATION EVIDENCE:** The composed acceptance harness and sequential E04 gate are implemented. The harness passes its synthetic provider/Shopify-isolation checks; frontend typecheck, fixture typecheck, lint, isolated production build, and the live LTR select check pass. The dated record is [US-04-05 merchant acceptance evidence](../../akeed-backend/docs/US-04-05-MANUAL-MVP-MERCHANT-ACCEPTANCE-EVIDENCE.md).

**RELEASE BLOCK:** The dedicated PostgreSQL contract is not run without `E01_TEST_DATABASE_URL`; the inherited E03/E02 gate stops at the platform migration rehearsal because Docker is unavailable; and the authorized live Meta pilot is not run because the available target Standalone source is disconnected and verification is paused. E04 and this story remain release-blocked; no completion claim is made.

- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)
- [akeed-backend/src/modules/verifications/test-verification.service.ts](../../akeed-backend/src/modules/verifications/test-verification.service.ts)
- [akeed-backend/src/modules/orders/orders.controller.ts](../../akeed-backend/src/modules/orders/orders.controller.ts)
- [akeed-frontend/src/features/dashboard](../../akeed-frontend/src/features/dashboard)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)

**TARGET VALIDATION REQUIRED:** Authenticated owner/admin/viewer walkthroughs, both locales/directions, the disposable PostgreSQL contract, inherited E01/E02/E03 target gates, and the single approved Meta recipient pilot must be rerun and attached before release closure.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
