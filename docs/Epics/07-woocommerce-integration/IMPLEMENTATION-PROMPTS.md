# E07 — Implementation prompts

There is one prompt per story. Run them **in order, one story per fresh Claude Code session**, started in `D:\Software_Development\Akeed` so both `akeed-backend` and `akeed-frontend` are reachable. Paste the shared context block first, then the step. Each story file holds the full acceptance criteria; the prompts add order, guardrails and the expected output, and don't repeat the criteria.

| # | Story | Type | Repos | Needs you |
| --- | --- | --- | --- | --- |
| 1 | [US-07-01](US-07-01-woocommerce-integration-contract-and-implementation-plan.md) Contract and implementation plan | Contract and plan | backend (docs, fixtures) | Review of the record; nothing to run |
| 2 | [US-07-02](US-07-02-connect-woocommerce-through-application-authentication.md) Connect through application auth | Feature | backend + frontend | — |
| 3 | [US-07-03](US-07-03-ingest-signed-woocommerce-order-webhooks.md) Ingest signed order webhooks | Feature | backend (+ small frontend) | — |
| 4 | [US-07-04](US-07-04-apply-approved-verification-outcomes-in-woocommerce.md) Apply approved outcomes | Feature | backend (+ small frontend) | — |
| 5 | [US-07-05](US-07-05-woocommerce-setup-health-disconnect-and-support.md) Setup, health, disconnect and support | Feature | backend + frontend | — |
| 6 | [US-07-06](US-07-06-woocommerce-release-gate-and-pilot.md) Release gate and pilot | Quality gate | both | A real WooCommerce store (two if you can: classic checkout and Checkout block), the live run, go/no-go |

Strictly sequential: each step depends on the one before it. Step 1 is the only gate before code: if its verdict says blocked, stop there. Steps 2 to 5 ship behind their switches, off. Nothing reaches a real merchant before step 6.

How this differs from E06: there is no validation spike and no test store until step 6. The official WooCommerce docs are the contract. If the code or the gate contradicts the contract record, stop, say so, and propose one focused validation story; do not patch around it.

---

## Shared context (paste at the top of every prompt)

```text
You are working on Akeed epic E07 (WooCommerce integration). Repos: akeed-backend (NestJS, Hub-Adapter pattern, Drizzle, Supabase RLS, BullMQ webhook queue) and akeed-frontend (Next.js, next-intl, Arabic-first RTL). Work directly on `develop` in each repo: no feature branches, no PRs. Commit when the step is done and green.

Read first, and follow strictly:
- akeed-backend/AGENTS.md and akeed-frontend/AGENTS.md
- akeed-backend/docs/Epics/README.md (shared Definition of Done)
- akeed-backend/docs/Epics/07-woocommerce-integration/README.md, including "Approved product decisions" and "Validation rule"
- The story file named in the step. Its acceptance criteria, test requirements and out-of-scope list are the spec. Read the code under "Evidence and references" before designing anything.
- From step 2 on: docs/Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md. It is the only source of truth for WooCommerce behavior. Where it says UNKNOWN, follow the worst-case rule written next to it. If it doesn't answer something you need, stop and ask; don't assume.
- The EasyOrders spoke (src/infrastructure/spokes/easyorders) and its evidence files (docs/US-06-02 to US-06-05 *-EVIDENCE.md) are the pattern for structure, tests and evidence. Copy the pattern, not the provider behavior.

Rules for the whole epic:
- WooCommerce is a new spoke under src/infrastructure/spokes/woocommerce. Provider names, statuses and payload shapes stay inside the spoke. No WooCommerce branching in verification core, the hub, the queue processor or shared frontend logic.
- Reuse what exists, extend, don't fork: the E02 queue and recovery, WEBHOOK_ORDER_NORMALIZERS and WEBHOOK_ORDER_UPDATE_HANDLERS, ORDER_ELIGIBILITY_STRATEGIES, CommerceOutcomeAdapter with tracksSynchronization and the commerce_outcome_syncs tracking, SOURCE_SETUP_CONTRIBUTORS and the source health DTO, source-less signup (sourceMode "connect"), token-encryption util, dual-auth guard, withSerializableRetry.
- One source per organization. Only fresh/unprovisioned organizations can connect. No source switching, no replacing an active Shopify, Standalone or EasyOrders source.
- Every request to a store goes through the restricted outbound client (HTTPS only, public addresses only, pinned resolution, no redirect into private ranges, bounded time and size). The store URL is merchant-supplied: treat it as hostile input everywhere.
- Every query and remote call is scoped to the order's own integration. A cross-tenant path is a bug, never an edge case.
- Consumer keys, webhook secrets and URL tokens are encrypted or hashed at rest and never logged, returned, put in a URL or put in fixtures.
- All merchants send from the Akeed WhatsApp sender. WooCommerce pilot organizations get the same pilot entitlement as EasyOrders. No billing work.
- Shopify, Standalone and EasyOrders behavior must not change. Their tests pass untouched. A shared change is its own commit with their suites run before and after.
- User-facing strings go through next-intl in both ar.json and en.json.
- Don't expand scope. If the story and the code disagree, say so and propose the smallest fix.

Done means: the story's acceptance criteria and test requirements are covered by tests, lint/typecheck/test/build pass in every repo you touched, migrations are additive, reversible and noted, an evidence file is written (docs/US-07-0x-WOOCOMMERCE-*-EVIDENCE.md, same sections as the E06 ones), and the story's Status plus the epic README table are updated. Finish with a summary: what changed, decisions you made, test results as actually run, what was not run, and anything left open.
```

