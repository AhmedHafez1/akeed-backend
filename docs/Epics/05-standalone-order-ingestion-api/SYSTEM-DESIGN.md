# E05 — Standalone Order Ingestion API: system design

- **Status:** Design for US-05-02 to US-05-06. US-05-01 (keys and guard) is implemented locally; see its [evidence](../../US-05-01-INTEGRATION-API-KEY-LIFECYCLE-EVIDENCE.md).
- **Date:** 2026-10-02
- **Inputs:** [E05 README](README.md), the six stories, [implementation prompts](IMPLEMENTATION-PROMPTS.md), and the code on `develop`.
- **Audience:** engineers implementing or reviewing E05.

This document does not re-decide what the README's *Approved product decisions* already settle. It shows how those decisions fit together as one system, how much load they carry, how they fail, and what has to change before the API grows past the pilot.

---

## 1. Requirements

### Functional

1. A merchant's server submits one order at a time with `POST /api/v1/orders`, authenticated by an integration API key (US-05-01).
2. The order goes through the **same** ingestion command as manual orders and file import (`StandaloneOrderIngestionService`). It then follows the unchanged pipeline: event, Standalone normalizer, eligibility, verification, WhatsApp send, outcome.
3. Retries are safe:
   - The same `Idempotency-Key` returns the original result.
   - A new key for an order Akeed already has (same `externalOrderId`) is replayed if identical and rejected if it differs.
4. A throttled, oversized or unauthenticated request never reaches the command.
5. Every request can be traced from one correlation ID through redacted logs.

### Non-functional

| Property | Target (pilot) | Why |
| --- | --- | --- |
| Correctness | Zero duplicate orders, zero duplicate sends, zero cross-tenant effects | Each duplicate is a real WhatsApp message to a real customer and a billed credit. |
| Acceptance latency | p95 < 500 ms server time | The work is about 10 indexed queries and one Redis enqueue. The sender's own timeout is the real budget. |
| Availability | Same as the API process (single instance) | No new infrastructure in the pilot. |
| Durability | An answered `accepted` is never lost | The order and event are committed before the response; dispatch can be recovered. |
| Security | Server-only secrets, immediate revocation, uniform auth errors | Keys reach merchant servers we don't control. |

### Constraints

- One NestJS backend instance, Supabase Postgres (through the pooler), and Redis for BullMQ. No new datastore.
- **Headline rule:** the API module holds no order business logic. Any missing capability is added to the shared core so manual and import inherit it.
- Hand-written forward-only migrations. CRLF files. Stable error codes (the frontend and integrators switch on them).

### Assumptions (validate before GA)

- About 10 pilot merchants, each up to about 2,000 API orders a day, with bursts of up to 5 orders a second per merchant (flash sales, back-office batch syncs).
- Integrators send orders as they are created, not as nightly bulk dumps; bulk stays on file import (E04.6).
- Messaging throughput (Meta tier, quality rating) and credits limit the system long before ingestion does.

---

## 2. High-level design

```text
 Merchant server
     │  HTTPS  POST /api/v1/orders
     │  Authorization: Bearer ak_live_…   Idempotency-Key: …   X-Correlation-Id?: …
     ▼
┌──────────────────────────── akeed-backend (one instance) ───────────────────────────┐
│                                                                                     │
│  ① Correlation-ID middleware ─ echo safe client ID or generate; set response header │
│  ② Route body limit (32 KB) ─ 413 API_PAYLOAD_TOO_LARGE                    US-05-04 │
│  ③ IntegrationApiKeyGuard ─ Bearer only, prefix lookup, timing-safe hash,  US-05-01 │
│        uniform 401 API_KEY_INVALID → principal {orgId, integrationId, keyId, prefix} │
│  ④ OrderApiThrottleGuard ─ order-api:<integrationId> + order-api:global    US-05-04 │
│        429 API_RATE_LIMITED + Retry-After        (app-wide IP throttler skipped)    │
│  ⑤ Route ValidationPipe ─ CreateApiOrderDto, unknown fields rejected,      US-05-02 │
│        400 API_VALIDATION_FAILED {fieldErrors}                                       │
│  ⑥ OrderApiController ─ one call, no branching                                       │
│        └─ ApiOrderChannelAdapter.toCanonicalOrderInput (phone via PhoneService,      │
│           externalOrderId → ref:<normalized>, orderNumber default)                   │
│  ─────────────────────────────── shared core (order-ingestion) ──────────────────── │
│  ⑦ StandaloneOrderIngestionService.submitOne(principal, input, opts)       US-05-02 │
│        a. StandaloneSourceResolver.resolveForIntegration(orgId, integrationId)       │
│        b. StandaloneSendReadinessService.evaluate(source, {required: 1})             │
│        c. shared gate: blockers → channel code map (API_* codes)                     │
│        d. acceptOne(ctx, input, {channel:'api', idempotencyKey})                     │
│              envelope + fingerprint → acceptWithinTransaction                        │
│                ├ event-key replay / conflict              (exists today)             │
│                └ external-ID replay / conflict            (US-05-03)                 │
│              → dispatchById(eventId)   (skipped on an external-ID replay)            │
│  ⑧ ApiOrderChannelAdapter.rethrowAsHttp ─ StandaloneIngestion*Error → API_* codes    │
│  ⑨ Error envelope filter (api/v1 only) ─ {code, message, correlationId}    US-05-04 │
│  ⑩ One structured log line per request (integrationId, prefix, outcome, ms, orderId)│
└───────────────┬─────────────────────────────────────────────┬───────────────────────┘
                │ one transaction                             │ enqueue
                ▼                                             ▼
        Postgres: orders, webhook_events,             Redis/BullMQ: webhook-processing
        integration_api_keys                                  │
                                                              ▼
                        Standalone normalizer → OrderEligibilityService → VerificationHub
                        → credits / entitlement → WhatsApp send → outcome   (unchanged)
```

