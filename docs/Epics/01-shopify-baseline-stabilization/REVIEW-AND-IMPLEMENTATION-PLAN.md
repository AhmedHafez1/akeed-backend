# E01 review and implementation plan

**Reviewed:** 2026-08-31  
**Recommendation:** Three implementation packages and one release checklist.  
**Status:** Recommendation adopted; packages A/B/C and US-01-06 completed on 2026-08-31. Story IDs and corrected dependencies are retained. See the [implementation and repeated release-gate evidence](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md), including authenticated existing-session browser checks, isolated destructive feedback, two small frontend rendering fixes and remaining E02/E06 limitations. The original review evidence below remains a historical baseline.

## Do we need all six stories?

We need the critical regression checks, but not six independently delivered, sequential stories. E01 is a compatibility baseline before E02 changes shared behavior. Much of the required coverage already exists; the work should fill gaps rather than rebuild it.

| Existing story | Recommendation | Actual remaining work |
| --- | --- | --- |
| [US-01-01: deterministic baseline](US-01-01-deterministic-test-baseline.md) | Keep as a small setup task: package A. | Freeze the onboarding test clock, verify its billing boundary, and record a green baseline. |
| [US-01-02: webhook security and duplicates](US-01-02-shopify-webhook-characterization.md) | Keep; combine with US-01-03 in package B. | HTTP/raw-body coverage, producer and delivery-ID cases, duplicate persistence evidence, and the known enqueue-failure fixture. |
| [US-01-03: normalization and COD](US-01-03-normalization-and-cod-fixtures.md) | Keep; combine with US-01-02 in package B. | Test the real normalizer and phone service; extend the small eligibility suite with missing signal and Arabic cases. |
| [US-01-04: outcome semantics](US-01-04-shopify-outcome-semantics.md) | Narrow to gaps; combine with US-01-05 in package C. | Preserve existing lifecycle tests; add adapter-level cancellation assertions and a composed customer-reply path. |
| [US-01-05: entitlement, automation and sender](US-01-05-entitlement-automation-sender-compatibility.md) | Narrow to gaps in package C. | Entitlement delegation, follow-up failures, retry boundaries, actual sender selection and message-ID persistence. |
| [US-01-06: release gate](US-01-06-dual-mode-regression-release-gate.md) | Treat as the epic completion checklist, retaining its ID for downstream links. | Run the resulting suite, static/build checks and both-mode/both-locale smoke checks; record evidence. |

Remove duplicate tests and separate acceptance ceremonies, not authentication, tenant isolation, destructive-action or usage checks. Do not require a new frontend test framework, a general adapter framework, new sender support, schema migrations to application data, or a coverage-percentage target for E01.

## Evidence from the current checkout

Fresh read-only validation used Node `v22.22.0` and npm `10.9.4` with existing installed dependencies.

| Repository | Commit | Command | Result |
| --- | --- | --- | --- |
| Backend | `c5af8ff571d1b339e09160bff1315e8ccdc50c2f` | `npm test -- --runInBand --silent` | Exit 1: 242 passed, 1 failed; 26 passed suites, 1 failed suite; 243 tests total. |
| Frontend | `0e74c8864da0ceb1d8cc0275962408e12c2843ec` | `npx --no-install tsc --noEmit --incremental false` | Exit 0. |

The failing test is `OnboardingService > returns consolidated settings data`: it expects May 1–31, but the live clock produces August 29–September 28. Its integration activation date is fixed at May 1. Fix the test clock, not the production billing calculation. See [the onboarding spec](../../akeed-backend/src/modules/onboarding/onboarding.service.spec.ts).

Builds, lint, isolated database races and browser smoke checks were **not run** during this review. Passing unit tests do not establish live provider readiness. Neither application Git working tree was changed.

Existing coverage to reuse:

