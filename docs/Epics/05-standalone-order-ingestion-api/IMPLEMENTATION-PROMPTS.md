# E05 — Implementation prompts

There is one prompt per story. Run them **in order, one story per fresh Claude Code session**, started in `D:\Software_Development\Akeed`. E04 and E04.6 are implemented, and E05 reuses their ingestion command and shared services. Don't start a story until the previous story's evidence section records a passing result.

---

## Shared rules

0. **Headline rule: E05 must not implement order business logic.** Manual, file-import, Shopify and API orders converge on one ingestion command and one verification pipeline. If the API needs something the core lacks, add it **to the core** so manual and file import inherit it, and prove their suites still pass. Never special-case it in the API layer.
1. **All E04.6 shared rules apply unchanged.** Read and follow [E04.6 shared rules](../04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md#shared-rules): plan first, tenant safety, privacy in logs, additive migrations, CRLF and targeted prettier/eslint only, the frontend-dev skill for UI, tests, verification and close-out evidence. Load the backend-dev skill before backend code.
2. **Read first:** the story file and the [E05 README](README.md), especially *Already implemented vs what E05 adds*, *Core gaps*, *Architecture* and *Approved product decisions*. Then read the real code it points to:
   - `src/modules/order-ingestion/` (service, types, keys, errors, source resolver, send readiness, and the three architecture specs);
   - `src/infrastructure/database/repositories/manual-order-ingestion.repository.ts`;
   - `src/modules/orders/orders.service.ts` and `manual-order.channel-adapter.ts` (the channel to model and, in US-05-02, to migrate);
   - `src/modules/order-imports/file-import.channel-adapter.ts`;
   - `src/shared/commerce/{standalone-order-envelope,canonical-order.rules}.ts` and `src/shared/validation/idempotency-key.ts`.
3. **The only API-specific code** is the key lifecycle and `IntegrationApiKeyGuard` (US-05-01), the controller, DTO and `ApiOrderChannelAdapter` with its `API_*` code maps (US-05-02/03), and the throttle, body limit and error envelope (US-05-04).
4. **Forbidden in `src/modules/order-api/`:** importing `ManualOrderIngestionRepository`, `WebhookEventsRepository`, `WebhookDispatchService`, `CreditEligibilityService`, `BillingEntitlementService`, `StandaloneSendReadinessService` (use `submitOne`), the envelope builder or fingerprint, `PhoneNumberUtil`, or anything in `verification-core`; declaring limits, regexes or currency lists. `PhoneService` and `normalizeIdempotencyKey` are allowed.
5. **No channel branching downstream.** `'api'` is appended to `STANDALONE_INGESTION_CHANNELS`, `IDEMPOTENCY_KEY_PREFIX` and the ingestion service's log-action map; nothing in the normalizers, eligibility strategies, `verification-core` or the send path may read it.
6. **Regression suites before and after every story** (record both runs):
   - `npx jest src/modules/order-ingestion` (includes `reuse-map`, `release-gate-architecture`, `ingestion-boundary`)
   - `npx jest src/modules/orders src/modules/order-imports`
   - `npm run test:contract:manual-orders`
   - `npm run test:contract:order-imports` and `npm run test:contract:order-import-release-gate`
   - `npm run test:contract:entitlements`
   - `npm run test:contract:shopify`
   - the credit contract suites (`scripts/test-e045-contracts.ps1`)

---

## US-05-01 — Integration API key lifecycle

```text
Implement US-05-01 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-01-integration-api-key-lifecycle.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: owners and admins issue, list and revoke server credentials for their ready Standalone integration. Keys are integration credentials, not a generic auth framework.

Read first:
- src/modules/auth/guards/dual-auth.guard.ts and src/modules/auth/organization-role.ts.
- StandaloneSourceResolver and its StandaloneSourceCodeMap constants; StandaloneIngestionContext in standalone-order-ingestion.types.ts.
- buildBackendLog; akeed-frontend src/features/settings (tabs in domain/settingsTabs.ts) and shared/ui.

Build:
1. Additive hand-written migration: integration_api_keys (id, org_id, integration_id, prefix (non-secret, e.g. 'ak_live_' + 8 chars), key_hash (SHA-256 of a 32-byte random secret), name, created_by, created_at, last_used_at, revoked_at, revoked_by), RLS by org_id, unique prefix, index (integration_id, revoked_at). Add it to the order-imports contract migration list.
2. Endpoints (session auth, owner/admin; viewers read-only):
   - POST /api/integration-keys creates a key and returns the full secret once.
   - GET /api/integration-keys lists metadata only.
   - DELETE /api/integration-keys/:id revokes immediately and idempotently.
   - The source comes from StandaloneSourceResolver.resolveWritable(user, API_KEY_SOURCE_CODES), a new code map beside MANUAL_ORDER_SOURCE_CODES. Never re-query integrations.
3. IntegrationApiKeyGuard: parse only 'Authorization: Bearer <key>' (reject query-string keys), look up by prefix, compare the hash timing-safe, uniform 401 for revoked/unknown/malformed keys, update last_used_at at most once per minute, attach the principal {orgId, integrationId, keyId, prefix}. It does NOT build StandaloneIngestionContext (US-05-02 does, via the resolver).
4. Audit: key create/revoke logs actor, action and prefix, never the secret or hash.
5. Frontend: Settings → "API keys" tab (Standalone only): list, create dialog with one-time reveal and copy, server-only warning, revoke confirmation. AR/EN, RTL, dark mode. The secret lives only in component state and is cleared on close or navigation.

Tests:
- Owner/admin/viewer/cross-tenant matrix; the secret is never in list responses or logs; revoked, unknown and malformed keys; a query-string key is rejected; concurrent use during rotation.

No order endpoint in this story.
```

## US-05-02 — Submit API orders to the existing ingestion command

```text
Implement US-05-02 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-02-authenticated-order-ingestion-endpoint.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: POST /api/v1/orders converts an external order into CanonicalOrderInput and submits it to the SAME ingestion command as manual orders and file import. Do Part A (core) first and get it green before writing any order-api code.

Read first:
- OrdersService.createManualOrder and assertManualCreateReady (the pre-accept steps that today live in the manual channel).
- StandaloneSourceResolver.resolveWritable, StandaloneSendReadinessService.evaluate and SendReadinessBlocker.
- StandaloneOrderIngestionService.acceptOne, ManualOrderChannelAdapter, FileImportChannelAdapter, canonical-order.rules.ts, normalizeOrderReference, normalizeIdempotencyKey, PhoneService.standardize.

Part A — core (src/modules/order-ingestion/):
1. StandaloneSourceResolver.resolveForIntegration(orgId, integrationId, codes): same active / Standalone / onboarding-completed / single-active-source checks as resolveWritable, plus the source must be integrationId. No role check.
2. A readiness code-map type and one shared gate function mapping SendReadinessBlocker[] to the channel's exception with today's precedence (entitlement → auto-verify → credit (E04.5 code unchanged) → slot/plan limit → fail closed).
3. StandaloneOrderIngestionService.submitOne(principal, input, options): resolve → readiness.evaluate(source, {required: 1}) → gate → acceptOne. Principal = session user or {orgId, integrationId, keyId, prefix}.
4. Move createManualOrder onto submitOne with the MANUAL_ORDER_* maps; delete assertManualCreateReady. Manual responses must stay byte-identical: orders.service.spec.ts and test:contract:manual-orders pass with no expectation edits.

Part B — API (src/modules/order-api/):
5. order-api.controller.ts: versioned v1, IntegrationApiKeyGuard; body typed per the global-ValidationPipe rule so validation errors are coded.
6. dto/create-api-order.dto.ts: required externalOrderId, customerName, customerPhone, decimal-string totalPrice, currency, paymentMethod; optional orderNumber and the import extras orderDate, city, address, notes. Decorators read canonical-order.rules constants; unknown fields rejected.
7. api-order.channel-adapter.ts: toCanonicalOrderInput (externalOrderId → normalizeOrderReference; orderNumber defaults to externalOrderId as written; phone via PhoneService.standardize) and rethrowAsHttp (StandaloneIngestion*Error → API_ORDER_ACCEPTANCE_FAILED / API_ORDER_DISPATCH_FAILED / API_ORDER_IDEMPOTENCY_CONFLICT).
8. API code maps: API_SOURCE_UNAVAILABLE, API_SETUP_INCOMPLETE, API_AUTO_VERIFY_DISABLED, API_ENTITLEMENT_REQUIRED, API_PLAN_LIMIT_REACHED, API_VALIDATION_FAILED; credit codes pass through.
9. Append 'api' to STANDALONE_INGESTION_CHANNELS, IDEMPOTENCY_KEY_PREFIX ('api:') and LOG_ACTION_PREFIX. No other change in normalizers, eligibility strategies or verification-core.
10. Response {orderId, verificationId?, status: 'accepted', duplicate}.

Tests:
- Part A: resolveForIntegration cases; gate precedence; manual suites unchanged.
- Part B: schema validation, bad key, tenant spoofing, unready source, non-COD accepted-but-not-sent, every API_* code.
- Unit equivalence: the same order via the three adapters → same CanonicalOrderInput, envelope order and fingerprint.
- Extend ingestion-boundary / release-gate-architecture specs to cover src/modules/order-api.
```

## US-05-03 — Extend shared idempotency to external order identity

```text
Implement US-05-03 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-03-idempotency-and-conflict-handling.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: a new idempotency key for an order Akeed already has is replayed or rejected in the CORE, never duplicated and never a 503. Do not rebuild what already exists: event-key replay, fingerprint conflict, source-scoped keys, namespacing and concurrency are in acceptWithinTransaction today — assert them, don't reimplement them.

Read first:
- ManualOrderIngestionRepository.acceptWithinTransaction / acceptMany / acceptRowInSavepoint.
- StandaloneOrderIngestionService.acceptOne (duplicate → dispatchById) and standalone-order-ingestion.errors.ts.
- fingerprintCanonicalOrder; the unique indexes on webhook_events and orders; webhook_events.hold_state.

Build (core only; order-api only maps the new error):
1. In acceptWithinTransaction, non-held path: when the order insert hits (integration_id, external_order_id), load the existing order and compare its rawPayload.submissionFingerprint with the incoming one (strict, existing fingerprint).
   - Equal → return it with duplicate=true and a replay marker 'external_id'; roll back the event just inserted (savepoint or pre-check) so no new event remains.
   - Different → throw StandaloneIngestionExternalIdConflictError (new, channel-neutral).
   - Held path unchanged: still 'already_imported'.
2. acceptOne: an 'external_id' replay returns without dispatchById (no verification, message or credit hold). Held import orders stay held; withdrawn stay withdrawn.
3. Same-key replay keeps its existing re-dispatch behavior (lost-response recovery).
4. API adapter maps the new error to 409 API_ORDER_EXTERNAL_ID_CONFLICT. Manual codes unchanged.

Tests:
- Concurrent identical and conflicting requests; reordered JSON keys; credential rotation; fault injected after commit, before the response.
- Same key / external ID in two integrations (isolated); an API key string equal to a manual key.
- File import then API with the batch held, released and withdrawn: identical → duplicate=true and state untouched; differing extras or IMP-… order number → 409.
- Zero extra events, verifications, dispatches and credit holds in every replay and conflict case.
- accept-many spec, manual-order and E04.6 suites unchanged.
```

## US-05-04 — API abuse controls and safe operational errors

```text
Implement US-05-04 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-04-api-abuse-controls-and-audit.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: MVP protection only. Throttled or oversized requests never reach the ingestion command; every outcome is traceable through redacted logs. Do NOT build a request-log table, retention job, metrics or alerts (deferred in the README).

Read first: the ThrottlerModule setup in app.module.ts, OrderImportUploadThrottleGuard (the pattern to copy), main.ts body parsing, buildBackendLog, env-validation.ts.

Build:
1. An order-api throttle guard on the shared ThrottlerStorage, keyed order-api:<integrationId> plus order-api:global, env-configurable limits, 429 API_RATE_LIMITED with Retry-After, running before the adapter. Skip the app-wide IP throttler on this route as the import upload route does. In-memory storage is accepted for the single-instance pilot.
2. A route-scoped body limit for /api/v1 (env, default 32 KB) → 413 API_PAYLOAD_TOO_LARGE.
3. One error envelope {code, message, correlationId} for auth, validation, conflict, throttle and server errors; correlation ID header on every response.
4. One structured log line per request (integrationId, key prefix, correlationId, outcome code, duration, orderId?) with no secret, hash or PII; npm run log:check passes.
5. New env vars in env-validation.ts, .env.example and docs/ENVIRONMENT.md.
6. Frontend: last-used and revoked metadata in the API keys tab; localized errors.

Tests:
- Burst and concurrent load; rotated-key bypass attempt; oversized bodies; retry after throttling succeeds.
- Throttled and oversized requests never call StandaloneOrderIngestionService (no order, event or credit).
- Redaction across auth, validation, conflict and DB error paths.
```

## US-05-05 — Server integration guide

```text
Implement US-05-05 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-05-server-integration-guide.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: a developer integrates in minutes from the guide alone, and every documented behavior is proven by a test.

Read first: the implemented order-api DTO and error codes, the US-05-03 replay/conflict rules, akeed-frontend content/docs/en/bulk-order-import.md (structural model), content/docs/ar, and the (public)/docs/[slug] route.

Build:
1. akeed-frontend/content/docs/en/server-api.md (plus a short Arabic overview linking to it): quick start; fields including extras; externalOrderId semantics; accepted ≠ delivered; create-only; server-only secrets; one-source restriction.
2. An idempotency section for integrators: one key per order derived from their own order id; same key/same body → duplicate; same key/different body → 409 API_ORDER_IDEMPOTENCY_CONFLICT; new key for an existing order → duplicate if identical (strict, including extras and import-generated IMP-… numbers), else 409 API_ORDER_EXTERNAL_ID_CONFLICT; held or cancelled imports keep their state.
3. curl and HTTP examples with placeholders and synthetic data: success, duplicate replay, both 409s, non-COD accepted-not-sent, 413, 429 with Retry-After, invalid phone, unready source, credit denial, lost-response retry.
4. Troubleshooting by error code, effective limits, support process via correlation ID; link the dashboard lifecycle; no status or callback endpoint implied.
5. Examples kept in a fixture that a contract test runs against a test instance with a disposable key, asserting status and code.
6. A localized help link from Settings → API keys to the guide.
```

## US-05-06 — Cross-channel equivalence, isolation and recovery gate

```text
Execute US-05-06 from akeed-backend/docs/Epics/05-standalone-order-ingestion-api/US-05-06-api-security-and-recovery-release-gate.md.
Follow the shared rules in akeed-backend/docs/Epics/05-standalone-order-ingestion-api/IMPLEMENTATION-PROMPTS.md.

Goal: recorded evidence that adding the API left the ingestion architecture intact and that the API is safe to pilot. Verification story: fix only defects the gate uncovers, naming the owning story for each.

Do:
1. PRIMARY — equivalence: the same canonical order via manual, file import and API gives identical normalized order, fingerprint, verification, dispatch ledger, credit, follow-up and dashboard results.
2. Architecture: widen reuse-map.spec.ts CHANNELS to modules/order-api; extend ingestion-boundary and release-gate-architecture specs for order-api; assert nothing in verification-core, normalizers or eligibility strategies reads ingestionType.
3. Two-tenant suite: credentials, idempotency responses, external-ID replays, orders, usage and errors can't cross organizations.
4. Revocation: new requests fail at once; accepted orders stay auditable and follow source state.
5. Fault suite: concurrent duplicates, conflicting payloads, DB outage, lost response after commit; reconcile order, event, verification, dispatch and credit counts after each.
6. Run all documented examples (US-05-05); send one API order through a fake messaging port to a confirmed outcome on the dashboard.
7. Regression suites from the shared rules plus E01 Shopify gates and both-mode frontend checks; record every command and its counts.
8. Prepare, but don't execute, the authorized pilot with synthetic orders: checklist, support and recovery steps, rollback (disable new acceptance, keep history). Hand the live steps to me.

Close-out: set the story to "Implemented locally — release blocked (pilot pending)" unless I provide pilot results. Update the E05 README status column.
```