**Ordering rule:** everything that can refuse a request cheaply (②–⑤) runs before anything that reads billing state or writes rows (⑦). Each step only narrows; none widens what a later step may do.

### Component ownership

| Component | Module | Story | Notes |
| --- | --- | --- | --- |
| Key storage, management, guard | `modules/integration-keys` | 05-01 (done) | Exports `IntegrationApiKeyGuard`. |
| `resolveForIntegration`, readiness gate, `submitOne` | `modules/order-ingestion` | 05-02 Part A | Core: manual moves onto `submitOne` with byte-identical responses. |
| Controller, DTO, channel adapter, `API_*` maps | `modules/order-api` | 05-02 Part B | Forbidden-import list enforced by the architecture specs. |
| External-ID replay/conflict | `manual-order-ingestion.repository` + service | 05-03 | Core only; the adapter just maps the new error. |
| Throttle, body limit, envelope, correlation ID | `modules/order-api` (+ middleware) | 05-04 | |
| Guide and its tested examples | `akeed-frontend/content/docs` + contract fixture | 05-05 | |
| Equivalence / isolation / recovery gate | specs + `scripts/test-e05-release-gate.ps1` | 05-06 | |

---

## 3. API contract

### Request

```http
POST /api/v1/orders
Authorization: Bearer ak_live_ab12cd34_<43 chars>
Idempotency-Key: order-10023            # required; normalizeIdempotencyKey rules
X-Correlation-Id: 7c1e…                 # optional; echoed only if it matches the safe pattern
Content-Type: application/json

{
  "externalOrderId": "10023",           # required; identity → ref:<normalized>
  "customerName": "Mona Ali",           # required
  "customerPhone": "+201001234567",     # required; PhoneService.standardize
  "totalPrice": "450.00",               # required; CANONICAL_TOTAL_PRICE_PATTERN
  "currency": "EGP",                    # required; CANONICAL_ORDER_CURRENCIES
  "paymentMethod": "cod",               # required; the shared normalizer
  "orderNumber": "#10023",              # optional; defaults to externalOrderId as written
  "orderDate": "2026-10-02", "city": "…", "address": "…", "notes": "…"   # optional extras
}
```

Unknown fields are a 400. `orgId`, `integrationId` and `platform` can't be supplied at all; the tenant comes from the key.

### Responses

| Situation | Status | Body |
| --- | --- | --- |
| New order accepted and dispatched | 202 | `{orderId, verificationId?, status:'accepted', duplicate:false}` |
| Same key, same body (lost response) | 202 | the original identifiers, `duplicate:true` (the §4.6 core fix, landed in US-05-03) |
| New key, identical existing order | 202 | the original identifiers, `duplicate:true`, **no dispatch** |
| Known non-COD | 202 | accepted and visible on the dashboard, never sent (same as manual) |
| Validation / bad key / throttled / too large | 400 / 401 / 429 / 413 | the envelope |
| Unready source, entitlement, credit | 409 / 403 | `API_*` source/readiness codes; E04.5 credit codes unchanged |
| Same key, different body | 409 | `API_ORDER_IDEMPOTENCY_CONFLICT` |
| New key, differing existing order | 409 | `API_ORDER_EXTERNAL_ID_CONFLICT` |
| DB failure before commit | 503 | `API_ORDER_ACCEPTANCE_FAILED`: retry the same key |
| Committed, enqueue failed | 503 | `API_ORDER_DISPATCH_FAILED`: retry the same key; the reconciler also recovers it |

