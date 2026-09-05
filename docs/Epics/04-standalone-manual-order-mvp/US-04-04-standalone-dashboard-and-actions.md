# US-04-04 — Present Standalone lifecycle, usage and supported actions

- **Epic:** [E04 — Standalone Manual Order MVP](README.md)
- **Delivery rank:** 4 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented locally — release blocked (2026-09-05)
- **Dependencies:** [US-04-03](../04-standalone-manual-order-mvp/US-04-03-manual-order-verification-lifecycle.md)

## User story and value

As a Standalone merchant, I want a trustworthy dashboard of my submitted orders, so that I can follow up on customers without inspecting technical logs.

**Business value:** I can follow up on customers without inspecting technical logs.

## Scope

Manual orders in lists/statistics, verification details, usage and capability-driven merchant actions.

**Out of scope:** Phone/reference search, CSV export and external-system synchronization.

## Acceptance criteria

1. Created manual orders appear in organization-scoped reporting, including pending or ineligible orders with no verification.
2. Status/date filters and pagination preserve tenant isolation; totals reconcile with the same reporting scope.
3. Supported Standalone merchant actions change local lifecycle only and use platform-neutral labels/results.
4. Usage reflects existing reservation semantics and does not count duplicate submissions as new orders/verification usage.
5. Arabic/English and RTL show empty, loading, blocked, failed and success states clearly without Shopify-specific error text.

## Implementation notes

- **Backend:** Expose capability/acceptance fields through existing repositories and DTOs; avoid deriving tenant from query parameters.
- **Frontend:** Reuse dashboard hooks and Standalone skins; keep embedded skin behavior unchanged.
- **Data:** Reconcile orders without verifications, synthetic tests and inactive-source history in reporting definitions.
- **Operations:** Display external synchronization only when supported; no false remote-success indicators.

## Test requirements

- Two-tenant lists/stats/actions, date boundaries, pagination and duplicate/failed-order usage.
- Both modes/locales and no-verification/ineligible order presentation.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Validate sample dashboard totals against repository queries before exposing manual entry broadly.

## Evidence and references

**IMPLEMENTED AND LOCALLY VERIFIED (2026-09-05):** Organization-scoped order lists and stats now share one lifecycle projection, retain orders without verifications and inactive-source history, apply merchant-local date bounds, expose stable pagination/totals and capability-driven actions, and include synthetic test rows. Standalone renders the order list with localized lifecycle explanations, action feedback and locale/timezone-aware formatting while the embedded Shopify surface remains unchanged.

- [akeed-frontend/src/features/dashboard](../../akeed-frontend/src/features/dashboard)
- [akeed-frontend/src/features/dashboard/domain/useDashboard.ts](../../akeed-frontend/src/features/dashboard/domain/useDashboard.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/orders/orders.controller.ts](../../akeed-backend/src/modules/orders/orders.controller.ts)
- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/orders.repository.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)

- [Implementation evidence](../../akeed-backend/docs/US-04-04-STANDALONE-DASHBOARD-AND-ACTIONS-EVIDENCE.md)

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