---

## Step 1: US-07-01 contract and implementation plan

```text
Story: docs/Epics/07-woocommerce-integration/US-07-01-woocommerce-integration-contract-and-implementation-plan.md

This story produces documents and fixtures. Write no production code and send no request to any store.

1. Read the four WooCommerce doc pages linked in the story, plus the REST reference pages for orders, order notes, webhooks and system status. Read the extension points the story lists, and docs/Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md for the record's shape.
2. Write docs/Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md, dated, with the source URL and the date read for each finding. Eight sections, as the story's AC 1 lists. Label each finding DOCUMENTED, DECIDED or UNKNOWN. Use UNKNOWN only where the docs are silent, and give each one a worst-case rule. Leave a VERIFIED column empty for step 6. It must settle:
   - the authorize link parameters, the callback body, how the callback is bound to one organization and one store (single-use token in the callback path and in user_id; the body has no store URL), and what return_url success=0/1 may and may not be used for;
   - how the keys are proven and what the canonical store identity is;
   - the webhooks Akeed creates (topics, delivery URL with per-install token, Akeed-generated secret), the delivery headers, the signature, the three-part tenant check (URL token, raw-body HMAC, X-WC-Webhook-Source), and the ping;
   - the 5-consecutive-failure disable rule, what Akeed therefore answers and when, and how a disabled webhook is detected and re-enabled;
   - the ingestion rule: order.created can fire for a checkout draft; which status plus payment_method "cod" starts a verification; the semantic idempotency key; how a delivery is routed to the create path or the update handler; the rule that an order older than the connection never starts a verification;
   - the payload mapping to NormalizedOrder (id, number, name, billing phone, billing country, decimal total, currency) and the recorded reasons when a field is missing;
   - the approved outcome mapping from the epic README decisions, the statuses a cancellation may be written from, the idempotent write (marker and status in one order update, note at most once), read-back after a lost answer, and echo handling;
   - timeouts, 429/503/Retry-After handling, and that there is no per-store budget;
   - disconnect: webhooks deleted by REST, API key removed manually by the merchant.
3. Write the support boundary (AC 5) with a code and a merchant-facing message for each unsupported case, and the adapter boundary (AC 6): file list for the spoke, tables, registration points, switches (WOOCOMMERCE_CONNECT_ENABLED, WOOCOMMERCE_PILOT_ORG_IDS, WOOCOMMERCE_INGESTION_ENABLED, WOOCOMMERCE_OUTCOME_SYNC_ENABLED, NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED) and the restricted outbound client's rules.
4. Save fixtures under test/fixtures/woocommerce/ built from the documented shapes: order as checkout draft, as placed COD order, as non-COD order, order updated, ping. Synthetic IDs, no secrets, no real customer data, a README saying "documented, not captured".
5. End the record with a supported / unsupported / unknown table, the list of at most eight observations for step 6 (callback origin, ping body, status of a placed COD order on classic checkout and on the Checkout block, side effects of cancelled, whether a meta-only update echoes as order.updated, API-key removal), and a clear verdict on whether steps 2 to 6 are unblocked. An UNKNOWN on authenticity, tenant resolution or secret handling means blocked.
6. Update the story Status and the epic table. Then stop and wait for my review of the record before any code.
```

