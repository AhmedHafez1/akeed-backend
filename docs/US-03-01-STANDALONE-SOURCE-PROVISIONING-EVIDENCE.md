# US-03-01 Standalone source provisioning evidence

**Validated:** 2026-09-03  
**Revision:** backend and frontend working trees  
**Decision:** local implementation passes; production rollout remains **NO-GO** until US-02-07 external validation and US-03-02 entitlement activation are complete

## Acceptance evidence

1. Supabase provisioning now creates the organization, owner membership, and one active Standalone integration in one database transaction. The source identity is `standalone:<orgId>`; credentials are null, onboarding is pending, automatic verification is disabled, and the missing-payment COD default is false.
2. A transaction-scoped advisory lock serializes provisioning per authenticated user. Stable organization/source uniqueness and a partial unique database index prevent duplicate active sources. The PostgreSQL contract proves three concurrent calls return one organization and source, a source-less organization resumes idempotently, and only one call reports each record as created.
3. `StandaloneOrderEligibilityStrategy` is registered beside Shopify. It uses only canonical COD status and payment signals. Missing evidence remains ineligible unless the persisted merchant fallback is explicitly true; Shopify-shaped raw payload data is ignored.
4. Injected source insertion failure rolls the organization and membership back. A later retry succeeds. A Supabase user who owns a Shopify source receives `409 STANDALONE_SOURCE_CONFLICT`, and the contract proves the Shopify source, active state, and credential remain unchanged.
5. AuthGuard's existing promise deduplication, retry, and sign-out recovery remain intact. Arabic and English error copy now identifies both organization and order-source setup; the existing direction-neutral layout continues to support RTL/LTR.

## Verification results

| Check                                                 | Result                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused provisioning/eligibility Jest suites          | PASS — 4 suites, 35 tests                                                                                                                                          |
| `./scripts/test-standalone-provisioning-contract.ps1` | PASS — disposable PostgreSQL 17, 5 tests including preflight, concurrency, rollback/resume, uniqueness, deterministic identity ownership, and Shopify preservation |
| `npm test -- --runInBand`                             | PASS — 48 suites, 505 tests                                                                                                                                        |
| `npm run build`                                       | PASS                                                                                                                                                               |
| `npx eslint "{src,apps,libs,test}/**/*.ts"`           | PASS — 0 errors; 19 pre-existing test warnings                                                                                                                     |
| `./scripts/test-e02-release-gate.ps1`                 | PASS — neutral core, Shopify characterization, three E02 PostgreSQL rehearsals, builds, lint, dual-mode fixture, and frontend checks                               |
| Frontend `npx tsc --noEmit`                           | PASS on repeat after Next regenerated its ignored route declaration                                                                                                |
| Frontend `npm run smoke:e02:typecheck`                | PASS                                                                                                                                                               |
| Frontend `npm run lint`                               | PASS                                                                                                                                                               |
| Frontend isolated production build                    | PASS — 19 generated application pages/routes                                                                                                                       |

No live provider calls, application-database migration, account provisioning, entitlement activation, or real-order send occurred during validation.

## Migration and rollout

Migration `0026_standalone_source_provisioning.sql` first reports and aborts on organizations with multiple active integrations. In staging, retain that exception output and stop until every affected organization has an evidence-backed primary source decision. After the preflight passes, the migration adds the false-by-default COD fallback and the one-active-source index without backfilling existing accounts.

Roll out provisioning only for new Standalone registrations. Keep the source blocked from automated sends through `is_auto_verify_enabled=false`, `onboarding_status=pending`, and absent entitlement until US-03-02/US-03-03 activate those states. Monitor `STANDALONE_SOURCE_CONFLICT` and provisioning failure logs by user, organization, and integration identifiers; logs contain no credentials.

For application rollback, stop new Standalone registration and deploy the prior compatible application. Preserve provisioned organizations, memberships, integrations, and inactive history. Do not drop the unique index or column while the newer application may still be running, and do not delete accepted records as an operational rollback.

## Remaining release blockers

- Complete US-02-07's staging migration/Redis drill and authenticated dual-mode validation.
- Implement US-03-02 before granting the pilot entitlement or backfilling existing Standalone accounts.
- Implement US-03-03 before exposing the persisted COD fallback and onboarding settings to merchants.