- [HMAC guard tests](../../akeed-backend/src/shared/guards/shopify-hmac.guard.spec.ts) already cover valid, invalid and missing signatures and missing raw body. They do not exercise the HTTP parser/controller path.
- [Queue processor tests](../../akeed-backend/src/modules/webhook-queue/webhook-queue.processor.spec.ts) cover completed/skipped/failed processing with a mocked normalizer. No dedicated order-webhook, queue-producer or Shopify-normalizer spec exists in this checkout.
- [Eligibility tests](../../akeed-backend/src/modules/verification-core/order-eligibility.service.spec.ts) contain four cases; direct paymentMethod, transaction gateways, Arabic matchers and real normalization need more coverage.
- [Hub tests](../../akeed-backend/src/modules/verification-core/verification-hub.service.spec.ts), [merchant cancellation tests](../../akeed-backend/src/modules/verifications/verifications.service.spec.ts) and [Meta callback tests](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.spec.ts) already cover most outcome transitions, late replies, ownership checks, test orders, provider rejection and returned `shopifyJobId`.
- [Send tests](../../akeed-backend/src/modules/verification-core/verification-send.service.spec.ts), [automation tests](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.spec.ts) and [quiet-hours tests](../../akeed-backend/src/shared/utils/quiet-hours.util.spec.ts) already cover most scheduling and send guards. [Entitlement tests](../../akeed-backend/src/modules/verification-core/billing-entitlement.service.spec.ts) currently exercise billing-date calculation, not repository reservation/release delegation. [WhatsApp tests](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.spec.ts) use fake global credentials but primarily assert template bodies.

## Requirements to clarify before implementing

1. **Characterization is not a reliability guarantee.** The [producer](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts) persists before enqueueing and returns early on a duplicate. A queue failure can leave a pending event that a redelivery will not enqueue. E01 should demonstrate that current failure; its repair remains [US-02-06](../02-platform-boundaries-and-reliability/US-02-06-recoverable-webhook-dispatch.md). Keep that repair prominent in E02 and do not describe E01 as fixing lost-event recovery.
2. **Specify which malformed headers must fail.** US-01-02 AC1 should distinguish invalid HMAC from shop-domain, topic and delivery-ID headers. The controller forwards those routing headers without dedicated validation, and missing delivery IDs deliberately take a timestamp fallback. Require invalid signatures to stop before ingestion; characterize other malformed-header outcomes and record discrepancies. Any tenant-routing or signature bypass discovered blocks affected release and needs an explicit fix, not an assertion that blesses it.
3. **A cancellation job reference is currently returned, not durably retained.** US-01-04 AC2 should say “returns the existing `shopifyJobId` response field.” The [merchant service](../../akeed-backend/src/modules/verifications/verifications.service.ts) does not persist or poll it; the [dashboard hook](../../akeed-frontend/src/features/dashboard/domain/useDashboard.ts) refreshes after the response. Shopify documents this as an asynchronous job, so acceptance must not mean completed remote cancellation. [Shopify orderCancel reference](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel).
4. **Define the retry cases in US-01-05 AC2.** A known failed send with successful quota release differs from provider acceptance followed by a local write failure, or from a failed quota release. The [send service](../../akeed-backend/src/modules/verification-core/verification-send.service.ts) does not establish universal retry-safe charging/delivery. Characterize those boundaries and preserve known release behavior; durable dispatch claims and uncertain-send reconciliation belong to [US-06-02](../06-tenant-aware-whatsapp-foundation/US-06-02-per-message-dispatch-ledger.md). A reproduced current defect should receive a separately tracked reliability fix; do not automatically postpone an urgent fix until merchant-owned senders ship.
5. **Remove artificial sequencing.** Normalization does not depend on webhook tests being finished, and entitlement tests do not depend on cancellation tests. Package A comes first; B and C have no dependency on each other; the final checklist depends on all three. This is a proposed dependency correction, not a silent change to the existing backlog.

## Package A — deterministic baseline

**Traceability:** US-01-01. **Change size:** small, test-only.

1. Add scoped Jest clock setup/cleanup to `onboarding.service.spec.ts`, freezing the consolidated-settings case within the first billing cycle, for example May 15, 2026 UTC.
2. Add a compact parameterized check through `getSettings` immediately before and at the May 31 UTC cycle boundary. Keep explicit expected period start/end and repository arguments for each date. Do not change the host operating-system clock or production code.
3. Restore real timers after every case. Run the focused spec and full backend suite, and rerun frontend typecheck. Record date, both commits, tool versions, commands and exit codes.