---

## Step 2: US-07-02 connect through application auth

```text
Story: docs/Epics/07-woocommerce-integration/US-07-02-connect-woocommerce-through-application-authentication.md

Build the connect flow exactly as the contract record defines it.

Shared, as separate commits before the spoke:
- The restricted outbound client under src/shared/http/, with its own spec (private, loopback and link-local addresses, DNS resolving to a private address, redirect to a private address, plain HTTP, invalid TLS, oversized and slow responses). Nothing existing is moved onto it.
- Generalize the source-connect switch that signup reads (isSourceConnectEnabled) so either EasyOrders or WooCommerce being on allows a source-less signup. EasyOrders specs pass untouched.

Backend:
- Spoke under src/infrastructure/spokes/woocommerce/ with config, an auth service, an API client on the restricted client, start-install and callback controllers. Model it on the EasyOrders ones.
- Start install (owner/admin only, switch on, organization on the allow-list, no integration row): validates and canonicalizes the store URL, creates a single-use expiring install context bound to the organization and that store, returns the authorize link (scope read_write).
- Callback (public, throttled): validates the context, proves the keys with a permitted REST read against the context's store URL, then creates the webhooks with an Akeed-generated secret and a per-install delivery URL token, then in one transaction stores the canonical store identity, encrypted credentials, token hash and webhook ids and provisions the woocommerce source with the EasyOrders pilot entitlement and onboarding defaults.
- Reject without mutation: replayed or expired context, bad credentials, cross-tenant callback, a store verified for another organization, an organization that has any source. Concurrent connects and a retry after a partial failure are safe. A failed webhook creation leaves nothing half-connected.
- A return_url handler that only shows the denied or waiting state; it proves nothing and stores nothing.
- The delivery URL exists as a route that answers 404 until step 3, except that the ping is answered as the contract record says.
- Refuse each unsupported-store case with its own code.

Frontend: WooCommerce in the signup source picker (behind NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED) and a connect skin: store URL entry, waiting, denied, unsupported store, error, connected. Arabic and English, RTL. Follow the existing source-driven onboarding skins. Nothing secret on screen.

Tests: every case in the story's test requirements, in a PostgreSQL contract suite like test/easyorders-connection.contract-spec.ts, with the provider as a fake fetch built from the contract record. Add the new migration to the other contract suites' migration lists as E06 did.
```

---

## Step 3: US-07-03 ingest signed order webhooks

