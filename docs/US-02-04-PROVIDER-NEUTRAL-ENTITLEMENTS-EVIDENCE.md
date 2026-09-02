# US-02-04 — Provider-neutral entitlement evidence

Implementation date: 2026-09-02. Backend base: `8e7d4817ea46134270baa2fe4693d1d922be1abe`; frontend base: `dfb1a3c33b5c02785c6ca68cb5f3134861d14899`. Results cover the local working changes, not a deployed revision.

## Implemented behavior

- `StorePlatformPort` handles metadata only. `SubscriptionBillingPort` is bound to `ShopifyBillingAdapter`, which validates its source and delegates to the existing Admin GraphQL implementation. Existing billing workflow, callback validation, free-plan claims, pending upgrades, cancellation, and Shopify development/custom-app bypasses remain in place.
- `BillingEntitlementService` evaluates access, reads persisted entitlements/usage, reserves, and releases. Its shared policy and plan/period code have no onboarding or Shopify service dependency. Shopify retains `active`/`not_required` access and legacy Starter fallback. Other platforms require an active source, persisted `not_required`, a recognized plan, and a valid activation timestamp. Missing data never implicitly activates a pilot.
- Reservations accept trusted organization/integration identity, reload and lock the integration, evaluate entitlement, then lock/update the integration-period usage row in one transaction. Limits remain Starter 30, Basic 300, Pro 1,000, Scale 2,500; overages remain disabled. Access denials create no usage row; exhausted quotas increment the existing blocked counter. Failed sends release the original reservation period.
- Hub, sender, and automation share this access policy. Execution-time reservation denials retain their access reason rather than being reported as exhausted quota. Escalation checks current access without consuming a send slot. Order eligibility, onboarding prerequisites, scheduling, and outcome dispatch retain their separate responsibilities.
- Standalone settings select the sole active organization integration; none returns 404, ambiguity returns 409. Shopify sessions retain exact organization/shop lookup. Non-Shopify settings do not fetch Shopify store metadata or billing plans/claims. Current settings/dashboard usage is source-scoped and uses the shared plan/period calculation. With no active source, current dashboard usage is 0/0; historical funnel totals and persisted usage rows remain intact.

## HTTP and UI contract

`GET /api/onboarding/state`, settings responses, and settings update responses add `state.billingManagement`. `GET /api/onboarding/billing/plans` adds top-level `billingManagement`:

```json
{ "mode": "manual", "canManageBilling": false }
```

Shopify sources return mode `shopify`; active Shopify sources can manage billing. Manual plan lists are empty. Existing status/plan/usage fields and Shopify `{ "confirmationUrl": "..." }` responses remain unchanged. The descriptor contains no credentials.

Both hooks and skins require an explicit Shopify management capability before selection/activation. Missing capabilities fail closed. Manual status, assigned plan, usage, and a support message at the limit are localized in English/Arabic; purchase/approval controls are absent. Shopify integrations still support billing when accessed through the Standalone shell. Onboarding activation is similarly guarded; a missing management capability shows an unavailable message.

Merchant billing POST requests for manual sources return 403 before any provider/configuration call or local write, including Starter and development-bypass cases. Real controller/ValidationPipe tests show that both merchant settings PATCH routes strip billing, activation, and active-source fields. These HTTP tests substitute authentication with a synthetic validated principal; they are not production authentication or deployed database-grant evidence.

## Validation results

| Check | Result |
| --- | --- |
| Backend `npm test -- --runInBand --silent` | **43 suites, 468 tests passed** |
| Focused sender/manual-entitlement rerun after preserving denial logs | **2 suites, 23 tests passed** |
| Backend `npm run build` | Passed |
| Backend `npx --no-install tsc --noEmit --pretty false` | Passed, including contract test compilation |
| Backend non-fixing `npx --no-install eslint "{src,apps,libs,test}/**/*.ts"` | **0 errors, 19 existing test unsafe-argument warnings** |
| Backend `npm run log:check` | Passed, 0 violations |
| Frontend `npx --no-install tsc --noEmit --incremental false --pretty false` | Passed |
| Fixture typecheck with `-p test/e01-smoke/tsconfig.json` | Passed |
| Frontend `npm run lint` | Passed |
| Frontend `npm run build`, `NEXT_DIST_DIR=.next/e02-validation-build` | Passed; original tracked tsconfig restored after Next generated build-specific includes |
| Manual billing browser matrix | English/Arabic × embedded/Standalone passed: status and quota visible, purchase controls absent, direct hook selection/action leaves Starter selected and billing POST count at zero |
| Shopify billing browser matrix | English/Arabic × embedded/Standalone passed: plans visible, Pro selectable, confirmation redirects to the isolated fixture URL. English checks use the real plan-change control; Arabic checks also exercise the same hook directly. Arabic Enter-key selection and document `lang=ar`, `dir=rtl` verified |
| Missing capability and blocked status | English embedded and Arabic Standalone passed for both states: no purchase controls and zero billing POSTs |
| `npm run test:contract:entitlements` | **NOT RUN:** harness stops before connection because `E01_TEST_DATABASE_URL` is unset. Docker and psql are absent from PATH. No application database fallback was used |

Unit/HTTP coverage includes manual provisioning requirements, all existing plan limits, rolling periods, stale snapshots, inactive/blocked sources, tenant mismatch, failed-send release, zero Shopify calls, public activation rejection, settings field stripping, source ambiguity, and dashboard source scope. Existing Shopify billing, webhook, sending, automation, and outcome tests pass.

The new PostgreSQL contract suite exercises the real repository/service, the existing usage-table migration, 36 competing Starter reservations, source/billing changes committed after a caller snapshot, forged tenant/plan input, and period/source isolation with release. Compilation is not database execution evidence. Reservation authorization occurs under the integration lock; this does not claim that a later disconnect can recall a provider request already authorized and in flight.

The loopback fixture imports real settings hooks/skins, replaces the API boundary, and provides a no-op App Bridge loading stub. Synthetic approval redirects remain on loopback. No Shopify subscription, WhatsApp message, merchant activation, or live data change was performed. Authenticated full-layout and live-provider checks remain release gates; the fixture is functional UI evidence only.

## Staff activation, rollout, and recovery

1. US-03-02 owns staff activation tooling and backfill. Its authorized procedure must record staff actor, reason, timestamp, organization/integration identity, and before/after plan/status/activation values in an audit trail. Validate deployed direct-data permissions as part of that procedure; the HTTP whitelist does not prove database grant restrictions. Do not expose activation through merchant settings or billing routes.
2. Reuse the existing plan/status/activation fields. Do not bulk-set `not_required`, convert Shopify merchants, clear subscription IDs, reset usage, or provision new signup sources in this story. New signups and manual order ingestion still depend on E03/E04.
3. Provision the isolated local PostgreSQL environment specified in the E01 evidence and run `npm run test:contract:entitlements` plus `npm run test:contract:shopify` before release. The harness only accepts localhost, database `akeed_e01_test`, user `e01_test`; it never reads application `DATABASE_URL`.
4. Deploy the additive backend response first, then both frontend shells. Run authenticated English/Arabic smoke checks against that release. Keep pilot activation disabled until the staff/audit procedure and remaining release gates are complete.
5. Rollback is a matching application-code rollback. No data migration is introduced; retain all subscriptions, integration IDs, and historical usage. Rolling back the frontend also rolls back its manual-management safeguards, so keep manual activation disabled during rollback.

E02 and live rollout remain open. This evidence records implementation separately from the unexecuted database and live-app gates.