**Exit:** The original assertions pass with controlled time, the boundary produces the correct next period, and the full suite is green without skips or weakened assertions. New unrelated failures are recorded and triaged separately.

## Package B — Shopify input compatibility

**Traceability:** US-01-02 and US-01-03. **Depends on:** A.

Use the existing Jest, Nest testing and Supertest dependencies. Keep fixtures synthetic and providers mocked.

1. **HTTP boundary:** Add a focused Shopify webhook HTTP spec using the real controller, HMAC guard and order-ingestion service. Construct a small test module with `rawBody: true` and matching validation settings; stub persistence/queue and unrelated webhook services. Do not import production `main.ts` or the full `AppModule`, which can initialize infrastructure. Send deliberately formatted JSON as raw text, sign those exact bytes, and verify a one-byte/whitespace change fails before ingestion. Include invalid/missing signature and malformed header/body cases with the actual response status.
2. **Ingestion and producer:** Add focused specs for trusted domain-to-integration resolution, normal acknowledgement, duplicate acknowledgement, stable job ID, missing-ID fallback under controlled time, database failure and queue failure after insertion. For the last case, assert the current failed enqueue and duplicate retry path; label it a known limitation linked to US-02-06.
3. **Duplicate persistence:** Exercise `WebhookEventsRepository.insertIfNew` concurrently against a dedicated disposable PostgreSQL test database using the actual uniqueness rule. Run two producer ingestions with the same ID and a queue stub; assert one event and one enqueue. Also test two different delivery IDs. Mock-only conflict tests are useful but cannot prove the database race. Use a separately named test database variable and a guarded test command; never fall back to the application's `DATABASE_URL`. A missing test database is “not run,” not a passing concurrency result. Keep this fixture bounded; broader crash/recovery drills stay in E02.
4. **Normalization and eligibility:** Add `shopify-order.normalizer.spec.ts` with the real `PhoneService`, extending `order-eligibility.service.spec.ts` rather than duplicating its four cases. Use the same small fixture set for a real normalizer-to-strategy check and at least one HTTP payload-preservation check.

Required fixture matrix:

| Area | Checks |
| --- | --- |
| Phone | E.164, local number plus region, source precedence, absent phone, malformed phone. Characterize missing phone returning null separately from invalid phone throwing; do not invent fallback after a selected invalid number. |
| Display fields | Missing customer versus missing names, decimal total preserved as a string, currency, numeric/string `id` and `order_number`, missing reference. Preserve current mapping; do not introduce use of Shopify `name` as a fallback. |
| Payment | Direct normalized paymentMethod, gateway-name list, gateway, transaction gateway, Arabic COD text, prepaid, missing signals and malformed optional transaction entries. |
| Authority | Payload-supplied org/integration values cannot replace resolved identity. Unknown stores and inactive stores are characterized through the relevant producer/worker/hub boundary; neither results in a send. |

**Exit:** Real HTTP raw-body behavior and real normalization are protected, duplicate conflict/race evidence is recorded, and failure fixtures describe current limitations accurately. A unit mock is never reported as end-to-end delivery proof. Shopify's raw-body HMAC and delivery-ID guidance supports these checks. [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

## Package C — outcome, billing and sender gaps

**Traceability:** US-01-04 and US-01-05. **Depends on:** A; can be developed independently of B.

Begin by mapping existing tests to acceptance criteria. Add only missing assertions or behavior cases; retain the current public response shapes and service ports.