```text
Story: docs/Epics/07-woocommerce-integration/US-07-03-ingest-signed-woocommerce-order-webhooks.md

Backend:
- Webhook controller and service for the delivery URL. In order, before anything else: URL token (hash lookup, the tenant signal), raw-body HMAC against that install's secret in constant time, X-WC-Webhook-Source against the bound store. One 401 for any failure, nothing stored, a counter for refused deliveries on a valid token. Make sure the raw body is available on this route.
- Apply the contract record's routing rule: a delivery that starts a verification goes to the create path with the semantic key order.create:<integrationId>:<orderId>; a delivery for an order Akeed already has goes to the update path (recorded only in this step; handling is step 4); a draft, pending, non-COD or too-old order is recorded as skipped with a stable reason code.
- Acknowledge 2xx only after WebhookQueueProducer.ingest has written the event. Queue outage still answers 2xx; database failure answers 5xx and logs a possibly lost event. Ping: 2xx, nothing stored.
- A WebhookOrderNormalizer and an OrderEligibilityStrategy for woocommerce, registered next to the existing ones. Currency, total and billing country come from the payload. A missing currency or unparsable phone is a recorded reason, never a guess. No order lookup, no rate limiter.
- Inactive, disconnected or not-ready sources lead to no send. With WOOCOMMERCE_INGESTION_ENABLED off the route answers 404.

Frontend: the WooCommerce source label and messages for any new reason codes, through the existing maps. No adapter-specific logic in shared code.

Tests: drive them from the step 1 fixtures. Cover every case in the story's test requirements, in a PostgreSQL contract suite like test/easyorders-ingestion.contract-spec.ts. The cases that matter most here: draft then placed gives one verification; created and updated arriving together give one; the same order id from two stores stays apart; an order older than the connection starts nothing.
```

---

## Step 4: US-07-04 apply approved outcomes

```text
Story: docs/Epics/07-woocommerce-integration/US-07-04-apply-approved-verification-outcomes-in-woocommerce.md

Nothing shared needs extracting: the outcome contract, registry, sync tracking, retry worker, retry endpoint and the dashboard "Store update" section exist. If you find you need to change any of them, stop and say why first.

Backend:
- WooCommerceOutcomeAdapter implementing CommerceOutcomeAdapter with tracksSynchronization true, registered in commerce-outcome.module.ts. Capabilities: customer_confirmation, customer_cancellation, merchant_no_reply_cancellation. Not automatic_no_reply_tagging and not merchant_cancellation_tagging. With WOOCOMMERCE_OUTCOME_SYNC_ENABLED off: no capability, no request.
- Mapping from the contract record: confirmation writes the Akeed meta marker and one order note, no status change; the two cancellations write cancelled, only from the allowed current statuses.
- Read, then write, then read back after a lost answer. Marker and status go in one order update so a repeat is harmless; the note is added only when the read shows the marker was not already there. A terminal, custom or unlisted current status is remote_state_conflict and is not overwritten. A response that cannot prove it is this store's order fails closed.
- Each call uses the order's own integration and key through the restricted client. Credential and permission errors are permanent with requiresAssistance and update connection health. 429, 503 and Retry-After use retryAfterMs; other transient failures use the existing backoff.
- A WebhookOrderUpdateHandler for woocommerce, registered in webhook-queue.module.ts: the echo of Akeed's own write is reflected_outcome; any other change is remote_status_observed; neither changes a verification or starts one.

Frontend: messages for any new error codes in the existing "Store update" section, ar and en. Nothing else.

Tests: the shared defineCommerceOutcomeAdapterContract for WooCommerce, the adapter and handler specs, and a PostgreSQL contract suite like test/easyorders-outcome-sync.contract-spec.ts covering every case in the story's test requirements, including timeout before and after the write was taken, one note for a repeated outcome, and the feedback loop.
```

---

## Step 5: US-07-05 setup, health, disconnect and support

