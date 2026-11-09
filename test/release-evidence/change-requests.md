# Change-request verification evidence

## Production template preparation follow-up

Production-based authoring, admin review/export, shared-number logo fixes, bounded database preparation and verification are recorded in [template preparation evidence](change-request-template-preparation.md). The [readable review](change-request-templates-production.md) and [verified definitions/production draft IDs](change-request-templates-production.json) cover all 23 production predecessors. Provider submission, deployment and merchant activation remain separate.

Observed: 9 November 2026, Africa/Cairo. Scope: CR05 and the approved D01–D24/lifecycle contract. Starting snapshots: backend `a49e3ec506a22378ece08b626a4a8118bd3ec289`, frontend `2de7592f5db53a63aa163133d4b9b38a46dcead2`. Final task changes are the commit containing this record and the corresponding frontend verification commit; the workspace handoff records both final identifiers.

## Evidence boundaries

All provider traffic and identities are synthetic. PostgreSQL contracts use labelled disposable loopback containers and dedicated test URLs; application database configuration is never used. The new HTTP suite runs the real Meta HMAC guard/raw-body handling, receiving-account router, DualAuthGuard, role/tenant checks, lifecycle, repositories, accounting and source adapters. External token validation, commerce connection snapshots and provider transport responses are replaced at test boundaries; the separate source contracts exercise connection persistence. Accepted initial dispatches are seeded; this is not a live initial-template send.

The suite invokes durable effect consumers directly with a controlled queue producer. It does not establish Redis/BullMQ delivery or production worker health. The separate Meta durable-intake/routing/recovery contracts exercise their persisted boundaries. Real Shopify Admin framing, production Supabase/Shopify authentication, provider approval/delivery and production activation remain unverified.

## Decision traceability

| Decisions | Implementation and evidence | Result / limit |
| --- | --- | --- |
| D01, D07: sources/senders | App registry, source outcome/current-order adapters; `change-request-release.contract-spec.ts` source × sender HTTP matrix; source and messaging contracts | All four implemented adapters × both senders; manual/import/API ingress covered separately. |
| D02: opt-in/default off | Migration 0092, settings/readiness; lifecycle migration contracts and settings component/browser checks | Synthetic defaults/activation checks; no production setting inspected. |
| D03: acknowledge/contact; no detail collection | Webhook/lifecycle/acknowledgement and existing merchant panel | Capture and merchant outcomes through application layers; no inbox/order editor introduced. |
| D04, D05: existing accounting/no allowance | Dispatch ledger/accounting, acknowledgement effects; messaging/credit/own-number contracts and zero-allowance HTTP case | No later top-up send; initial email remains independent. |
| D06, D14, D15: dashboard/initial email/recipient | Effects service, configured-address/owner fallback and notification builder; notifications contracts/effects unit tests | No WhatsApp merchant alert, reminder email or email allowance charge. Provider acceptance is simulated. |
| D08: automation/shipping warning | Execution-time repository/worker guards, needs-action projections; lifecycle/auto-cancel contracts and panel checks | Includes previously queued escalation/cancel races; Shopify tag is no physical hold. |
| D09, D20: merchant outcomes/sync | Guarded merchant controller/service, existing hub and commerce registry | Confirm/cancel HTTP cases across eight combinations with real adapters and fake provider operations. |
| D10: Shopify tag | Current-state/revision reconciliation, owned status-tag set | Notifications race/retry/echo contracts; unrelated merchant tags survive. |
| D11, D23: awaiting/shipping | Latest available source inspection and locked eligibility | Known-shipped HTTP rejection; unknown shipping accepted by lifecycle contracts. |
| D12: customer resolution | Ordered current-cycle customer command and existing outcome sync | Confirm and Cancel HTTP cases across eight combinations; no merchant-contact gate. |
| D13: placement/filter | Existing attention section, change-request tab/query and summaries | Actual guarded list API plus both production skins over synthetic data. |
| D16: readiness | Template counterpart, provider metadata/drift and own-connection readiness | Registry/sync/authoring/messaging contracts and activation tests; real approvals unknown. |
| D17, D22: localized content/buttons | Fixed acknowledgement snapshots and localized labels, catalog draft preparation | Six languages and registered variants tested; Arabic dialect distinction checked. Native fluency is not established by assertions. |
| D18: quiet hours | Immediate acknowledgement versus ordinary resend scheduling | Messaging, reconfirmation and unit checks; no other new exception. |
| D19: disable after send | Future template selection versus persisted outbound capability/cycle | Previously sent buttons work with opt-in off; legacy/off selectors remain tested. |
| D21: reconfirmation | Authoritative source registry, resend service, transactional dispatch acceptance/cycle commit and normal timer scheduling | Reconfirmation DB contracts, real-source reader unit tests and service tests; no live provider resend. |
| D24: external contact tools | Shared normalized contact helper and existing panel links | Browser checks of WhatsApp/call/copy controls, unit missing-phone cases; links do not send through Akeed. |