1. **Outcome boundary:** Reuse the existing merchant cancellation tests, including their `shopifyJobId` assertions. Add a composed Meta callback → real hub test for customer confirm/cancel, with a mocked commerce boundary, proving local updates and tags without any order cancellation call. Extend automation coverage for synthetic no-reply orders and provider tagging failure if the existing test does not prove the expected result.
2. **Shopify adapter contract:** Add a focused `shopify-api.service.spec.ts` with mocked HTTP/config. Assert the current GraphQL cancellation variables (`notifyCustomer: false`, `refund: false`, `restock: true`, order ID and reason), job-ID extraction, transport failure, GraphQL errors and mutation user errors. Exercise actual public adapter methods; do not replace them with mocks in their own tests. Preserve the current API version and GraphQL implementation; REST conversion and API upgrades are out of scope.
3. **Entitlement and send failures:** Extend existing entitlement tests to verify plan/period/limit and org/integration arguments passed to reservation, availability and release methods. Parameterize the send path for active/not_required billing, follow-up exception/missing message ID and successful release. A failed follow-up must preserve the original verification state. Reuse existing blocked-billing, inactive integration and exhausted-quota cases.
4. **Retry and timing boundaries:** Cover an initial job retried after its status is already sent (no second send), failed quota release, and provider acceptance followed by local persistence failure. Record observed behavior and risks; do not assert universal exactly-once delivery or zero duplicate charging. Extend terminal-state and token-present quiet-hour rescheduling cases rather than duplicating the existing time utility suite.
5. **Sender and message identity:** Extend the WhatsApp tests to assert the HTTP sender URL, fake credential selection and templates for initial/follow-up calls through the messaging boundary. Add a focused repository check that follow-up persistence replaces the current `waMessageId` and retains its terminal-state guard. Record this as E06's migration baseline, not a desired long-term message model.

**Exit:** Each outcome/entitlement/sender criterion maps to an existing or new passing check; known failure windows have explicit evidence and a follow-up owner in the backlog. No real WhatsApp message, subscription change, refund or Shopify cancellation is performed.

## Release checklist — keep US-01-06 as the exit anchor

Draft this checklist during A and complete it after A, B and C. Keep one evidence record, not separate duplicate release documents for every story.

Run in the backend repository:

```powershell
npm test -- --runInBand
npm run build
npx --no-install eslint "{src,apps,libs,test}/**/*.ts"
```

Run the dedicated database contract command added by B separately. The current `npm run test:e2e` scaffold loads the full app and is not a substitute for an isolated Shopify contract harness.

Run in the frontend repository:

```powershell
npx --no-install tsc --noEmit --incremental false
npm run build
npm run lint
```

Backend `npm run lint` includes `--fix`, so it is intentionally not used for validation. Record pre-existing build/lint failures separately from introduced regressions; never relabel a failing check as passed or hide it with suppression. Any exception to the current gate must be explicit, with an owner and rationale.

| Mode | English/LTR and Arabic/RTL smoke checks |
| --- | --- |
| Shopify embedded | Session authentication, onboarding/billing visibility, dashboard, settings, navigation preserving embedded context, merchant cancellation confirmation/loading/error/refresh behavior. Mock destructive cancellation unless using an explicitly authorized disposable test-store order. |
| Standalone | Supabase sign-in, existing organization provisioning, standalone shell, navigation and existing empty/error states. Do not assert future order ingestion is available. |

Record the environment, frontend/backend commits, test account/store class, commands, results, limitations and second reproducible run. Do not put credentials or customer data in evidence. If no safe browser/test-store environment is available, mark smoke checks blocked/not run and leave the release gate open; implementation work can still proceed.

**E01 completion:** Controlled-clock suite green; B/C acceptance mapped; isolated duplicate evidence complete; build/lint/typecheck outcomes resolved; both modes/locales checked; second run repeatable. Link E02's prerequisite to US-01-06 as today. No deployment, migration or live provider action is required merely to merge test-only changes.

## Delivery and backlog updates

Deliver A first, then B and C in focused backend changes, then complete the checklist. B and C may share a fixture helper but do not need a new shared testing framework. Put executable tests and durable release instructions in the application repositories; this workspace-level plan is outside both Git repositories.

If adopting this recommendation, keep the six IDs as traceability anchors, group US-01-02/03 and US-01-04/05 for delivery, and make the dependency graph explicit: US-01-02 through US-01-05 depend on US-01-01; US-01-06 requires all five. Apply the wording corrections above at the same time. There is no need to renumber the expansion roadmap or invent new product stories.

The main effort is B; A is a small repair and C is targeted gap closure. Estimate after the acceptance-to-test mapping and isolated-database setup are known; no calendar or staffing promise is implied here.
