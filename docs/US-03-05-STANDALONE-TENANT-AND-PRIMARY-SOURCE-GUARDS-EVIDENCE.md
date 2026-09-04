# US-03-05 tenant and primary-source guard evidence

**Validated:** 2026-09-04  
**Revision:** backend and frontend working trees  
**Decision:** implemented locally; release remains blocked by target-environment identity, provider, migration, and inherited E02 validation

## Implemented behavior

- Every authenticated request resolves a fresh organization membership and trusted role. Supabase keeps deterministic first-membership selection; Shopify keeps owner-first selection. The same unchanged token therefore reflects demotion or membership removal on the next request.
- One shared service-level guard permits organization-scoped mutations only for owners and admins. It protects organization configuration, onboarding settings/completion/billing, test sends, and merchant no-reply cancellation before any repository write, provider call, quota reservation, or commerce outcome.
- Tenant and source identity continue to come only from authenticated context. DTO whitelisting ignores forged organization, integration, source, role, billing, and activation fields, and isolation tests prove that another tenant is not queried or changed.
- `GET /api/verifications` adds `page_context.permissions.can_send_test_verification` and `page_context.permissions.can_cancel_orders`. Both are false for viewers. The frontend treats missing permissions as false.
- Standalone and embedded English/Arabic views retain readable values while showing a read-only notice and omitting save, completion, billing, test-send, and cancellation actions. Defensive handlers still fail closed and expose accessible alert feedback after a stale page receives a backend denial.
- Billing initiation requires both the existing source billing capability and owner/admin role. Existing Shopify response behavior and published endpoint-specific denial codes remain compatible; organization updates and cancellation use stable role-denial codes.
- Migration `0026_standalone_source_provisioning.sql` remains the schema authority; no new migration was needed. Its partial unique index is now exercised by a competing-insert race that proves exactly one active source wins.
- Existing active Standalone sources remain idempotent. Every Shopify/native source owner, including an inactive historical source owner, is rejected without conversion, replacement, or mutation.
- `npm run test:gate:e03` composes the E02 compatibility gate, structured-log contract, authorization suites, Standalone provisioning/concurrency contract, and Standalone pilot contract.

## Validation results

| Check | Result |
| --- | --- |
| E03 release gate | PASS |
| Inherited E02 compatibility gate | PASS |
| Full backend Jest regression | PASS — 52 suites, 573 tests |
| Focused tenant and role suites | PASS — 6 suites, 77 tests |
| PostgreSQL Standalone provisioning/concurrency contract | PASS — 1 suite, 7 tests |
| PostgreSQL Standalone pilot/authorization contract | PASS — 1 suite, 8 tests |
| PostgreSQL E02 migration, Shopify, and source-retention contracts | PASS — 3 suites, 13 tests |
| Backend build | PASS |
| Backend structured-log check | PASS — 0 violations |
| Backend non-fixing ESLint | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in tests |
| Frontend application type-check | PASS |
| Frontend dual-mode fixture type-check | PASS |
| Local owner/admin/viewer permission fixture | PASS — embedded and Standalone, English/LTR and Arabic/RTL (12 role/mode/locale cases) |
| Local stale-role cancellation fixture | PASS — localized `role="alert"`, retained order, and enabled retry in both modes/locales (4 cases) |
| Frontend lint | PASS |
| Frontend production build | PASS |
| Authenticated owner/admin/viewer English/Arabic target-environment smoke | NOT RUN — requires deployed identities and current memberships |
| Live Meta send/callback and Shopify billing validation | NOT RUN — requires authorized provider accounts and target environment |
| Production migrations or legacy data intervention | NOT RUN |

The PostgreSQL wrappers created isolated disposable test databases. They did not use the application database. `E01_TEST_DATABASE_URL` was not required and remains the documented option for an explicitly isolated test database.

## Operational preflight and rollback

Use the eligible cohorts, legacy conflict query, no-source-switching policy, audit requirements, and rollback procedure in [Environment Management](ENVIRONMENT.md#standalone-source-eligibility-and-support-policy). Any reported legacy conflict blocks rollout. Do not automatically repair, deactivate, replace, or convert a commerce source.

Deploy the compatible backend and frontend together. If authorization failures, unexpected source conflicts, or UI permission mismatches appear, disable Standalone pilot activation and roll back the application release. Preserve all source, membership, entitlement, audit, verification, and usage records for investigation. Migration `0026` is additive and its uniqueness invariant must not be removed as a rollback shortcut.

## Remaining release blockers

- Run authenticated owner/admin/viewer smoke tests in English/LTR and Arabic/RTL against the target environment, including a same-token demotion and membership removal.
- Run one authorized live Meta test send/callback and verify that role denial produces no provider activity or commerce outcome.
- Validate Shopify billing initiation and embedded controls with owner/admin/viewer identities in the target environment.
- Run the inherited E02 external staging/provider checks and deploy/reconcile the required migrations against reviewed preflight results.
- Obtain the normal deployment, data-intervention, and pilot approvals. Local green gates do not authorize production migration or source repair.