**Recommendation:** answer 202 for both new and duplicate results, as the manual channel does. `accepted` means durably stored, not sent. Telling replays apart by status code would push clients into special-casing that `duplicate` already covers.

**Envelope (US-05-04):** `{ "code": "API_…", "message": "<developer text>", "correlationId": "…" }`, plus `fieldErrors` on validation and `Retry-After` on 429. The message never contains SQL, stack traces or another tenant's identifiers.

---

## 4. Deep dive

### 4.1 Data model

No new tables beyond US-05-01.

| Table | Role in E05 | Growth |
| --- | --- | --- |
| `integration_api_keys` | credentials; `prefix` unique, `key_hash` SHA-256, `last_used_at` written at most once a minute | at most 5 active per integration; revoked rows accumulate slowly |
| `orders` | `(integration_id, external_order_id)` unique: the **order identity** shared by every channel | one row per order |
| `webhook_events` | `(platform, store_domain, idempotency_key)` unique: the **request identity**, namespaced `api:<key>` | one row per accepted request; replays add none (US-05-03) |

Two identities, two jobs:

- **Event key (request identity).** Is this the same request again? Scoped to the source, so it survives key rotation.
- **External ID (order identity).** Is this the same order again, whichever channel or key sent it? Compared by the existing **strict canonical fingerprint**.

### 4.2 Idempotency decision table (core, `acceptWithinTransaction`)

| Event key exists? | Order identity exists? | Fingerprint | Result |
| --- | --- | --- | --- |
| no | no | — | insert event and order → dispatch |
| yes | (its order) | equal | replay `duplicate:true` → re-dispatch own event; `not_claimed` on an event that is already dispatched is success (§4.6) |
| yes | — | different | `StandaloneIngestionConflictError` → 409 IDEMPOTENCY |
| no | yes (non-held path) | equal | **external-ID replay**: roll back the new event, `duplicate:true`, **no dispatch** (US-05-03) |
| no | yes | different | `StandaloneIngestionExternalIdConflictError` → 409 EXTERNAL_ID (US-05-03) |

Concurrency comes from the two unique indexes inside one transaction, not from application locks. Two identical concurrent requests produce one winner; the loser lands in the replay row of this table. Tested in US-05-03 and US-05-06.

### 4.3 Authentication (US-05-01, built)

- **SHA-256, not bcrypt or argon2.** The secret is 256 random bits, so offline brute force is impossible whatever the hash speed, and a fast hash keeps the per-request cost to microseconds. Slow hashes protect low-entropy passwords, which keys are not.
- **Prefix lookup.** An index seek on a unique, non-secret prefix, then one timing-safe comparison. An unknown prefix still runs a comparison.
- **Immediate revocation.** The guard re-reads the row on every request. Nothing is cached (see §6 before adding a cache).
- **Bound to an integration, not an org.** If the merchant replaces their source, `resolveForIntegration` rejects the old integration's keys with no extra work.

### 4.4 Readiness and gating (US-05-02 Part A)

`submitOne` = resolve → `evaluate(source, {required: 1})` → gate → `acceptOne`. The gate maps the first blocker with today's precedence:

```text
entitlement → auto-verify → credit (E04.5 codes as-is) → slot / plan limit → fail closed
```

This check is **advisory**. The send path's transactional credit and slot reservation is the source of truth. An order accepted under a race, where credits ran out between the check and the send, is still stored and fails at send exactly as a manual order would. The API adds no second credit check.

### 4.5 Error handling and retries (client's view)

```text
5xx or timeout → retry the SAME Idempotency-Key with backoff (it's always safe)
409 *_CONFLICT → don't retry: the client sent different content for the same key or order
429            → wait Retry-After, then retry the same key
401            → stop; the key is wrong or revoked
```

### 4.6 Queue and recovery

- Dispatch reuses `WebhookDispatchService.dispatchById` and the existing `webhook-dispatch-reconciler` sweep. If Redis is down after commit, the client gets a 503 and the event stays `dispatch_required`. Either the client's retry or the sweep enqueues it. No E05-specific job exists.
- An external-ID replay never dispatches. That is what keeps a held import order held and a withdrawn one withdrawn (US-05-03).

**Core gap found while writing this design — fixed in US-05-03 (2026-10-02).** `dispatchById` is unchanged (other callers and the Shopify contract suite pin `'not_claimed'`). On `'not_claimed'`, `acceptOne` asks the new `WebhookDispatchService.isAlreadyDispatched(eventId)`: true when the event is queued, processing, finished, or under another caller's live dispatch lease, and that is answered as success. An event still in back-off, an unreadable event and `'failed'` keep the 503. The contract test is in `test/order-api-idempotency.contract-spec.ts`. The original finding is kept below for the record.

