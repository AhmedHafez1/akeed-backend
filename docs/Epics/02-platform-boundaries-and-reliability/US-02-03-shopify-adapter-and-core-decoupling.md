# US-02-03 — Move Shopify actions behind the adapter

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 3 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented — dedicated contract environment pending 2026-09-02
- **Dependencies:** [US-02-02](../02-platform-boundaries-and-reliability/US-02-02-commerce-outcome-adapter-registry.md)

## User story and value

As a Shopify merchant, I want platform expansion without changes to existing order outcomes, so that my current workflow remains stable while new merchants are supported.

**Business value:** My current workflow remains stable while new merchants are supported.

## Scope

Migrate hub, send, automation and merchant actions to trusted integration dispatch and preserve GraphQL behavior.

**Out of scope:** Changing customer cancellation into remote Shopify cancellation.

## Acceptance criteria

1. All E01 outcome fixtures pass after hub/automation/merchant actions move behind adapter dispatch.
2. The send path requires the order's integration; missing/mismatched integration fails explicitly instead of looking for Shopify.
3. Customer outcomes retain tags; merchant no-reply cancellation retains the GraphQL action and asynchronous reference.
4. Public cancellation consumers use provider-neutral operation naming together; no backend/frontend contract mismatch is released.

## Implementation notes

- **Backend:** Wrap the existing GraphQL adapter rather than replace it; remove Shopify dependencies/fallbacks from verification core.
- **Frontend:** Update cancellation types/messages and capability handling together in embedded and standalone domain hooks.
- **Data:** No rewriting of historical outcomes or external IDs; retain provider references already stored.
- **Operations:** Document actual GraphQL usage and reconcile stale REST-oriented repository prose as part of this future implementation.

## Test requirements

- Run E01, adapter contracts, synthetic test-order safeguards and missing-integration tests.
- Compile both frontend modes against the neutral cancellation response.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Ship coordinated backend/frontend contract changes with a compatibility bridge if deployments are not atomic.

## Evidence and references

**E01 input-boundary discrepancy (2026-08-31):** The real HTTP harness proves the global whitelist removes `transactions`, although the real Shopify eligibility strategy accepts transaction-only COD evidence. [Reproduction and limits](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). **Owner: E02 Shopify adapter implementer.** Preserve this characterization and separately review DTO/raw-payload retention when changing the adapter boundary; do not silently claim parity between direct strategy fixtures and HTTP ingestion.

**IMPLEMENTED 2026-09-02:** Core outcomes use trusted registry dispatch; sends require the linked integration. Both dashboard hooks consume the neutral cancellation response. The controller retains `shopifyJobId` only as a temporary compatibility alias. [Implementation, tests, limits and rollout evidence](../../akeed-backend/docs/US-02-03-SHOPIFY-ADAPTER-EVIDENCE.md).

- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-frontend/src/features/dashboard/domain/useDashboard.ts](../../akeed-frontend/src/features/dashboard/domain/useDashboard.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)

**RELEASE VALIDATION PENDING:** Implementation and local verification are recorded in the evidence above. The isolated PostgreSQL contract needs its dedicated environment; authenticated application smoke and live provider validation remain release checks. This story is not a live-rollout approval.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Shopify — GraphQL orderCancel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel)
