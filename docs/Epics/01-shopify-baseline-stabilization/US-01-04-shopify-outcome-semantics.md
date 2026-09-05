# US-01-04 — Protect Shopify confirmation and cancellation semantics

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Complete — evidence validated 2026-08-31; US-01-06 gate completed
- **Dependencies:** [US-01-01](US-01-01-deterministic-test-baseline.md)

## User story and value

As a Shopify merchant, I want verification outcomes to preserve their current order actions, so that a refactor cannot accidentally cancel or alter real orders.

**Business value:** A refactor cannot accidentally cancel or alter real orders.

## Scope

Customer confirmation/cancellation, merchant no-reply cancellation, automatic no-reply tagging and late replies.

**Out of scope:** Making customer cancellation call Shopify orderCancel.

## Acceptance criteria

1. Customer confirmation and cancellation update local state and request the current Shopify tags without invoking orderCancel.
2. Merchant cancellation of an eligible no_reply verification calls Shopify cancellation and returns the existing `shopifyJobId` response field. The reference is not durably retained or polled; this does not establish completed remote cancellation.
3. Automatic no-reply escalation preserves its tagging behavior; synthetic test orders do not mutate Shopify.
4. Late replies cannot override a merchant cancellation, and external failures preserve the characterized local/error behavior.

## Implementation notes

- **Backend:** Mock the GraphQL adapter at the port boundary and distinguish each action path.
- **Frontend:** Assert existing cancellation response fields and merchant feedback before the later neutral rename.
- **Data:** Use isolated verification/order states and include organization ownership failures.
- **Operations:** No test may perform irreversible cancellation against a production order.

## Test requirements

- Confirmed, customer-canceled, merchant-canceled, no_reply and late-reply scenarios.
- Provider rejection, missing order/integration, and duplicate action characterization.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Treat these tests as required compatibility checks for every adapter refactor.

## Evidence and references

**Implementation evidence (2026-08-31):** [Adapter and composed customer-reply checks](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md), alongside existing merchant ownership, late-reply and provider-failure tests. Merchant UI smoke evidence remains part of US-01-06.

**VERIFIED FROM CODE:** Customer outcomes use tagging; merchant no-reply cancellation returns shopifyJobId through a different service path.

- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)
- [akeed-frontend/src/features/dashboard/domain/useDashboard.ts](../../akeed-frontend/src/features/dashboard/domain/useDashboard.ts)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Shopify — GraphQL orderCancel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel)