- **Where:** `StandaloneOrderIngestionService.acceptOne` calls `dispatchById` for every non-held acceptance, duplicates included, and throws `StandaloneIngestionDispatchError` for any outcome other than `'dispatched'`. `WebhookEventsRepository.claimForDispatch` only claims an event that is still recoverable:
  - `pending` and never dispatched, or
  - `processing` with an expired lease, or
  - dispatched longer ago than `WEBHOOK_PROCESSING_STALE_MS` (10 min by default).
- **What happens:** a same-key retry that arrives after the first request's dispatch succeeded returns `not_claimed`, so the client gets 503 `*_DISPATCH_FAILED`. That covers the classic lost response: the client times out, then retries seconds later. The retry is permanent: every further retry gets the same 503 until the event becomes stale.
- **Why the tests miss it:** the manual unit test for replay mocks `dispatchById` as `'dispatched'`, and the contract suite checks the repository replay, not the service's dispatch afterwards.
- **Fix (core, so manual and import inherit it):** on `acceptance.duplicate`, call `dispatchById`. If the outcome is `'not_claimed'`, treat it as success when the event is already dispatched or processed: read its state with one query, or have the claim report `already_dispatched`. Keep 503 only for `'failed'`, and for `'not_claimed'` on an event that is still `dispatch_required` and undispatched.
- **Where it lands:** in US-05-02 Part A beside `submitOne`, or at the start of US-05-03 (which owns replay semantics), with a contract test: accept, process, replay the same key, expect `duplicate:true` with 202 and no second job.
- **Manual's response for this case changes from 503 to the correct 202.** That is the one intended byte change, and it needs a new expectation in `orders.service.spec.ts`.

---

## 5. Scale and reliability

### 5.1 Load estimate (pilot assumptions above)

| Quantity | Estimate |
| --- | --- |
| Daily API orders | 10 × 2,000 = 20,000 / day ≈ 0.25 req/s average |
| Peak | 10 merchants × 5 req/s ≈ 50 req/s for short bursts (the throttle bounds it; see 5.2) |
| DB work per request | about 10 indexed queries: 1 key lookup, 0–1 `last_used_at` writes, 1 resolve, about 3–5 readiness reads, a 1-transaction accept of about 4 statements, 1 verification read |
| DB load at peak | about 500 simple queries/s for seconds at a time: comfortable for Supabase through the pooler, but see the pool-size note |
| `last_used_at` writes | at most active keys × 1/min ≤ 50 × 1/min: negligible |
| Storage | about 2 rows (order + event) per order; the replays US-05-03 removes would otherwise have been the main source of growth |
| **Real bottleneck** | WhatsApp sending (Meta tier, quality) and merchant credits, downstream of the queue; ingestion is not the constraint |

### 5.2 Throttling (US-05-04)

| Key | Proposed default (env) | Purpose |
| --- | --- | --- |
| `order-api:<integrationId>` | 120 / min | one merchant can't monopolize the instance; per integration, not per key, so rotating keys can't bypass it |
| `order-api:global` | 1,200 / min | protects the single instance and the DB pool from the sum of all merchants |

Limits are validated at boot. Per-plan tiers are a later concern. The app-wide IP throttler is skipped on this route, because merchant servers sit behind shared egress IPs.

### 5.3 Failure modes

| Failure | Client sees | State | Recovery |
| --- | --- | --- | --- |
| DB unavailable before commit | 503 ACCEPTANCE_FAILED | nothing written | client retries same key |
| Commit OK, response lost | timeout | order + event committed | retry same key → `duplicate:true` |
| Commit OK, Redis down | 503 DISPATCH_FAILED | event `dispatch_required` | retry or reconciler sweep; never a second order |
| Key revoked mid-request | request authenticated before the revoke commit completes | order accepted (correct: it was authorized) | none; the next request gets 401 |
| Source disabled mid-request | 409 if resolve ran after, else accepted | accepted orders follow source state | dashboard |
| Process restart | in-flight requests fail | throttle counters reset (in-memory) | client retries; brief over-allowance accepted for the pilot |
| Duplicate burst (client bug) | one 202, the rest 202 `duplicate:true` | one order | — |

### 5.4 Observability (pilot)

