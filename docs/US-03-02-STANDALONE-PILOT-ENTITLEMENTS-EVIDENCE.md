# US-03-02 Standalone pilot entitlements evidence

**Validated:** 2026-09-03  
**Revision:** backend and frontend working trees  
**Decision:** local implementation passes; activation and production backfill remain **NO-GO** until deployment and inherited release gates are complete

## Implemented behavior

- Staff with the existing Supabase `akeed_role=admin` and production AAL2 requirement can list organizations, preview up to 50 selected accounts, and apply exactly their saved preview. `STANDALONE_PILOT_ACTIVATION_ENABLED` defaults to false. The preview remains read-only while application is disabled.
- A shared deterministic policy classifies source-free and active Standalone organizations as eligible only when ownership, source identity, billing fields, and accounting history are unambiguous. Native sources/history and disconnected sources are skipped. Conflicts are reported for review rather than repaired by inference.
- Eligible accounts receive the existing Starter entitlement (`not_required`, 30 verifications per period). A missing source is created as `standalone:<orgId>` with automation disabled and onboarding pending. Existing memberships, settings, onboarding progress, source IDs, billing anchors, usage rows, orders, and history are retained.
- Preview state is stored without credentials in `admin_access_audit`. Apply locks and re-evaluates each organization in its own serializable transaction. Changed rows require a new preview. Successful activation and its actor, reason, time, source creation, and before/after entitlement values are committed atomically; audit failure rolls the account back. Replaying a completed preview does not duplicate activation or audit.
- Migration `0027_standalone_pilot_permissions.sql` revokes direct DML and column-level write grants on integrations, monthly usage, and admin audit records from public merchant roles, while retaining existing reads and backend `service_role` writes.
- The localized admin page at `/{locale}/admin/standalone-pilots` provides pagination, 50-row selection, dry-run counts, exception details, reason entry, apply/retry results, and JSON preview/result downloads. Existing merchant settings continue to show the manual pilot and usage through the provider-neutral contract.

## Validation results

| Check | Result |
| --- | --- |
| New staff boundary/policy/batch Jest suites | PASS — 3 suites, 43 tests |
| Full backend Jest regression | PASS — 51 suites, 548 tests |
| Disposable PostgreSQL 17 contract | PASS — 8 tests: apply/replay, audit rollback, signup concurrency, stale preview, usage preservation, Starter quota, and three direct-write checks |
| Backend TypeScript/build/log check | PASS |
| Backend non-fixing ESLint | PASS — 0 errors; 19 pre-existing unsafe-argument warnings in unrelated tests |
| Frontend application and fixture typechecks | PASS |
| Frontend lint and production build | PASS |
| Isolated English browser workflow | PASS — two-account preview, one committed/one failed result, retry preserved the first and activated the second |
| Isolated Arabic browser workflow | PASS — localized eligibility/source states with `lang=ar`, `dir=rtl`, and computed RTL direction |

The PostgreSQL and browser fixtures are synthetic and loopback-only. No application database migration, live staff operation, merchant activation, subscription operation, provider call, real order, or WhatsApp send occurred.

## Deployment and operation

1. Back up and reconcile organization, membership, integration, usage, order, and entitlement counts. Inspect direct table and column grants for `PUBLIC`, `anon`, `authenticated`, and `service_role`.
2. Apply migration `0027`, then prove merchant roles retain required reads and cannot insert, update, delete, truncate, reference, or trigger on the protected tables. Prove the deployed backend database principal still completes its normal repository writes.
3. Deploy backend and both locale bundles with `STANDALONE_PILOT_ACTIVATION_ENABLED=false`. Perform real staff AAL2 access and Arabic/English read-only preview smoke checks. Retain the preview and exception report.
4. Resolve every ambiguous row explicitly. Enable activation for an approved maintenance window, select no more than 50 reviewed organization IDs, record a non-secret approval/support reason, preview again, and apply. Reconcile returned audit IDs and before/after counts after each batch. Disable activation when the approved batch is complete.
5. Monitor activation failures, preview changes, entitlement denials, and source conflicts by organization/integration identifiers. Do not log credentials, customer data, preview contents, or free-form reasons.

For application rollback, disable activation first and deploy the previous compatible code. Retain migration `0027`, audit rows, organizations, sources, memberships, usage, orders, and history. A supervised data rollback may restore recorded `before` entitlement fields only when the current row still matches the audited `after` state and no subsequent usage or order activity relies on it. Remove a newly introduced source only when its audit records `sourceCreated=true`, it remains unchanged, and it has no usage, order, verification, or other references. Keep the audit record and record the rollback separately.

## Remaining release blockers

- Complete US-02-07 staging migration/Redis rehearsal and authenticated dual-mode validation.
- Rehearse migration `0027` against staging grants and the deployed backend principal.
- Complete authenticated staff preview smoke checks before enabling activation.
- Implement US-03-03 before presenting onboarding as complete, and US-03-04 before offering test verification.
