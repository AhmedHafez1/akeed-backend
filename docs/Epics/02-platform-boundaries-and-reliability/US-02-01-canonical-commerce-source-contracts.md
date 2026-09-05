# US-02-01 — Define platform-neutral source and order contracts

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 1 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Complete — validated 2026-09-02
- **Dependencies:** [US-01-06](../01-shopify-baseline-stabilization/US-01-06-dual-mode-regression-release-gate.md)

## User story and value

As a platform integrator, I want one canonical order contract across commerce sources, so that new integrations can reuse verification without carrying Shopify assumptions.

**Business value:** New integrations can reuse verification without carrying Shopify assumptions.

## Scope

Shared platform type, database platform constraint, normalized source/order fields and eligibility contracts.

**Out of scope:** Implementing native EasyOrders/WooCommerce adapters.

## Acceptance criteria

1. TypeScript and database platform values include standalone and easyorders while retaining existing values.
2. The canonical contract defines trusted org/integration identity, source order ID/reference, E.164 phone, optional name, decimal amount, currency and payment/COD signals.
3. rawPayload is safely typed and platform-specific parsing remains in adapters/strategies.
4. Unknown platform or unsupported eligibility is explicit; no Shopify fallback is introduced.

## Implementation notes

- **Backend:** Align queue/normalizer/core types; keep existing Shopify fixtures passing and preserve extension points.
- **Frontend:** Preserve current DTO compatibility; do not expose new platform selectors before their onboarding is ready.
- **Data:** Use an additive checked migration and inventory all platform constraints, including billing-related constraints.
- **Operations:** Document compatibility and rollback: old values remain valid and no existing integration is rewritten.

## Test requirements

- Type/contract tests for all supported enum values and unknown-platform rejection.
- Migration rehearsal against representative existing Shopify rows.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Expand constraints before deploying writes of new values; rollback must not remove values already used.

## Evidence and references

**VERIFIED FROM CODE:** PlatformType and schema checks lack standalone/easyorders; NormalizedOrder includes platform-specific comments and an any payload.

- [akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.constants.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

## Implementation evidence

**Implemented 2026-09-02:** The shared platform/order contract, Shopify compatibility path, explicit unsupported-platform handling, expanded Drizzle constraints, migration, and automated contract coverage are implemented. The full backend suite passes with 380 tests; build, structured-log validation, and non-fixing lint pass. No frontend selectors or native adapters were added, and no existing integration rows are rewritten.

The detailed [validation and rollout record](../../akeed-backend/docs/US-02-01-CANONICAL-COMMERCE-CONTRACT-EVIDENCE.md) records commands and limitations. The migration was verified directly against the configured Supabase development database using rollback-only probes: both new values were accepted, unknown values were rejected, both constraints were validated, and the representative Shopify rows remained unchanged. The disposable Docker harness remains unavailable on this host, but is no longer the database validation blocker for this story.