- One `buildBackendLog` line per request: `integrationId`, `keyPrefix`, `correlationId`, `outcome`/`code`, `durationMs`, `orderId?`. It carries no key, hash, phone, name or payload.
- Support triage: the merchant sends the correlation ID, and staff filter the logs on it.
- **Not built in the pilot (deferred):** a request-log table, metrics and alerts, a tenant-facing correlation lookup. The README accepts that trade-off.

---

## 6. Trade-offs

| Decision | Chosen | Alternative | Why this way, and the cost |
| --- | --- | --- | --- |
| Where API logic lives | Thin adapter on the shared core | Separate API ingestion path | One set of rules for three channels, so equivalence is provable (US-05-06). Cost: core extractions (`submitOne`, external-ID branch) must keep manual responses byte-identical, which makes US-05-02/03 slower to land. |
| Dispatch timing | Inline after commit (as manual) | Accept-only 202, dispatch from a sweep | Lowest time-to-message and identical to manual. Cost: a Redis outage shows as 503 even though the order is safe (mitigated: retry is idempotent, the sweep recovers). |
| `Idempotency-Key` | Required | Optional | Forces integrators into safe retries from day one. Cost: slightly more onboarding friction; external-ID replay catches clients that rotate keys. |
| Replay of an existing order | Strict fingerprint; differing → 409 | Last-write-wins update | Create-only keeps verification state sane (no editing an order mid-confirmation). Cost: clients must not resend "corrected" orders; the guide must say so loudly. |
| Hash function | SHA-256 | argon2 / bcrypt | High-entropy secrets make slow hashing pointless; the fast hash keeps auth cheap. |
| Key lookup | DB every request | In-process cache | Revocation is immediate and there is no invalidation protocol. Cost: one indexed query per request, negligible at pilot scale. |
| Throttle storage | In-memory | Redis | No new moving part; right for one instance. **Wrong as soon as there are two** (limits multiply by N). |
| Audit trail | Structured logs | `api_request_log` table | Zero schema or retention work. Cost: no tenant self-service lookup; log retention defines how far back support can trace. |
| Issuance gate | None (US-05-01 decision) | Env switch + allow-list | Less code. Cost: `develop` must not ship to production before US-05-04; this is a process risk, not enforced by code. |

---

## 7. What to revisit as it grows

In order of when it will bite:

1. **Before a second backend instance:**
   - Redis throttler storage (`@nest-lab/throttler-storage-redis` on the existing Redis), otherwise limits multiply.
   - Confirm `poolMax` × instances stays within the Supabase pooler limit.
2. **When support volume grows:**
   - `api_request_log` (correlation ID, integration, code, latency; no PII) with a retention job and a tenant-scoped lookup endpoint.
   - Metrics and alerts: 5xx rate, 429 spikes per source, acceptance p95, queue age.
3. **When integrators ask for status:**
   - A read endpoint `GET /api/v1/orders/:externalOrderId`, or outbound webhooks for confirmation outcomes, signed with a per-integration secret.
   - Today the dashboard is the only source of truth, and "accepted" is all the API can say.
4. **When request volume makes the key lookup visible:**
   - A short-TTL (5–10 s) positive cache keyed by prefix, with revocation published over Redis pub/sub so it stays immediate.
   - Don't add a TTL-only cache; it makes revocation eventual.
5. **Plan-based limits:**
   - Per-plan throttle tiers and per-key scopes (deferred in the README).
   - A batch endpoint only if file import can't serve the use case.
6. **Data growth:**
   - `webhook_events` is the largest table. Partitioning or archiving it is an E01-wide concern, not E05's, but API volume speeds it up.

---

## 8. Open questions

0. **Same-key replay after dispatch (§4.6).** Resolved in US-05-03: fixed in the core, so manual and the API both answer 202 `duplicate:true` on a lost-response retry.
1. **Sandbox for integrators.** Today, testing an integration against production sends real WhatsApp messages and uses credits. Options:
   - (a) `ak_test_` keys that validate and resolve but never accept or dispatch (a dry-run 200 echoing the canonical order);
   - (b) a documented "use a non-COD paymentMethod to test" workaround;
   - (c) a separate staging environment.
   - **Recommended: (a).** It is small (the guard already parses the label; the controller branches before `submitOne`) and removes the biggest onboarding risk. It needs a product decision and a story.
2. **Default limits.** Confirm 120/min per integration and 1,200/min global, or derive them from the Meta tier of the shared sender.
3. **202 vs 201.** Confirm 202 for all accepted results, matching manual.
4. **Pilot gate.** US-05-01 shipped without an issuance switch. If the release order can't be guaranteed, add a `STANDALONE_ORDER_API_ENABLED` switch and allow-list (the bulk-import pattern) in US-05-04. It is about 1 hour of work.
