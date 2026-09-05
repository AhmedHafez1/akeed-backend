# US-03-01 — Provision a first-class Standalone commerce source

- **Epic:** [E03 — Standalone Foundation and Onboarding](README.md)
- **Delivery rank:** 1 of 5
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Feature
- **Status:** Implemented locally — release blocked by US-02-07 external validation and US-03-02 entitlement work (2026-09-03)
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md)

## User story and value

As a new Standalone merchant, I want an organization with its own order source, so that I can use verification without any Shopify installation.

**Business value:** I can use verification without any Shopify installation.

## Scope

Transactional source provisioning, stable identity and Standalone payment eligibility.

**Out of scope:** Manual real-order entry, API keys and native adapter installation.

## Acceptance criteria

1. A new Standalone signup has one organization, owner membership and standalone integration with a stable source identity.
2. Repeated/concurrent provisioning returns the same records and never duplicates the primary source.
3. A registered Standalone eligibility strategy uses explicit payment signals; missing signals are not assumed COD unless a saved merchant default permits it.
4. Provisioning failure rolls back partial records or resumes idempotently; no Shopify integration/credentials are created or selected.

## Implementation notes

- **Backend:** Extend organization provisioning and source resolution; enforce a unique primary-source invariant transactionally.
- **Frontend:** Keep AuthGuard provisioning idempotent and surface recoverable setup failures in Arabic/English with RTL support.
- **Data:** Use standalone:<orgId> or an equivalent internal stable identity, not a fabricated public shop URL.
- **Operations:** Source starts with onboarding incomplete; no automated real-order send until entitlement and onboarding are ready.

## Test requirements

- First signup, concurrent retry, partial failure and existing Shopify-owner scenarios.
- Standalone COD/non-COD/default eligibility tests without Shopify services.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Roll out only to new Standalone registrations first; existing accounts are handled in US-03-02.

## Evidence and references

**Implementation evidence (2026-09-03):** [US-03-01 implementation evidence](../../akeed-backend/docs/US-03-01-STANDALONE-SOURCE-PROVISIONING-EVIDENCE.md) records transactional provisioning, stable source identity, concurrent retry/rollback PostgreSQL contracts, Standalone payment eligibility, localized recovery copy, compatibility gates, and rollout stop criteria. Local checks pass; no migration or live account rollout was performed.

**IMPLEMENTED IN CODE:** Standalone provisioning now writes the organization, owner membership, and stable Standalone integration transactionally; eligibility registration includes independent Shopify and Standalone strategies.

- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)
- [akeed-frontend/src/shared/auth/AuthGuard.tsx](../../akeed-frontend/src/shared/auth/AuthGuard.tsx)
- [akeed-backend/src/modules/verification-core/order-eligibility.service.ts](../../akeed-backend/src/modules/verification-core/order-eligibility.service.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
