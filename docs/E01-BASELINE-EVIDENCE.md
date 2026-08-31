# E01 Shopify baseline evidence

Validated on **2026-08-31**. **E01 and US-01-01–06 are complete for the recorded working trees.** Packages A/B/C, the repeated automated gate, authenticated existing-session checks in both modes/locales and eight isolated cancellation sequences are recorded below. Final frontend validation passed twice after the two UI corrections found during smoke testing. Passing characterization tests does not prove live-provider readiness, recoverable delivery or exactly-once sending.

## Checkout and environment

- Backend: `037890156e7991f2965956b62465ac89a5680c2b` (`develop`) plus the uncommitted closure changes described below. This commit contains the E01 test implementation. No new commit was created during closure validation.
- Frontend: `0e74c8864da0ceb1d8cc0275962408e12c2843ec` plus the uncommitted isolated smoke fixture, its configuration and the two UI corrections below.
- Local Windows development environment; PowerShell `7.6.4`, Node `v22.22.0`, npm `10.9.4`; existing installed dependencies. The Docker wrapper also runs under Windows PowerShell via `powershell -NoProfile`. Initial unauthenticated checks used the in-app Chromium browser; final authenticated checks used the user's connected Chrome and Next.js `16.1.6` development servers.
- PostgreSQL `17.11` in an individually created disposable Docker container, bound to a random loopback port. Image: `postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
- Automated fixtures use synthetic data and fake provider credentials, with provider HTTP, queues and unrelated services mocked. Authenticated browser inspection uses the owner's existing development store/account and running stack. The agent submitted no live messages, subscriptions, refunds or order cancellations, ran no application migrations, and did not start, restart or stop the owner's full backend. Only the agent's isolated fixture server and disposable contract containers were stopped.

The original baseline at backend `c5af8ff571d1b339e09160bff1315e8ccdc50c2f` was 242 passed / 1 clock-dependent failure. That is historical, not the current result. The current suite has **354 passing tests in 33 suites**, plus **5 separately executed PostgreSQL contract tests**.

## Closure changes

The committed test implementation omitted its contract runner, separate Jest configuration and evidence record. This change restores those artifacts and the `test:contract:shopify` package script.

Three test-only type corrections resolve the remaining static failures without changing production behavior or suppressing checks:

- `billing.service.spec.ts`: give the `updateById` mock the real repository method's argument/return types; remove unsafe `any[]` inspection. This resolves the 36 pre-existing billing-spec lint errors.
- `whatsapp.webhook.service.spec.ts`: type the callback wrapper with the existing DTO types instead of `any`. This resolves the callback-spec lint error in the committed E01 implementation.
- `webhook-queue.processor.spec.ts`: use the normal default fixture when the optional normalized order is undefined, while preserving explicit null. This resolves the pre-existing full-TypeScript `TS2322` error.

Frontend closure adds `test/e01-smoke`, a separate loopback-only Next.js application using the existing framework and dependencies. It composes the real cancellation hooks and tables with a strict in-memory API replacement, without changing shipped routes or authentication. Its browser helper and README provide repeatable destructive-feedback checks without reaching providers.

Two small production UI corrections address findings from the authenticated smoke run:

- `src/app/[locale]/(embedded)/settings/page.tsx` now uses the existing standalone `FullPageLoader` in standalone mode, including its auth-gate fallback. Previously the embedded Polaris skeleton threw `MissingAppProviderError` before standalone settings could render. Both locales and the message-template/automation aliases now reach the existing missing-integration error state without crashing; embedded mode retains its Polaris skeleton.
- `src/features/settings/skins/embedded/SettingsEmbeddedTabbedSkin.tsx` puts the preview paragraph key on its outer `Fragment`. This removes the observed React list-key warning without changing preview content or layout.

No onboarding behavior was changed. Temporary diagnostic logging used while investigating a transient initialization failure was removed before final validation.

Production billing calculations, GraphQL variables, API version, public response shapes, service ports, schema and frontend framework are unchanged. The user-approved plan explicitly preserves GraphQL despite older repository guidance mentioning REST.

## Acceptance-to-test mapping

Paths below are relative to this repository. Existing hub, merchant cancellation, billing, automation, HMAC and template coverage was retained and extended only for missing cases.

| Story / acceptance | Executable evidence | What the evidence establishes |
| --- | --- | --- |
| US-01-01 AC1–4: historical/current baseline, clock cleanup, boundary, unchanged billing | [Onboarding settings](../src/modules/onboarding/onboarding.service.spec.ts); validation table below | May 15 UTC clock; real timers restored after each test; immediately before/at May 31 yields May 1–31 / May 31–June 30, including usage-repository arguments. Existing settings assertions remain. |
| US-01-02: exact-byte signature, validation and acknowledgements | [Shopify controller HTTP](../src/infrastructure/spokes/shopify/shopify.controller.spec.ts); [HMAC guard](../src/shared/guards/shopify-hmac.guard.spec.ts) | Real Nest controller, guard, ingestion service and producer. Raw-body capture, global whitelist/transform, controller validation and global exception filter match production. Formatted JSON succeeds; byte/whitespace tampering, bad/missing signatures stop before ingestion; malformed JSON/DTOs fail. Real production field stripping is asserted. |
| US-01-02: trusted tenant, IDs and failure windows | [Ingestion](../src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.spec.ts); [producer](../src/modules/webhook-queue/webhook-queue.producer.spec.ts) | Resolved domain identity wins over payload identity; missing delivery-ID fallback uses frozen time; stable job ID, duplicate acknowledgement, lookup/insert/enqueue failures; enqueue failure followed by duplicate redelivery remains unrecovered. |
| US-01-02: actual database concurrency | [PostgreSQL contract](../test/shopify.contract-spec.ts) | Actual `UNIQUE (platform, idempotency_key)` constraint and real repository; simultaneous identical deliveries produce one row/one mocked enqueue; different delivery IDs produce two; pending row survives failed enqueue/redelivery; absent domain fails persistence. |
| US-01-03: phone/display/payment matrix | [Real normalizer](../src/modules/webhook-queue/normalizers/shopify-order.normalizer.spec.ts); [synthetic fixtures](../src/modules/webhook-queue/normalizers/fixtures/shopify-order.fixture.ts); [eligibility](../src/modules/verification-core/order-eligibility.service.spec.ts) | Real PhoneService, E.164/local+region, source precedence, absent versus invalid phone, missing customer/names/reference, numeric/string IDs, decimal-string totals and currency. Direct/list/gateway/transaction/Arabic COD, prepaid/missing/malformed payment signals; normalization composed with eligibility. |
| US-01-03: unknown/inactive store no-send boundary | [Queue processor](../src/modules/webhook-queue/webhook-queue.processor.spec.ts); [hub](../src/modules/verification-core/verification-hub.service.spec.ts); controller HTTP spec | Unknown stores are skipped by the worker. Inactive stores reach the real hub's no-send guard; the worker records completion. HTTP payload identity cannot replace the trusted integration identity. |
| US-01-04: customer outcomes versus merchant cancellation | [Meta webhook](../src/infrastructure/spokes/meta/whatsapp.webhook.service.spec.ts); [hub](../src/modules/verification-core/verification-hub.service.spec.ts); [merchant service](../src/modules/verifications/verifications.service.spec.ts) | Meta replies composed with the real hub update local status/tags without commerce cancellation. Existing ownership, terminal-state, synthetic-order, rejection and returned `shopifyJobId` assertions are retained. |
| US-01-04: actual public Shopify adapter | [Shopify API](../src/infrastructure/spokes/shopify/services/shopify-api.service.spec.ts) | Mocked HTTP exercises public cancellation methods, existing GraphQL variables (`notifyCustomer: false`, `refund: false`, `restock: true`), returned job ID, transport/GraphQL/user errors. No remote completion claim. |
| US-01-05: entitlement and send failures | [Entitlement](../src/modules/verification-core/billing-entitlement.service.spec.ts); [send](../src/modules/verification-core/verification-send.service.spec.ts) | Plan/period/quota/org/integration delegation, active/not_required billing, existing blocked/inactive/quota checks, follow-up exceptions/missing IDs, release failure, provider acceptance followed by failed persistence and retry exposure. |
| US-01-05: automation/retry/timing | [Automation processor](../src/modules/verification-automation/verification-automation.processor.spec.ts); [quiet hours](../src/shared/utils/quiet-hours.util.spec.ts) | Already-sent initial-job retries do not resend, terminal guards, token-present quiet-hours rescheduling, synthetic no-reply orders and tagging failure. Known uncertain-send cases do not establish universal retry safety. |
| US-01-05: current Akeed sender/message identity | [WhatsApp service](../src/infrastructure/spokes/meta/whatsapp.service.spec.ts); send spec; [verification repository](../src/infrastructure/database/repositories/verifications.repository.spec.ts) | Real WhatsApp adapter with fake global sender/credentials and initial/follow-up templates; follow-up replaces current `waMessageId` and retains terminal-state SQL guards. Repository SQL/proxy characterization is not real database persistence proof. |
| US-01-06: reproducible automated gate | Commands and two-run results below | Backend suite/build/full types/non-fixing lint; frontend types/build/lint; PostgreSQL separate from the unit suite. |
| US-01-06: both modes/locales authenticated smoke | Browser checklist below; frontend `test/e01-smoke/README.md` and `browser-check.mjs` | Existing real Shopify and Supabase sessions, organization bootstrap, onboarding/billing visibility, layouts, settings, navigation and isolated cancellation feedback. Fresh credential submission and creation of a new account/organization are not claimed. |

## Repeatable automated gate

Run from the backend root. These commands do not start the full application or run application migrations. Do not substitute `npm run lint` (it fixes files) or the full-app `test:e2e` scaffold.

```powershell
npm test -- --runInBand
npx --no-install tsc --noEmit --incremental false
npm run build
npx --no-install eslint "{src,apps,libs,test}/**/*.ts"
powershell -NoProfile -File scripts/test-shopify-contract.ps1
```

Run from the frontend root. Use a distinct output directory when the owner's development servers are running; do not delete or overwrite their generated chunks:

```powershell
npx --no-install tsc --noEmit --incremental false
$env:NEXT_DIST_DIR = '.next/e01-validation-build'
npm run build
npm run lint
```

| Check (2026-08-31) | Run 1 | Run 2 |
| --- | --- | --- |
| Backend Jest | Exit 0; 354/354, 33/33 suites, no skipped tests | Exit 0; same counts, no skipped tests |
| Backend full TypeScript | Exit 0 | Exit 0 |
| Backend Nest build | Exit 0 | Exit 0 |
| Backend non-fixing ESLint | Exit 0; 0 errors, 23 existing warnings | Exit 0; 0 errors, 23 existing warnings |
| Disposable PostgreSQL contracts | Exit 0; 5/5, container removed | Exit 0; 5/5, separate container removed |
| Frontend TypeScript | Exit 0 | Exit 0 |
| Frontend production build | Exit 0 | Exit 0 |
| Frontend ESLint | Exit 0; no warnings/errors | Exit 0; no warnings/errors |

Local raw reports are under each repository's ignored `.git/e01-validation/` directory. This document is the durable evidence intended for version control; ignored logs are supplemental and are not needed to execute the gate. Jest used `--json --outputFile=.git/e01-validation/closure-tests-{1,2}.json`; backend ESLint used `--format json --output-file .git/e01-validation/closure-lint-final-1.json` and `closure-lint-2.json`. Final frontend reports are `ui-complete-{types,lint,build}-{1,2}.log`; earlier `ui-fix-*` reports cover the settings-loader correction before the preview-key correction. Preserve exit codes separately when redirecting. Re-run the complete gate on a subsequent commit rather than attributing these working-tree results to that future commit.

## Database contract safety and limitations

`npm run test:contract:shopify` uses [its own Jest configuration](../test/jest-shopify-contract.json). **`E01_TEST_DATABASE_URL` is mandatory.** The test never loads `.env` or falls back to application `DATABASE_URL`. It rejects remote hosts, an unexpected database/user, URL query options and fragments before connecting. Required database/user: `akeed_e01_test` / `e01_test`, on local PostgreSQL only.

The [Docker wrapper](../scripts/test-shopify-contract.ps1) creates a fresh local container, supplies only synthetic credentials, waits for readiness, sets the dedicated variable for the command, restores its prior value, and removes only the returned container ID in `finally`. It never deletes an existing database/container/volume. Missing Docker, unavailable PostgreSQL or a missing dedicated variable is a failed/not-run contract check, never a successful concurrency result.

For a manually provisioned disposable local test database, set `E01_TEST_DATABASE_URL` to that database and run `npm run test:contract:shopify` directly. The harness creates a random schema, applies only the existing webhook enum/table statements from `drizzle/0007_crazy_violations.sql` there and verifies the migration constraint matches the current Drizzle schema. It drops only its own schema. Unrelated foreign keys, RLS, Redis durability and the whole application migration chain are outside this contract.

Safety probes repeated on 2026-08-31: missing dedicated URL while a synthetic application `DATABASE_URL` is set, remote URL, and wrong database each exited 1 with `NOT RUN` before tests executed. Logs: `closure-guard-missing.log`, `closure-guard-remote.log`, `closure-guard-wrong-db.log`. These are expected fail-closed results, not passing database runs. Do not log a real connection string. The Docker wrapper provides the positive five-test run separately; no labeled test containers remained after the runs.

## Known baseline limitations and owners

| Observation | Evidence / owner |
| --- | --- |
| Insert succeeds, enqueue fails, duplicate redelivery never recovers the pending event | Producer unit test and real PostgreSQL contract. **US-02-06**, backend reliability owner. E01 characterizes this current defect; it does not repair dispatch. |
| Production global validation strips `transactions`, `name`, payload `orgId`/`integrationId` and other undeclared fields | Exact HTTP persisted-payload assertion. Direct strategy recognizes transaction-only COD, but the HTTP path removes that evidence and yields `missing_payment_signal`. **US-02-03**, Shopify adapter owner, for separately scoped DTO/raw-payload review. |
| Topic/delivery headers lack dedicated validation; missing delivery ID uses timestamp fallback; missing domain fails actual persistence | Controller/ingestion/contract fixtures. These results are not claims that every malformed routing header is rejected. No signature or payload-identity bypass was found in the tested cases; any newly discovered signature/tenant-isolation bypass blocks affected release and needs a separate fix. |
| Quota-release failure is swallowed; provider acceptance then failed local persistence can cause retry reservation/resending | Send and automation failure fixtures. **US-06-02**, backend messaging/reliability owner. Triage urgent production repairs separately; do not wait for merchant-owned sender rollout. |
| Follow-up replaces a single current `waMessageId`; there is no per-message dispatch ledger | Repository characterization. **US-06-02** owns the durable ledger baseline. No exactly-once claim. |
| `shopifyJobId` is returned, not persisted or polled for remote completion | Existing merchant tests plus public Shopify adapter contract. Remote completion remains outside this response's guarantee. |

Backlog story IDs and direct dependencies are retained: US-01-02–05 depend on US-01-01; US-01-06 depends on all five. The workspace `Epics` files are outside this Git repository; executable evidence and release instructions live here.

## Browser release checklist and actual results

The final smoke environment was the owner's running local stack: backend `3000`, standalone `3001`, embedded frontend `3002`, and Shopify CLI HTTPS proxy `3458`. The owner supplied the `zamalek-store-2` development preview and connected Chrome. Existing real Shopify/App Bridge and Supabase sessions were reused; no browser storage, passwords or tokens were inspected, fabricated or exported. The standalone account had an existing organization, no Shopify integration and an empty dashboard. No new account/organization or paid subscription was created.

Backend `/api/health` and both frontend rewrites returned `status: ok`, `checks.database: ok`. Rewrites required the application's existing `ngrok-skip-browser-warning: true` header. Headerless HTTP 200 responses containing `ERR_NGROK_6024` were not counted as healthy JSON. Earlier hosted `DEPLOYMENT_NOT_FOUND`, tunnel DNS failures and unsigned-in in-app browser sessions describe earlier environment attempts; Chrome subsequently removed that access blocker.

Authentication evidence is deliberately bounded: real sessions successfully enter protected pages, and a fresh standalone page mount passes the real `AuthGuard`/`ensureStandaloneOrganization` bootstrap. Source inspection establishes that this bootstrap calls the existing organization provisioning endpoint before protected content is released. This is evidence of the existing-organization path, not a fresh password submission or first-time organization creation. Existing backend `organizations.service.spec.ts` separately covers provisioning, idempotent retry and Shopify-identity rejection. Initial safe unauthenticated checks covered localized login/reset rendering, required-email validation and dashboard-to-login redirects without submitting credentials or reset emails.

### Authenticated application checks

Repeat the following in the actual development apps, in English/LTR and Arabic/RTL. Use the existing signed-in sessions, reload at least once, and inspect both the rendered layout and document `lang`/`dir`. Never click send-test, save changes, activate a plan or cancel an order in these live apps. Cancellation interaction is exercised separately below.

| Flow | English/LTR | Arabic/RTL | Actual evidence and boundary |
| --- | --- | --- | --- |
| Existing standalone Supabase session and organization bootstrap | PASS, repeated | PASS, repeated | Fresh protected-page mounts reach dashboard without a login redirect or provisioning-failure screen. No new-user lifecycle is claimed. |
| Standalone shell, metrics and navigation | PASS, repeated | PASS, repeated | Header/navigation, empty dashboard metrics and usage render; direction is `ltr` / `rtl`. Verifications currently redirects to `dashboard?tab=confirmations`, whose standalone skin still shows metrics. This is characterized existing behavior, not working future order ingestion. |
| Standalone settings and aliases | PASS after correction, repeated | PASS after correction, repeated | Settings, message-template and automation links resolve to settings with their existing tab query. An account without a Shopify integration displays the localized load-error banner and no-active-plan state. Returning to dashboard works. The previous Polaris provider crash is fixed, not relabeled as an expected error. |
| Shopify session and embedded context | PASS, repeated | PASS, repeated | Actual admin app iframe authenticates, renders protected dashboard/settings and preserves the Shopify shell while changing locale. Document language/direction verified. |
| Embedded onboarding and billing visibility | PASS, repeated after retry | PASS, repeated after retry | Existing completed store returns from onboarding to dashboard; settings shows Starter/free plan and usage. Final repeated onboarding visits have no application errors in the browser log. Billing cards inspected without activation. No pending-store installation, new billing activation or remote billing completion is claimed. |
| Embedded dashboard and confirmations | PASS, repeated | PASS, repeated | Metrics and confirmations tabs render the existing test row; status filtering produces the translated empty state. No row action or test send was submitted. |
| Embedded settings/navigation | PASS, repeated | PASS, repeated | Store, confirmation, template and billing tabs render. Existing automation/quiet-hours settings were inspected without edits. Returning to dashboard and locale switching retain the app context. |
| Embedded template preview after key correction | PASS | PASS | Actual translated preview renders; the React list-key error no longer appears in fresh page logs. |
| Isolated cancellation feedback | PASS twice per skin | PASS twice per skin | Eight complete browser sequences against real hooks/tables with an in-memory destructive boundary, detailed below. |

The standalone settings console error is the existing logged API load failure for an account with no Shopify integration. It remains visible in development tools and is not suppressed. Successful settings data loading for that account is not claimed. Dashboard copy suggesting active ingestion and the metrics-only Verifications destination are existing standalone limitations; the frontend/platform owner should address them with the standalone delivery work.

### Findings and recovery history

- **Fixed:** standalone settings threw `MissingAppProviderError` while mounting a Polaris loading skeleton outside its provider. The same page and both aliases now render their expected error state in both locales; both frontend gates are repeated after the fix.
- **Fixed:** the embedded template preview keyed an inner paragraph rather than the outer fragment. Fresh preview visits no longer emit the React list-key error.
- **Transient, retained as evidence:** an early embedded settings navigation failed to load an `EmbeddedLayout` development chunk. A full reload recovered; later repeated settings visits passed. This was not counted as a passing navigation.
- **Transient, cause unconfirmed:** one direct onboarding visit logged state/billing-plan load failures and showed the prefill warning. Fresh visits subsequently reached the completed-store dashboard without an onboarding error; no onboarding/authentication logic was changed. Temporary diagnostic logging was removed. The frontend/environment owner must investigate if this recurs on the next candidate; a recurring failure blocks that candidate.
- **Tool limitation:** Shopify's app navigation link was reported disabled through a disabled ancestor even while visually available. A screenshot-guided click and subsequent observed-URL navigation worked. This is separate from the application chunk failure above.
- **Retained development warnings:** App Bridge script-order warning and browser-extension ShopifyQL/deprecation warnings were observed. They are not evidence that authentication failed. No provider/API version upgrade was attempted.

### Safe cancellation feedback harness

The durable instructions and helper live in the frontend repository at `test/e01-smoke/README.md` and `test/e01-smoke/browser-check.mjs`. From that repository:

```powershell
npm run smoke:e01
# Open http://127.0.0.1:3098/en and /ar in the browser.
# Follow the README for both Fixture skin choices, twice.
# Stop only this fixture process when finished.
```

This separate Next.js application uses the existing dependencies and real `useMainConfirmationsTab`, `useDashboard` and both verification tables. A test-only Webpack replacement supplies a synthetic `no_reply` order and strict in-memory API responses. No production route or authentication implementation is replaced in the actual application. It binds to loopback, does not load application `.env.local`, blocks external connections/forms/frames through CSP, rejects unexpected API operations and has no network fallback. It is not an authenticated-session test.

The exported `checkCancellation(tab, skin, locale)` helper accepts a tab from the documented browser-control API and refuses an origin other than `http://127.0.0.1:3098`. Run one sequence per call, after the fixture page has loaded, allowing 55 seconds for browser interaction. Do not point it at the live application. The manual README provides an equivalent sequence without requiring a new test framework.