```text
Story: docs/Epics/07-woocommerce-integration/US-07-05-woocommerce-setup-health-disconnect-and-support.md

Read akeed-frontend/src/features/onboarding and src/features/settings first: the story's frontend evidence was not re-read when the epic was refactored.

Backend:
- WooCommerceSetupContributor registered in SOURCE_SETUP_CONTRIBUTORS: connection state, store, credential status, blocked reasons. Currency and phone country are not setup inputs for this source; make sure setup can complete without them and without changing what EasyOrders requires.
- Connection checks with distinct codes: invalid URL or TLS, REST unreachable, permission denied, credentials rejected, webhook missing, webhook disabled.
- Health: extend the existing source-health read with each Akeed webhook's state read from the store. If a new blocked reason is needed for a disabled webhook, add one; never rename an existing reason.
- Re-enable a disabled webhook (owner/admin).
- Disconnect (owner/admin, not gated by the connect switch): blocks new and queued external effects, deletes Akeed's webhooks by REST as best effort and reports a failure, wipes credentials, token hash and webhook ids, closes waiting store updates, keeps all history.
- Reconnect through the same install flow, only for the organization's own disconnected woocommerce source and only to the same canonical store, in place. Old webhooks are replaced, never duplicated.

Frontend: extend the source skins: setup checklist and completion, the Settings connection panel (disconnect with confirmation, reconnect, re-enable webhook, manual API-key removal steps), the health card. States in ar and en (RTL): connected, webhook disabled, credentials rejected, disconnected, and actionable errors. No secret shown. No promise of recovering missed orders.

Docs: docs/Epics/07-woocommerce-integration/evidence/US-07-05-disconnect-and-support-runbook.md, modelled on the E06 runbook.

Tests: every case in the story's test requirements, including viewer and cross-tenant controls, reconnect without duplicate webhooks, and history and health after disconnect.
```

---

## Step 6: US-07-06 release gate and pilot

```text
Story: docs/Epics/07-woocommerce-integration/US-07-06-woocommerce-release-gate-and-pilot.md

This is a gate. Fix defects you find; add no features. Start with a code review of steps 2 to 5, as the E06 gate did.

1. Extract the provider-neutral matrix from test/easyorders-release-gate.contract-spec.ts into a shared conformance harness under test/contracts/, parameterized by a spoke driver (connect, deliver an order, deliver an update, answer an outcome, fake provider controls). Commit it on its own with the EasyOrders gate passing and asserting the same things as before. If a clean extraction is not possible without weakening the EasyOrders assertions, stop and tell me what blocks it.
2. Build test/contracts/woocommerce-provider-fake.ts from the contract record and run the conformance matrix for WooCommerce: journey (confirm and cancel), duplicates and replays, wrong-store and cross-tenant, key revocation, throttling, queue and provider outages, fault injection (install callback, webhook creation, queue dispatch, status write timing out before and after it was taken), disconnect and reconnect, no automatic no-reply cancellation, pausing WooCommerce without touching Shopify, Standalone or EasyOrders, secrets.
3. Add the WooCommerce-only cases: HMAC and source header, draft then placed, webhook disable and re-enable, SSRF on every outbound path.
4. Add scripts/test-e07-release-gate.ps1 and test:gate:e07. Stop the dev servers and run the E01, E04, E05, E06 and E07 gates as scripts, plus the full suites in both repos. Report results exactly as run, and list what was not run.
5. Write docs/Epics/07-woocommerce-integration/evidence/US-07-06-live-pilot-script.md for me to run on a real store with a fresh pilot organization: connect → COD order → webhook → Akeed WhatsApp → confirm → note and marker in WooCommerce; cancel → cancelled; an order nobody answers (nothing written to the store); duplicate delivery; non-COD order; disconnect and reconnect. Include the step that closes each observation from the contract record, a classic-checkout and a Checkout-block pass, the localized walkthrough checklist (ar/RTL and en, light and dark), what to hand back, and stop/rollback. Add a read-only reconciliation SQL script for the pilot organization.
6. Wait for my run. Then reconcile events, orders, verifications, usage and store updates from it, record real API responses with secrets removed, and move each observation in the contract record to VERIFIED. If anything contradicts the record, stop and propose a focused validation story.
7. Write docs/Epics/07-woocommerce-integration/evidence/US-07-06-release-gate.md: results per acceptance criterion, commands as run, the switch table and enable/disable order, how to pause new WooCommerce connections without touching other sources, known limits, and a go/no-go recommendation. The decision is mine.
```
