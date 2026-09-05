# US-02-07 — Verify adapter independence and migration compatibility

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 7 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Implemented — local gate passes; staging migration/Redis drill and authenticated validation block release 2026-09-03
- **Dependencies:** [US-02-06](../02-platform-boundaries-and-reliability/US-02-06-recoverable-webhook-dispatch.md)

## User story and value

As a release owner, I want evidence that the shared platform boundary is safe, so that new adapters can be introduced without weakening Shopify or tenant isolation.

**Business value:** New adapters can be introduced without weakening Shopify or tenant isolation.

## Scope

E02 integration/contract acceptance and phased database/application rollout rehearsal.

**Out of scope:** Declaring unimplemented native adapters production-ready.

## Acceptance criteria

1. Core verification scenarios instantiate without ShopifyApiService and use registry test adapters.
2. Shopify E01 characterization and neutral API consumers remain green.
3. Unknown/unsupported actions, cross-tenant identity, disconnected sources and queue recovery have automated coverage.
4. Expand/backfill/deploy rollback is rehearsed on synthetic legacy rows; unresolved ownership exceptions block rollout.

## Implementation notes

- **Backend:** Publish a reusable adapter contract suite for current and future adapters, with provider-specific expectations separate.
- **Frontend:** Run both-mode typecheck/smoke against changed outcome and billing response shapes.
- **Data:** Verify historical order/usage counts and retained Shopify credentials/subscriptions after migration rehearsal.
- **Operations:** Record release evidence and stop criteria; do not use destructive rollback against accepted new-platform data.

## Test requirements

- Full backend regression, core-without-Shopify suite, adapter contracts and concurrency recovery checks.
- Frontend dual-mode smoke plus migration pre/post reconciliation.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

E03 and E06 remain blocked until all E02 P0 exit criteria are demonstrated.

## Evidence and references

**Implementation evidence (2026-09-03):** [US-02-07 release-gate evidence](../../akeed-backend/docs/US-02-07-PLATFORM-BOUNDARY-RELEASE-GATE-EVIDENCE.md) records the reusable adapter contract, core-without-Shopify suite, explicit boundary/recovery coverage, phased synthetic migration rehearsal, dual-mode fixture smoke, commands, results, rollback procedure, and release stop criteria. The local gate passes; the evidence retains a NO-GO decision until the listed staging and authenticated checks pass.

**VERIFIED FROM CODE:** The existing registry-shaped normalizer/eligibility architecture and repository tests offer seams for these contracts.

- [akeed-backend/src/modules/webhook-queue](../../akeed-backend/src/modules/webhook-queue)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/AGENTS.md](../../akeed-backend/AGENTS.md)
- [akeed-frontend/AGENTS.md](../../akeed-frontend/AGENTS.md)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
