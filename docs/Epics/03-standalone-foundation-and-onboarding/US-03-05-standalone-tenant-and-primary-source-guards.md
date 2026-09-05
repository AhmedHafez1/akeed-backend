# US-03-05 — Enforce organization roles and one primary source

- **Epic:** [E03 — Standalone Foundation and Onboarding](README.md)
- **Delivery rank:** 5 of 5
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Implemented locally — release blocked (2026-09-04)
- **Dependencies:** [US-03-04](../03-standalone-foundation-and-onboarding/US-03-04-standalone-test-verification.md)

## User story and value

As a organization owner, I want source and setup changes restricted to authorized people, so that another tenant or viewer cannot change my verification behavior.

**Business value:** Another tenant or viewer cannot change my verification behavior.

## Scope

End-to-end source ownership, owner/admin writes, viewer reads and single-primary-source guard.

**Out of scope:** Organization switching, arbitrary multi-source accounts and source replacement workflows.

## Acceptance criteria

1. Every onboarding/settings/test operation resolves organization from authenticated context; forged org/source fields cannot retarget it.
2. Owners/admins can perform permitted mutations; viewers cannot create sources, change settings or send tests.
3. Concurrent provisioning cannot activate two primary commerce sources for the same organization.
4. Existing active Shopify/native sources are not overwritten; future native pilots use fresh or unprovisioned organizations rather than silently converting an active Standalone source.
5. Full signup-to-test journey passes without Shopify dependencies and preserves current first-membership behavior.

## Implementation notes

- **Backend:** Enforce roles and ownership in backend services/guards, not UI visibility or assumed database RLS alone.
- **Frontend:** Hide unavailable mutations while still rendering backend denial/error states accessibly in both locales.
- **Data:** Verify the primary-source invariant at the database/transaction boundary and report legacy exceptions.
- **Operations:** Document eligible account cohorts and no-source-switching support policy.

## Test requirements

- Two tenants, all membership roles, forged IDs, concurrent provisioning and stale session requests.
- Complete E03 acceptance plus E01/E02 compatibility gates.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Block Standalone launch on any tenant or role bypass; keep support intervention auditable.

## Evidence and references

**VERIFIED LOCALLY:** Request authentication now carries a freshly resolved membership role, service-level owner/admin guards cover every organization-scoped mutation in this story, viewer UI permissions fail closed, and the existing primary-source index passes a competing-insert PostgreSQL race. The complete E03 gate passed on 2026-09-04.

- [Dated US-03-05 implementation and validation evidence](../../akeed-backend/docs/US-03-05-STANDALONE-TENANT-AND-PRIMARY-SOURCE-GUARDS-EVIDENCE.md)

- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/organizations/organizations.controller.ts](../../akeed-backend/src/modules/organizations/organizations.controller.ts)
- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/modules/auth/services/token-validator.service.ts](../../akeed-backend/src/modules/auth/services/token-validator.service.ts)
- [akeed-backend/src/infrastructure/database/repositories/memberships.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/memberships.repository.ts)
- [akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/standalone-organization-provisioning.repository.ts)

**REQUIRES TARGET-ENVIRONMENT VALIDATION:** Authenticated owner/admin/viewer English/Arabic smoke, same-token membership changes, live Meta send/callback, Shopify billing, reviewed migrations, and inherited E02 external checks remain release blockers.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
