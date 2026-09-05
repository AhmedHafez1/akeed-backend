# US-02-02 — Introduce capability-aware commerce outcome dispatch

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 2 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented — dedicated contract environment pending 2026-09-02
- **Dependencies:** [US-02-01](../02-platform-boundaries-and-reliability/US-02-01-canonical-commerce-source-contracts.md)

## User story and value

As a merchant, I want verification outcomes handled by my order source, so that Akeed does not send commerce actions to the wrong provider.

**Business value:** Akeed does not send commerce actions to the wrong provider.

## Scope

Registry keyed by integration.platformType and typed outcomes/capability results.

**Out of scope:** A new billing provider or arbitrary provider-specific logic inside core.

## Acceptance criteria

1. Dispatch selects an adapter from the order's trusted integration, never from a global Shopify binding or caller-supplied platform.
2. Contracts cover customer confirmation/cancellation, merchant no-reply cancellation and existing automatic no-reply tagging behavior.
3. Results distinguish applied, unsupported, pending provider operation, retryable failure and permanent failure without claiming remote success prematurely.
4. An unknown adapter or unsupported capability produces an explicit result and no outbound commerce call.

## Implementation notes

- **Backend:** Keep registry small and in-process; expose providerOperationId when a provider returns asynchronous work.
- **Frontend:** Define platform-neutral capability and operation-result shapes for later merchant UI adoption.
- **Data:** Carry orgId, integrationId and externalOrderId through dispatch; validate their relationships.
- **Operations:** Log safe source/action/correlation identifiers and distinguish local lifecycle from remote synchronization.

## Test requirements

- Registry selection for Shopify/Standalone fakes; unknown platform and unsupported actions.
- Attempt cross-tenant and mismatched integration/order dispatch.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Introduce the contract behind compatibility tests before moving existing call sites.

## Evidence and references

**VERIFIED FROM CODE:** AppModule globally binds order administration/tagging to ShopifyApiService, preventing per-integration selection.

- [akeed-backend/src/app.module.ts](../../akeed-backend/src/app.module.ts)
- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

## Implementation evidence

**Implemented 2026-09-02:** The backend now has a capability-aware, in-process outcome registry selected from the persisted order integration, source-relationship validation, typed remote synchronization results, safe structured logging, and explicit no-call results for unsupported or invalid dispatch. Matching frontend models are defined for later UI adoption. Existing Shopify call sites remain on their compatibility path until US-02-03.

The detailed [validation and rollback record](../../akeed-backend/docs/US-02-02-COMMERCE-OUTCOME-REGISTRY-EVIDENCE.md) records 399 passing backend tests, successful backend/frontend builds and static checks, and the unavailable dedicated Shopify contract run. That command remains pending because the isolated `E01_TEST_DATABASE_URL` is not configured; the harness correctly refused to use the application database.