All eight completed sequences verified: confirmation text; dismissal with zero cancellation calls; one held request with both controls disabled/loading; localized failure with unchanged row and no refresh; enabled retry; successful response followed by refreshed canceled row and removal of cancellation controls. In each sequence one rejected request and one successful retry were submitted to the fixture only.

| Skin / locales | Baseline list/stat GET counts | After rejected request | After successful retry | Completed sequences |
| --- | --- | --- | --- | --- |
| Embedded / en + ar | 1 / 0 | 1 / 0 | 2 / 0 | 4/4 passed, two per locale |
| Standalone / en + ar | 3 / 2 | 3 / 2 | 4 / 3 | 4/4 passed, two per locale |

Counts reflect the fixture's mount/skin-selection lifecycle. Embedded confirmations refresh their list only; the standalone hook also refreshes statistics. These are the real hooks' current behaviors. The returned synthetic `shopifyJobId` remains a reference, not proof of remote cancellation or exactly-once execution.

Fixture setup iterations (initial working-directory/configuration/type setup and premature browser actions) and browser connection timeouts were resolved before the eight successful sequences and are not counted as passes. Fixture TypeScript and non-fixing ESLint passed separately (exit 0); the final fixture typecheck report is `ui-complete-fixture-types.log`. Both repositories' `git diff --check` passed and 150 local documentation links were checked without a broken target. The fixture server was stopped with Ctrl-C after testing; the owner's application servers remained running on 3000/3001/3002/3458.

For the next release candidate, repeat the automated gate, disposable database contracts and this two-mode/two-locale checklist against its actual revision. Record command exit codes, environment, concrete observations and limitations; retain any failures. A new signature/tenant-isolation bypass or recurring application smoke failure blocks the affected release and requires separate triage. E01 evidence does not authorize deployment, migrations, live messages or destructive provider actions.
