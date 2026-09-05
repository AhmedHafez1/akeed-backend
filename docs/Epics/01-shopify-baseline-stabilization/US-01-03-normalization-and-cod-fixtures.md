# US-01-03 — Protect Shopify normalization and COD eligibility

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 3 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Complete — evidence validated 2026-08-31; US-01-06 gate completed
- **Dependencies:** [US-01-01](US-01-01-deterministic-test-baseline.md)

## User story and value

As a Shopify merchant, I want order details and COD eligibility to remain consistent, so that the correct customer receives an accurate verification request.

**Business value:** The correct customer receives an accurate verification request.

## Scope

Sanitized fixture coverage for phone, name, amount, reference, currency and payment signals.

**Out of scope:** A new generic payment classifier or changing current COD matching.

## Acceptance criteria

1. Fixtures cover E.164 and local-format phone inputs, missing customer fields, decimal totals and order-reference variants.
2. COD fixtures exercise paymentMethod and the existing gateway/transaction signal paths, including Arabic matches.
3. Non-COD and missing-payment-signal orders remain ineligible with their current reasons.
4. Normalizer output preserves organization/integration identity supplied by trusted integration resolution.

## Implementation notes

- **Backend:** Test ShopifyOrderNormalizer and ShopifyOrderEligibilityStrategy independently and together.
- **Frontend:** No UI changes; assert display fields remain compatible with dashboard expectations.
- **Data:** Keep fixtures synthetic and assert currency/amount precision without floating-point rounding.
- **Operations:** Document why each fixture exists so future adapters can reuse the contract shape.

## Test requirements

- Table-driven happy, missing-field, malformed-phone, non-COD and Arabic payment cases.
- Contract comparison against the current NormalizedOrder fields.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Characterization only; unexpected mappings require a separate product decision.

## Evidence and references

**Implementation evidence (2026-08-31):** [Real phone/normalizer/eligibility fixtures](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). The HTTP harness also records global validation stripping transaction-only payment evidence before ingestion; direct normalizer/strategy coverage is not proof that every raw field survives HTTP validation.

**VERIFIED FROM CODE:** NormalizedOrder is shared, while the registered eligibility strategy and normalizer are Shopify-specific.

- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts](../../akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/modules/verification-core/strategies/shopify-order-eligibility.strategy.ts](../../akeed-backend/src/modules/verification-core/strategies/shopify-order-eligibility.strategy.ts)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
