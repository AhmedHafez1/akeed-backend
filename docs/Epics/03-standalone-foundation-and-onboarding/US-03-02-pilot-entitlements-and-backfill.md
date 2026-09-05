# US-03-02 — Activate pilot entitlements and backfill Standalone accounts

- **Epic:** [E03 — Standalone Foundation and Onboarding](README.md)
- **Delivery rank:** 2 of 5
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented locally — release blocked by US-02-07 external validation, migration/grant rehearsal, and authenticated staff preview validation (2026-09-03)
- **Dependencies:** [US-03-01](../03-standalone-foundation-and-onboarding/US-03-01-standalone-source-provisioning.md)

## User story and value

As a existing Standalone merchant, I want a usable pilot entitlement without rebuilding my account, so that I can complete onboarding while my existing identity and data remain intact.

**Business value:** I can complete onboarding while my existing identity and data remain intact.

## Scope

Manual/free activation and repeatable source/entitlement backfill for eligible existing organizations.

**Out of scope:** Paid checkout, new quota pricing, or changing Shopify subscriptions.

## Acceptance criteria

1. Eligible Standalone organizations receive the selected existing starter/manual plan with billingStatus=not_required and an auditable activation.
2. Backfill dry-run reports eligible, skipped, existing-source and ambiguous rows before writes.
3. Repeating backfill changes no completed row and preserves memberships, usage, orders and onboarding progress.
4. Shopify/native-source organizations are skipped, not converted; ambiguous membership/source ownership is reported for review.

## Implementation notes

- **Backend:** Reuse provider-neutral entitlement logic and transactional provisioning; do not call Shopify billing.
- **Frontend:** Present the free/manual pilot status and limits through existing localized settings/usage components.
- **Data:** Use existing configured plan limits and preserve accounting periods; no mass usage reset.
- **Operations:** Restrict manual activation to authorized staff, record actor/reason/time, and provide an exception report.

## Test requirements

- Dry-run versus apply counts, repeated apply, interrupted run, existing entitlement and Shopify exclusion.
- Plan limit and billing-state execution checks after backfill.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Back up/reconcile affected IDs and counts, apply in bounded batches, and roll back only newly introduced activation/source records when safe.

## Evidence and references

**VERIFIED FROM CODE:** Billing activity already permits not_required, while existing Standalone provisioning lacks integration/entitlement records.

- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [akeed-backend/src/shared/utils/billing.util.ts](../../akeed-backend/src/shared/utils/billing.util.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/onboarding/billing.service.ts](../../akeed-backend/src/modules/onboarding/billing.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

## Implementation evidence

**Implementation evidence (2026-09-03):** [US-03-02 Standalone pilot entitlement evidence](../../akeed-backend/docs/US-03-02-STANDALONE-PILOT-ENTITLEMENTS-EVIDENCE.md) records staff-only preview/apply APIs, deterministic exclusions, per-account serializable activation and audit, direct-write restrictions, the localized admin workflow, PostgreSQL rehearsal, compatibility tests, rollout preflight, and rollback conditions. Activation defaults off; no application-database migration or live account activation was performed.