## Scenario matrix

| Requirement/scenario | Coverage and method | Result / limitation |
| --- | --- | --- |
| Request → acknowledgement → list/email → merchant confirm/cancel | 4 sources × 2 senders, signed HTTP webhook + real DB/services/adapters | **Pass:** HTTP integration; fake provider I/O. |
| Customer Confirm/Cancel after request | 4 sources × 2 senders × 2 outcomes, HTTP | **Pass:** history/task closed without merchant contact; subsequent merchant action conflicts. |
| Duplicate/reordered webhook, repeated taps, same phone across tenants | Messaging/lifecycle/routing DB contracts plus repeated-tap HTTP cases | **Pass:** persisted effect/dispatch dedupe and customer event ordering checked. |
| Cross-tenant reads/mutations and viewer access | New guard-active HTTP negatives plus existing tenant contracts | **Pass:** synthetic validated principals; real external sign-in not exercised. |
| Queued auto-cancel versus request; customer versus merchant | Lifecycle/reconfirmation/auto-cancel PostgreSQL concurrency cases | **Pass:** controlled races, no shared database. |
| Fresh resend; duplicate send; old buttons; late callbacks | Reconfirmation DB and affected service/source-reader tests | **Pass:** database cycle/dispatch semantics plus fake transport; production provider callback timing unverified. |
| Queued/failed/blocked resend | Reconfirmation service/DB contracts | **Pass:** open task, stopped automation, no premature cycle/timer reset. |
| Zero allowance/top-up; ordinary credit/refund flows | New HTTP case, messaging contracts and complete E04.5 contract runner | **Pass:** synthetic credits/pools/receipts only. |
| Messaging/email/platform failures; stale markers and echoes | New HTTP failure case, notifications DB, effects/adapter unit and source sync contracts | **Pass:** persisted actionable errors/recovery; no live outage injected. |
| Ordinary updates do not resolve; known/unknown shipping | Lifecycle, notification, reconfirmation contracts and shipping HTTP case | **Pass:** external terminal protections retain existing semantics. |
| Feature off/disable-after-send; legacy buttons/templates | Messaging/registry contracts and full backend suite | **Pass:** seeded legacy dispatches/templates; no real historical customer data. |
| UI skins/locales/RTL/themes/error/empty/viewer/race | Playwright production components using fixture APIs; representative integrated guarded API path | **Pass:** 20 fixture browser checks plus one integrated browser/API case; see frontend verification record. |
| Migration/default/legacy job compatibility | Lifecycle contract applies 0092–0095, rerun/default assertions, migration/journal unit tests | **Pass:** validated against disposable predecessor fixtures, not a production migration rehearsal. |
| Actual provider approvals, email inbox, live stores/Admin | No authorized live provider access in this task | **Not run**; external prerequisites. |

## Reproducible checks

Run from `akeed-backend`. Detailed local logs are `.tmp/cr05-*.log`; successful reruns supersede explicitly retained failed attempts. A machine-readable final summary accompanies this record.

- `node node_modules/jest/bin/jest.js --runInBand --silent --json --outputFile=.tmp/cr05-unit-results.json`: 384 suites / 8,507 tests passed.
- `pwsh -NoProfile -File scripts/test-change-requests-contract.ps1`: 24 passed.
- `pwsh -NoProfile -File scripts/test-change-request-messaging-contract.ps1`: 24 passed.
- `pwsh -NoProfile -File scripts/test-change-request-reconfirmation-contract.ps1`: 13 passed.
- `pwsh -NoProfile -File scripts/test-change-request-notifications-contract.ps1`: 22 passed.
- `pwsh -NoProfile -File scripts/test-e045-contracts.ps1`: 14 steps / 314 tests passed after correcting the sender contract's exact projection expectation.
- Source outcome runners: EasyOrders 33, WooCommerce 68 passed. Auto-cancellation 10; merchant routing 21; Meta durable events 20 passed.
- Ingress runners: manual order 15, order imports 65, Server API 61 passed.
- Template registry 28, synchronization 24, authoring 37 passed.
- Standard TypeScript, backend build, structured logs and targeted code lint/format checks are recorded in the final summary.
- `pwsh -NoProfile -File scripts/test-change-request-release-contract.ps1 -Browser`: new complete HTTP matrix and representative browser-to-API flow; **37 passed** (36 HTTP cases and one real UI-to-API case); final result in the machine-readable summary. `CR05_RUN_BROWSER`, `CR05_BACKEND_URL` and `CR05_VERIFICATION_ID` are test-harness variables only, not product rollout controls.

