# E05 — Implementation prompts

There is one prompt per story. Run them **in order, one story per fresh Claude Code session**, started in `D:\Software_Development\Akeed`. Start only after E04.6 is implemented, because E05 reuses its ingestion command and shared services. Don't start a story until the previous story's evidence section records a passing result.

---

## Shared rules

1. **All E04.6 shared rules apply unchanged.** Read and follow [E04.6 shared rules](../04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md#shared-rules): plan first, tenant safety, privacy in logs, additive migrations, CRLF and targeted prettier/eslint only, frontend-dev skill for UI, tests, verification and close-out evidence.
2. **Read first:** the story file, the [E05 README](README.md) (especially *Architecture* and *Approved product decisions*), and the E04.6 README sections *Architecture — adapters in, one core out* and *Reuse map*.
3. **The API is one more channel adapter.** The only new business-facing code in E05 is:
   - the key lifecycle (US-05-01);
   - `IntegrationApiKeyGuard`;
   - abuse controls (US-05-04);
   - `ApiOrderChannelAdapter`, which maps the request DTO to `CanonicalOrderInput` and nothing else.

   Everything else goes through `StandaloneOrderIngestionService.acceptOne`: source resolution, readiness and credit gates, field rules, phone parsing, reference normalization, envelope, fingerprint, idempotency, persistence and dispatch.
4. **Forbidden in the API module** (`src/modules/order-api/`): importing `ManualOrderIngestionRepository`, `WebhookEventsRepository`, `WebhookDispatchService`, `CreditEligibilityService`, `BillingEntitlementService`, the envelope builder, `PhoneNumberUtil`, or anything in `verification-core`. The same goes for declaring limits, regexes or currency lists.
5. **If something is missing, extend the core.** If the command lacks a capability the API needs (for example the existing-external-ID replay/conflict branch), add it **to the command** so manual and file import inherit it. Prove the manual-order and file-import suites still pass. Never special-case it in the API layer.
6. **No channel branching downstream.** `'api'` is appended to `STANDALONE_INGESTION_CHANNELS`, and nothing in the normalizers, eligibility strategies, `verification-core` or send path may read it.
7. **Regression suites before and after every story:**
   - `npm run test:contract:manual-orders`
   - the E04.6 bulk-import contract suite
   - `npm run test:contract:entitlements`
   - `npm run test:contract:shopify`
   - the credit contract suites

   Record both runs.

---

## US-05-01 — Integration API key lifecycle

```text
Implement US-05-01 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-01-integration-api-key-lifecycle.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: owners and admins issue, list and revoke server API keys for their ready Standalone source. A key authenticates into the same ingestion context the session path uses.

Read first:
- src/modules/auth/guards/dual-auth.guard.ts and src/modules/auth/organization-role.ts.
- StandaloneSourceResolver (from E04.6 US-04.6-02) and StandaloneOrderIngestionService's context type (E04.6 US-04.6-01).
- admin_access_audit and buildBackendLog.
- akeed-frontend src/features/settings (tabs in domain/settingsTabs.ts) and shared/ui.

Build:
1. Additive migration: integration_api_keys (id, org_id, integration_id, prefix (non-secret, e.g. 'ak_live_' + 8 chars), key_hash (SHA-256 of a 32-byte random secret, compared timing-safe), name, created_by, created_at, last_used_at, revoked_at, revoked_by), with RLS by org_id, a unique prefix and an index (integration_id, revoked_at).
2. Endpoints (session auth, owner/admin; viewers read-only):
   - POST /api/integration-keys creates a key and returns the full secret once.
   - GET /api/integration-keys lists metadata only.
   - DELETE /api/integration-keys/:id revokes immediately and idempotently.
   - The source comes from StandaloneSourceResolver with an API_KEY_* code map. Never re-query integrations.
3. IntegrationApiKeyGuard: parse only 'Authorization: Bearer <key>' (reject query-string keys), look up by prefix, compare the hash timing-safe, reject revoked or unknown keys with a uniform 401, update last_used_at at most once per minute, and attach the ingestion context {orgId, integrationId, actor:{type:'api_key', keyId, prefix}} in the exact shape StandaloneOrderIngestionService expects.
4. Audit: key create/revoke writes actor, action and prefix, never the secret or hash.
5. Frontend: a Settings → "API keys" tab (Standalone only). List, create dialog with one-time reveal and copy, a warning that the key is server-only, revoke confirmation. AR/EN, RTL, dark mode. The secret is kept only in component state and cleared on close or navigation.

Tests:
- The owner/admin/viewer/cross-tenant matrix; the secret is never in list responses or logs; revoked, unknown and malformed keys; a query-string key is rejected; concurrent use during rotation.
- The guard context shape matches the session context (a type-level and runtime test).

No order endpoint in this story.
```

## US-05-02 — Authenticated order ingestion endpoint

```text
Implement US-05-02 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-02-authenticated-order-ingestion-endpoint.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: POST /api/v1/orders accepts an order from a server integration through the SAME ingestion command as manual orders and file import. The API adds an adapter, not a pipeline.

Read first:
- StandaloneOrderIngestionService, CanonicalOrderInput, STANDALONE_INGESTION_CHANNELS, canonical-order.rules.ts, the shared order-reference normalizer, PhoneService.parse, and the ManualOrderChannelAdapter (as the model to follow). All come from E04.6.
- src/modules/orders/orders.controller.ts (thin controller pattern) and the E04.6 README Architecture and Reuse map.

Build:
1. src/modules/order-api/:
   - order-api.controller.ts: versioned v1, IntegrationApiKeyGuard, body size limit, correlation ID header.
   - dto/create-api-order.dto.ts: externalOrderId, optional orderNumber/customerName, customerPhone, decimal-string totalPrice, currency, paymentMethod. Decorators read the shared canonical-order.rules constants; nothing is re-declared.
   - api-order.channel-adapter.ts: DTO → CanonicalOrderInput. externalOrderId goes through the shared reference normalizer (ref:<normalized>). orderNumber defaults to the client's externalOrderId as written when absent.
2. The controller calls StandaloneOrderIngestionService.acceptOne(ctx from the guard, input, {channel:'api', idempotencyKey}) and maps the result to {orderId, verificationId?, status:'accepted', duplicate}. Supplied orgId/integrationId/platform fields are rejected or ignored and never reach the command.
3. Append 'api' to STANDALONE_INGESTION_CHANNELS. There must be no other change in normalizers, eligibility strategies or verification-core.
4. Add an API_* code map for source and readiness blockers to the resolver and readiness service calls inside the command (API_SOURCE_UNAVAILABLE, API_SETUP_INCOMPLETE, API_AUTO_VERIFY_DISABLED, API_ENTITLEMENT_REQUIRED, API_VALIDATION_FAILED). Credit codes pass through unchanged.
5. Until US-05-03 lands, require Idempotency-Key using the shared validator (the command namespaces it api:<key>).

Tests:
- Schema validation, a bad key, tenant spoofing, inactive or unready source, non-COD accepted-but-not-sent.
- An equivalence test: the same canonical order via manual, file import and API yields identical NormalizedOrder, fingerprint, verification, credit hold and dashboard lifecycle.
- An architecture test: src/modules/order-api imports nothing from the forbidden list in the shared rules.
- The regression suites before and after.
```

## US-05-03 — Idempotency and conflict handling

```text
Implement US-05-03 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-03-idempotency-and-conflict-handling.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: retries and duplicate creates are safe across channels, implemented ONCE in the ingestion command so manual, file import and API share identical semantics.

Read first:
- StandaloneOrderIngestionService and ManualOrderIngestionRepository.acceptWithinTransaction (E04.6 US-04.6-01/06): the existing event-key replay/conflict logic.
- fingerprintCanonicalOrder and the idempotency-key validator.
- The unique indexes on webhook_events and orders in schema.ts.

Build (in the command/repository core, not in order-api):
1. Idempotency-key namespacing per channel inside the command: api:<key>. Manual keys stay unchanged; import keys are import:<batchId>:<row>. A test proves an API key string equal to an existing manual key does not collide.
2. Same namespaced key + same canonical fingerprint → original identifiers, duplicate=true (including after key rotation, because the scope is the source, not the credential). Same key + different fingerprint → 409 API_ORDER_IDEMPOTENCY_CONFLICT (manual keeps MANUAL_ORDER_IDEMPOTENCY_CONFLICT via the code map).
3. The existing-external-ID branch, added once in acceptWithinTransaction:
   - A new key whose ref:<normalized externalOrderId> already exists for the source → replay if the canonical fingerprint matches (duplicate=true, NO new webhook event, no dispatch, no credit hold).
   - Otherwise 409 API_ORDER_EXTERNAL_ID_CONFLICT.
   - acceptMany (file import) keeps mapping this to ALREADY_IMPORTED. Make sure its behavior and the E04.6 contract suite are unchanged.
4. Concurrency: equal concurrent requests resolve to one acceptance through the existing transactional uniqueness. Persistence followed by a lost response replays on retry.
5. The fingerprint covers canonical business fields only, never the channel, so the same order from file then API compares equal.

Tests:
- Concurrent identical and conflicting requests; reordered JSON keys; credential rotation; a timeout after persistence (a fault injected after commit, before the response).
- The same key or external ID in two integrations (isolated).
- A new key targeting an existing order; an order imported by file then posted by API (identical → duplicate replay, different → 409); an API key string equal to a manual key.
- Assert zero extra events, verifications, dispatches and credit holds in every replay and conflict case.
- The manual-order and E04.6 suites are unchanged.
```

## US-05-04 — API abuse controls and audit

```text
Implement US-05-04 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-04-api-abuse-controls-and-audit.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: one faulty client can't exhaust shared resources. Throttled or oversized requests never reach the ingestion command, and every outcome is traceable without secrets or customer PII.

Read first: the @nestjs/throttler setup in app.module.ts and its per-route usage (billing.controller.ts), the Redis config, buildBackendLog, and the E04.6 US-04.6-09 metrics and alert conventions.

Build:
1. A source-level rate limiter keyed by integrationId (not by key), so rotating keys can't bypass it. It is Redis-backed, uses env-configurable limits (per minute and burst) plus a global cap, and returns 429 with Retry-After. It is applied in a guard/interceptor BEFORE the channel adapter, and a test proves StandaloneOrderIngestionService is never called for throttled requests.
2. A body size limit for /api/v1 (env, e.g. 32 KB) → 413 API_PAYLOAD_TOO_LARGE.
3. A uniform error envelope {code, message, correlationId} for auth, validation, conflict, throttle and server errors. Never leak SQL, stack traces or other-tenant data.
4. Request audit: a minimal api_request_log table (or reuse the E04.6 audit approach if equivalent) with integrationId, key prefix, correlationId, route, outcome code, duration and orderId?, with no payload. Configurable retention and a purge job on the existing order-import/ops queue pattern.
5. Metrics: rejection rate by code, acceptance latency, queue age. Alerts for a sustained 5xx rate and a 429 spike per source.
6. Frontend: key metadata shows last used and revoked; errors localized.

Tests:
- Burst and concurrent load; a rotated-key bypass attempt; oversized bodies; retry after throttling succeeds.
- Throttled requests create no order and use no credit.
- A redaction scan across auth, provider and DB error paths; tenant-safe correlation lookup.
```

## US-05-05 — Server integration guide

```text
Implement US-05-05 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-05-server-integration-guide.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: a developer can integrate once from the docs alone, and every documented behavior is proven by a contract test.

Read first: the implemented order-api DTOs and error codes, the US-05-03 replay/conflict rules, akeed-frontend content/docs/{ar,en} (the public docs structure), and the existing docs/[slug] route.

Build:
1. A versioned English API guide under akeed-frontend/content/docs/en (plus a short Arabic overview with a link):
   - Key creation and revocation; the Authorization header; required Idempotency-Key and how to generate one per order.
   - Fields, and externalOrderId semantics, including that an order imported by file with the same reference is the same order.
   - Readiness and credit errors; accepted is not delivered; create-only semantics; server-only secrets; the one-source restriction.
2. Examples in curl and HTTP with placeholders and synthetic data only: success, duplicate replay, 409 idempotency conflict, 409 external-ID conflict, 413, 429 with Retry-After, invalid phone, blocked source, and lost-response retry.
3. A troubleshooting decision path and the support contact process. Link to the dashboard lifecycle; don't imply any status or callback endpoint.
4. A contract test that parses the examples from the guide and runs them against a test instance with a disposable key, asserting the documented status and code for each.
5. A help link from Settings → API keys to the guide.
```

## US-05-06 — API security and recovery release gate

```text
Execute US-05-06 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: recorded evidence that the API is safe to pilot and that the adapter architecture held. This is a verification story: fix only defects the gate uncovers, noting the owning story for each.

Do:
1. The two-tenant suite: credentials, idempotency responses, orders, usage and errors can't cross organizations.
2. Revocation: new requests fail at once, and previously accepted orders stay auditable and follow source state.
3. The fault suite: concurrent duplicates, conflicting payloads, DB and Redis outage, and a lost response after commit. Reconcile order, verification, dispatch, credit and request counts after each; no duplicate business effects.
4. The architecture and equivalence checks (AC6):
   - The same canonical order via manual, file import and API gives identical verification, dispatch ledger, credit, follow-up and dashboard results.
   - src/modules/order-api reaches persistence and dispatch only through StandaloneOrderIngestionService.
   - Nothing in verification-core, the normalizers or the eligibility strategies reads ingestionType.
   - The E04.6 reuse-map duplication check still passes with the API code included.
5. Run all documented examples (US-05-05); send one end-to-end API order through a fake messaging port to a confirmed outcome visible on the dashboard.
6. The regression suites: the E04 manual journey, the E04.6 bulk import suite, the E01 Shopify gates, and both-mode frontend checks. Record every command and its counts.
7. Prepare, but don't execute, the authorized pilot with synthetic orders: the checklist, support and recovery steps, and rollback (disable new acceptance, keep history). Hand the live steps to me.

Close-out: set the story to "Implemented locally — release blocked (pilot pending)" unless I provide pilot results. Update the E05 README status column.
```
