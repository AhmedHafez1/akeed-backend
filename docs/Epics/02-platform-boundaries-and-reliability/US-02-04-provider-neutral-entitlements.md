# US-02-04 — Separate Shopify billing from verification entitlement

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 4 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented — dedicated contract environment and authenticated release validation pending 2026-09-02
- **Dependencies:** [US-02-03](../02-platform-boundaries-and-reliability/US-02-03-shopify-adapter-and-core-decoupling.md)

## User story and value

As a Standalone merchant, I want verification access without a Shopify subscription, so that I can pilot Akeed without pretending to own a Shopify store.

**Business value:** I can pilot Akeed without pretending to own a Shopify store.

## Scope

Separate commerce administration from subscription operations and define provider-neutral entitlement access.

**Out of scope:** Selecting or integrating a new payment processor.

## Acceptance criteria

1. Shopify subscription create/status/cancel behavior remains isolated in a Shopify billing adapter and passes current billing tests.
2. Core eligibility/reservation accepts an explicitly provisioned not_required entitlement without calling Shopify.
3. Blocked billing or inactive sources still stop execution-time sending and usage reservations.
4. Usage remains integration-scoped under the one-primary-source rule, with the existing plan limits rather than invented quotas.

## Implementation notes

- **Backend:** Separate billing contracts from StorePlatformPort and use one entitlement reader/reservation boundary.
- **Frontend:** Display manual/free pilot status without Shopify approval links; preserve embedded billing behavior.
- **Data:** Retain existing Shopify subscription IDs and usage history; add only fields needed to represent provider-neutral activation.
- **Operations:** Manual entitlement changes require authorized staff procedures and an audit trail; no public self-upgrade bypass.

## Test requirements

- Shopify subscription regression; not_required activation; inactive/blocked/limit scenarios.
- Assert Standalone entitlement resolution makes zero Shopify billing calls.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Do not migrate existing Shopify merchants to not_required; activation of Standalone is explicit.

## Evidence and references

Implementation and test results: [US-02-04 evidence](../../akeed-backend/docs/US-02-04-PROVIDER-NEUTRAL-ENTITLEMENTS-EVIDENCE.md). Staff activation/backfill remains in US-03-02; this story adds no activation writer or migration.

**VERIFIED FROM CODE:** BillingService is Shopify-centric while isBillingStatusActive already accepts active and not_required.

- [akeed-backend/src/modules/onboarding/billing.service.ts](../../akeed-backend/src/modules/onboarding/billing.service.ts)
- [akeed-backend/src/modules/verification-core/billing-entitlement.service.ts](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.ts)
- [akeed-backend/src/shared/utils/billing.util.ts](../../akeed-backend/src/shared/utils/billing.util.ts)
- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)

**RELEASE VALIDATION PENDING:** Local unit, HTTP, build, lint, typecheck, and isolated UI results are recorded in the implementation evidence. Dedicated PostgreSQL execution and authenticated live-app validation remain open; no live readiness is claimed.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
