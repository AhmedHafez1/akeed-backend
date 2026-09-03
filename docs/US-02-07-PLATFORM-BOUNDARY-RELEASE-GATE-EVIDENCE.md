# US-02-07 platform boundary release gate evidence

**Validated:** 2026-09-03  
**Revisions:** backend `d0acb7e` plus this working tree; frontend `051b2c7` plus this working tree  
**Decision:** local implementation gate passes; dependent production rollout remains **NO-GO** until the staging migration/Redis drill and authenticated dual-mode checks below pass

## Acceptance evidence

1. The verification-hub regression no longer constructs `ShopifyOutcomeAdapter` or imports `ShopifyApiService`. `platform-boundary-release-gate.spec.ts` compiles a Nest testing module from the real hub, registry, eligibility, and entitlement services with only a Standalone eligibility strategy and a registry test adapter. It processes and finalizes a normalized Standalone order. A static import guard prevents production verification-core files from acquiring a Shopify service dependency.
2. `defineCommerceOutcomeAdapterContract` is a reusable contract suite for current and future commerce outcome adapters. It verifies platform/capability declarations, every advertised action, neutral result states, non-empty provider/error references, and preservation of trusted request identity. Shopify runs this shared suite while its GraphQL URL, tags, cancellation variables, error mapping, test-order suppression, and module wiring remain in provider-specific tests. The existing neutral frontend response models are compile-checked by the dual-mode fixture.
3. Automated coverage now explicitly includes an unknown runtime action, unsupported capability and adapter, cross-tenant/mismatched identity, inactive/disconnected sources, deterministic webhook recovery, concurrent dispatch/processing claims, stale lease recovery, and completed replay fencing. The source-identity contract separately proves history retention on disconnect and explicit privacy redaction.
4. The E02 PostgreSQL rehearsal starts from synthetic pre-E02 legacy tables and rows, first proves an ambiguous owner reports `ambiguous_orders=1` and aborts migration `0024`, then applies migrations `0023`, `0024`, and `0025` in order. Order, verification, usage, webhook, integration, and lifecycle counts remain unchanged; missing source IDs are backfilled; usage count `7`, the synthetic encrypted Shopify token, webhook secret, and subscription ID remain unchanged. A source-aware pre-`0025` write remains compatible after the expand migration, while a new Standalone order remains retained during an application-only rollback rehearsal.

## Reusable gate commands

Run the complete local gate from `akeed-backend`:

```powershell
npm run test:gate:e02
```

The command is fail-fast and runs the neutral core suite, adapter contracts and Shopify expectations, full backend regression, all relevant disposable PostgreSQL contracts, backend build/non-fixing lint, frontend application and fixture typechecks, frontend lint, and an isolated production build. Docker contracts accept only their dedicated loopback database/user names and remove only the container IDs they created.

Individual migration rehearsal:

```powershell
./scripts/test-platform-boundary-migration-contract.ps1
```

## Verification results

| Check                                                     | Result                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:gate:e02`                                   | PASS — complete fail-fast local release gate                                                                                                                                                                  |
| `npm run test:core:platform-neutral`                      | PASS — 7 suites, 117 tests; real core with registry test adapter and no Shopify service                                                                                                                       |
| Shopify adapter shared/provider-specific suite            | PASS — 1 suite, 26 tests                                                                                                                                                                                      |
| `npm test -- --runInBand`                                 | PASS — 47 suites, 496 tests                                                                                                                                                                                   |
| `./scripts/test-shopify-contract.ps1`                     | PASS — disposable PostgreSQL 17, 9 tests including dispatch/processing concurrency and queue recovery                                                                                                         |
| `./scripts/test-source-identity-contract.ps1`             | PASS — disposable PostgreSQL 17, 1 contract test                                                                                                                                                              |
| `./scripts/test-platform-boundary-migration-contract.ps1` | PASS — disposable PostgreSQL 17, 3 phased migration/rollback tests                                                                                                                                            |
| `npm run build`                                           | PASS                                                                                                                                                                                                          |
| `npx eslint "{src,apps,libs,test}/**/*.ts"`               | PASS — 0 errors, 19 existing test warnings                                                                                                                                                                    |
| Frontend `npx tsc --noEmit`                               | PASS                                                                                                                                                                                                          |
| Frontend `npm run smoke:e02:typecheck`                    | PASS — fixture response objects satisfy production outcome and billing types                                                                                                                                  |
| Frontend `npm run lint`                                   | PASS                                                                                                                                                                                                          |
| Frontend isolated `npm run build`                         | PASS — 19 application routes; `NEXT_DIST_DIR=.next/e01-validation-build` avoids the owner's active Shopify dev cache                                                                                          |
| Loopback browser smoke                                    | PASS — embedded English pending cancellation, Standalone Arabic unsupported action, Standalone manual/no-purchase billing, and embedded Arabic Shopify billing; Arabic document reported `lang=ar`, `dir=rtl` |

The browser fixture is intentionally isolated: its CSP blocks external connections and its API replacement throws on unexpected calls. It proves neutral response rendering and handler behavior, not authentication or remote provider completion.

## Staging rollout and stop criteria

1. Take the normal database snapshot. Run `scripts/preflight-source-identity.sql` and retain its detailed output. Stop if any ambiguous/orphaned source or ownership mismatch is non-zero; never guess an owner.
2. Record pre-migration counts for integrations, orders, verifications, integration-monthly-usage rows, webhook events, active Shopify credentials, and subscription IDs. Pause webhook and verification-automation consumers.
3. Deploy the source-aware compatible application, apply `0023`, `0024`, and `0025` in order, and reconcile every recorded count and retained Shopify credential/subscription field. Stop on any loss, unexpected reassignment, invalid constraint, or schema error.
4. Keep `WEBHOOK_RECONCILIATION_ENABLED=false`; run the documented webhook dispatch dry run. Then use a bounded batch in dry-run mode. Stop on unexplained stores, volume, pending age, retries, stale processing, or terminal failure counts.
5. In staging, stop and restore Redis after durable event insertion. Require exactly one order, one verification, and one usage reservation after recovery and replay. A duplicate effect or an unrecovered accepted row blocks release.
6. Run authenticated Shopify embedded and Standalone sessions in Arabic/RTL and English/LTR. Recheck outcome capability rendering, disconnected-source history, billing management boundaries, session-derived tenant authority, and navigation. Any provider fallback or cross-tenant result blocks release.

For application rollback, disable reconciliation, pause consumers, and deploy the last source-aware E02-compatible build. Leave the additive constraints/outbox columns and accepted new-platform rows intact. Do not run a destructive down migration, restore cascading integration deletes, or remove new-platform data merely because the older application does not surface it. Resume consumers only when producer and consumer versions match.

## Remaining external validation

- Run the retained-count migration rehearsal against the dedicated staging database; this local gate used only synthetic disposable PostgreSQL data.
- Perform the real staging Redis stop/restore drill and review `webhook_dispatch_health`.
- Complete authenticated, full-layout dual-mode/locale smoke. The isolated fixture deliberately contains no real session or provider credentials.
- No unimplemented native commerce adapter is declared production-ready by this gate.