The first E04.5 run failed because an exact sender-template response assertion lacked the newly added `driftReason` and `lastSyncedAt` fields. The corrected assertion retains exact equality and explicitly checks their null values for the unsynced fixture. No provider approval is inferred. The subsequent complete billing runner passed.

The existing verification-overview contract was rerun: 32 passed, one skipped, one failed (`capacity.renew_plan_id: null` absent from its exact expected object). This was a genuine historical failure at the initial snapshot; the authorized follow-up below fixes it and reruns the contract without relaxing exact equality.

## Conclusions and remaining prerequisites

Implementation evidence covers the approved change-request behavior at the indicated local layers. Passing fake-backed contracts is not a production release certification. Final results: 37 new integrated cases and 20 fixture browser checks passed. Backend typecheck, builds, logs, targeted lint/format and frontend lint/format pass. The initial standard frontend typecheck failure is resolved by the authorized project-boundary fix below; production and smoke projects now both pass their standard checks. See the associated [machine-readable summary](change-requests-summary.json) and frontend record.

- Code/test baseline: both previously recorded blockers are resolved in the follow-up below. Historical failure logs are retained separately from current passing checks.
- Unverified behavior: actual external authentication, Shopify Admin frame, live provider acceptance/delivery, real webhook timing and production worker operation. Native proofreading across all languages is still recommended.
- External prerequisites: real approved sender/language/style counterparts, merchant-owned provisioning, email domain/configuration/recipient, connected store permissions/settings and authorized migration/deployment verification. Provider state was not inspected.
- Deployment, production migration, feature activation, live template submission and real notifications: **not performed**.

Follow [the release/recovery runbook](../../docs/CHANGE_REQUEST_RELEASE_RUNBOOK.md). Keep future feature use off until these release prerequisites and the environment's smoke checks are satisfied; retain compatible consumers during rollback.

## Authorized follow-up: close the two code blockers

The owner explicitly expanded the task to fix the existing frontend generated-type errors and overview contract mismatch, then commit/push on develop. Production business behavior and billing rules are unchanged.

- Frontend root cause: the production compiler included the independent smoke app's ignored `next-env.d.ts`, which imported fixture route globals into the production `LayoutProps` namespace. The root project now excludes that separate app, while retaining production generated validators. `npm run typecheck` checks both the production compiler and the existing dedicated smoke compiler. File-list inspection verifies separate route declaration graphs. No error suppression, generated-file patch, strictness reduction or production-route exclusion was introduced.
- Overview root cause: the API correctly includes `renew_plan_id`; the exact contract assertion omitted it. The assertion now includes null for the original unpaid fixture. Three additional PostgreSQL cases verify active Pro renewal, null for cancelled/frozen subscriptions and independence from another tenant. Exact response equality remains.
- Passed: corrected overview contract **36 passed / 1 optional SQL benchmark skipped**, affected verification/billing policy unit tests **104 passed**, backend TypeScript/targeted lint/log checks, frontend production build/lint, both standard TypeScript projects, and the change-request HTTP/browser integration suite **37 passed**. Fresh full frontend Vitest: **193 files / 2,328 tests passed**. Standard frontend `npx tsc --noEmit` and the combined production/smoke check pass after build and fixture regeneration; final logs are in the summary.
- Reproduction: `pwsh -NoProfile -File scripts/test-verification-overview-contract.ps1`; `node node_modules/jest/bin/jest.js --runInBand --silent src/modules/verifications/verifications.service.spec.ts src/shared/billing/usage-alert.policy.spec.ts`; backend `npx tsc --noEmit -p tsconfig.json`; frontend `npm run typecheck`, `npm run build`, `npm run lint` and the existing full Vitest command. Exact final logs/checks and source fingerprints are in the [summary](change-requests-summary.json).

The two code blockers no longer prevent release. Actual sender-specific template approvals, environment/worker readiness and provider smoke evidence remain separate external prerequisites; no production deployment or activation was performed.
