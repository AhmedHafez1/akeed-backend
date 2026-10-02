# E05 — Standalone Order Ingestion API

- **Horizon:** NEXT
- **Status:** Backlog (stories refactored 2026-10-02 against the implemented E04 / E04.6 ingestion core)
- **Stories:** 6
- **Prerequisite epics (implemented):** [E04.5 — Standalone Paymob Usage-Based Billing MVP](../04.5-standalone-paymob-usage-billing/README.md), [E04.6 — Standalone Bulk Order Import](../04.6-standalone-bulk-order-import/README.md) (GA 2026-10-01)
- **Implementation prompts:** [one prompt per story](IMPLEMENTATION-PROMPTS.md)
- **Roadmap:** [Expansion backlog](../README.md)

> **Headline rule — E05 must not implement order business logic.**
> Manual orders, file imports, Shopify orders and API orders converge on the same canonical ingestion command and the same downstream verification pipeline. Any capability the API needs that the shared core lacks is added **to the core**, so manual and file import inherit it. The API module only authenticates, protects, translates and maps errors.

## Business objective

Expose Akeed's existing Standalone order-ingestion pipeline to server-side integrations (custom websites, EasyOrders-style storefronts, delivery back-ends) through a secure, idempotent API, without creating a second order-processing path.

## Scope and boundaries

Integration API keys, `POST /api/v1/orders`, API idempotency and conflict semantics (implemented in the shared core), MVP abuse controls, the integration guide, and the cross-channel equivalence and isolation gate.

**Out of scope:** Browser SDK, bespoke delivery adapters, CSV automation, a batch/bulk API endpoint (merchant file import is E04.6), order updates, generic outbound callbacks, and the post-pilot operations work listed under [Deferred](#deferred-post-pilot).

## Already implemented vs what E05 adds

E05 is a thin exposure layer. Most of what an order API needs already exists and is shared by the manual form and file import.

### Reuse — already implemented (E04 / E04.6)

| Capability | Where it lives |
| --- | --- |
| Canonical order contract | `CanonicalOrderInput`, `CANONICAL_ORDER_REQUIRED_FIELDS`, `STANDALONE_INGESTION_CHANNELS` in [`shared/commerce/standalone-order-envelope.ts`](../../../src/shared/commerce/standalone-order-envelope.ts) |
| Envelope and fingerprint | `buildStandaloneOrderEnvelope`, `fingerprintCanonicalOrder` (same file; only the ingestion module may call them) |
| Field rules | [`shared/commerce/canonical-order.rules.ts`](../../../src/shared/commerce/canonical-order.rules.ts) (limits, `CANONICAL_TOTAL_PRICE_PATTERN`, `CANONICAL_ORDER_CURRENCIES`, currency/payment normalizers) |
| Phone normalization | `PhoneService.standardize` ([`shared/services/phone.service.ts`](../../../src/shared/services/phone.service.ts)) |
| Idempotency-Key validation | `normalizeIdempotencyKey` + `IDEMPOTENCY_KEY_PATTERN` ([`shared/validation/idempotency-key.ts`](../../../src/shared/validation/idempotency-key.ts)) |
| Key namespacing and order reference identity | `namespaceIdempotencyKey`, `normalizeOrderReference` (`ref:<normalized>`) in [`standalone-ingestion-keys.ts`](../../../src/modules/order-ingestion/standalone-ingestion-keys.ts) |
| Ingestion command | `StandaloneOrderIngestionService.acceptOne` / `acceptMany` ([service](../../../src/modules/order-ingestion/standalone-order-ingestion.service.ts)) |
| Transactional acceptance, event-key replay, fingerprint conflict, persistence check | `ManualOrderIngestionRepository.acceptWithinTransaction` / `assertPersisted` ([repository](../../../src/infrastructure/database/repositories/manual-order-ingestion.repository.ts)) |
| Channel-neutral ingestion errors | `StandaloneIngestionConflictError`, `…AcceptanceError`, `…DispatchError` ([errors](../../../src/modules/order-ingestion/standalone-order-ingestion.errors.ts)) |
| Source resolution | `StandaloneSourceResolver` + per-channel `StandaloneSourceCodeMap` ([resolver](../../../src/modules/order-ingestion/standalone-source-resolver.ts)) |
| Readiness and credit gates | `StandaloneSendReadinessService` → channel-neutral `SendReadinessBlocker` ([types](../../../src/modules/order-ingestion/standalone-send-readiness.types.ts)) |
| Per-principal throttle pattern | `OrderImportUploadThrottleGuard` ([guard](../../../src/modules/order-imports/guards/order-import-upload-throttle.guard.ts)) |
| Architecture guards | [`ingestion-boundary.spec.ts`](../../../src/modules/order-ingestion/ingestion-boundary.spec.ts), [`release-gate-architecture.spec.ts`](../../../src/modules/order-ingestion/release-gate-architecture.spec.ts), [`reuse-map.spec.ts`](../../../src/modules/order-ingestion/reuse-map.spec.ts) |
| Verification, credits, dispatch, follow-up, dashboard | Unchanged downstream core (`webhook_events` → Standalone normalizer → `OrderEligibilityService` → `VerificationHubService`) |

### E05 adds — API-only code (`src/modules/order-api/`, `integration-keys`)

- Integration API keys: storage, issuance, listing, revocation, settings UI (US-05-01).
- `IntegrationApiKeyGuard` (US-05-01).
- The versioned controller, request DTO and `ApiOrderChannelAdapter` (DTO → `CanonicalOrderInput`, ingestion errors → `API_*` codes) (US-05-02, US-05-03).
- `API_*` source, readiness and conflict code maps (US-05-02, US-05-03).
- Throttle, body-size limit, error envelope and correlation ID (US-05-04).
- The server integration guide (US-05-05) and the release gate (US-05-06).

### Core gaps E05 closes — in the core, not the API module

The code review on 2026-10-02 found three things the API needs that the shared core does not yet provide. Each is built in `src/modules/order-ingestion/` (or its repository) and proven against the manual and file-import suites:

| Gap (current behavior) | Fix | Story |
| --- | --- | --- |
| Source resolution, readiness evaluation and blocker → code mapping run in the **manual channel** (`OrdersService.createManualOrder` / `assertManualCreateReady`), not in the command. An API would have to copy them. | Extract a shared pre-accept gate: `StandaloneSendReadinessService` blockers mapped through a per-channel readiness code map, and a `StandaloneOrderIngestionService.submitOne` that composes resolve → readiness → `acceptOne`. Manual moves onto it with byte-identical responses. | US-05-02 |
| `StandaloneSourceResolver.resolveWritable` needs a session user with a role; nothing resolves a source from an integration-bound credential. | Add `resolveForIntegration(orgId, integrationId, codes)` applying the same active / Standalone / onboarding-completed / single-active-source checks. | US-05-02 |
| A new key whose order identity already exists throws `ManualOrderAcceptanceStateError` on the non-held path (→ 503, retried forever); a duplicate always re-dispatches, which fails for an order owned by a held or withdrawn import event. | Add the external-ID replay / conflict branch once in `acceptWithinTransaction`; external-ID replays never dispatch. `acceptMany` keeps `already_imported`. | US-05-03 |

## Architecture — the API is one more channel adapter

```text
             Manual form            File import (CSV/XLSX)          Server API (E05)
                  │                          │                            │
      DualAuthGuard (session)      DualAuthGuard (session)     IntegrationApiKeyGuard → {orgId, integrationId, keyId, prefix}
                  │                          │                 throttle + body limit (US-05-04)  ← before any business work
   ManualOrderChannelAdapter      FileImportChannelAdapter        ApiOrderChannelAdapter (DTO → CanonicalOrderInput)
                  │                          │                            │
                  └──────────── StandaloneOrderIngestionService ──────────┘
                                 ├─ submitOne (new, US-05-02):  resolve source → readiness gate (per-channel code map) → acceptOne
                                 ├─ acceptOne / acceptMany:      envelope + fingerprint → acceptWithinTransaction → dispatchById
                                 └─ acceptWithinTransaction:     event-key replay/conflict · external-ID replay/conflict (US-05-03)
                                                   │
                webhook_events → Standalone normalizer → OrderEligibilityService → VerificationHubService   (unchanged)
```

Dependency picture:

```text
E04.5 Billing ─┐
E04 Manual ────┼──► Standalone ingestion core ──► E05 Server API ──► (E08 may reuse the boundary after US-05-06)
E04.6 Import ──┘
```

## Approved product decisions

| Decision | Approved value |
| --- | --- |
| Ingestion command | The API controller calls `StandaloneOrderIngestionService.submitOne` (which ends in `acceptOne`). The `order-api` module must not import the acceptance repository, `WebhookEventsRepository`, `WebhookDispatchService`, credit or entitlement services, the envelope builder, `PhoneNumberUtil`, or anything in `verification-core`, and must not declare its own limits, regexes or currency lists. |
| Authentication context | The key guard yields a principal `{orgId, integrationId, keyId, prefix}`. `resolveForIntegration` turns it into the existing `StandaloneIngestionContext` `{orgId, source}`, the same type the session path produces. `keyId`/`prefix` are log metadata only; the command never learns which authentication was used. |
| Channel | `channel = 'api'` → `ingestionType = 'api'`, appended to `STANDALONE_INGESTION_CHANNELS`, `IDEMPOTENCY_KEY_PREFIX` (`'api:'`) and the service's log-action map. Audit and reporting metadata only; no normalizer, strategy, hub or send code may branch on it. |
| Request fields | Required: `externalOrderId`, `customerName`, `customerPhone`, `totalPrice` (decimal string), `currency`, `paymentMethod`. Optional: `orderNumber` (defaults to `externalOrderId` as written), and the same extras as file import — `orderDate`, `city`, `address`, `notes`. Rules come from `canonical-order.rules.ts`; phone from `PhoneService.standardize`. |
| Order identity | `externalOrderId` goes through `normalizeOrderReference` → `ref:<normalized>`, the same identity file import uses. An order imported by file and later posted by API (or the reverse) is one order per source. |
| Idempotency key space | Namespaced by the command per channel: API `api:<key>`, file import `import:<batchId>:<row>`, manual unprefixed (backward compatible). Scoped to the source (`storeDomain`), not to the credential, so it survives key rotation. |
| Same key, different content | Existing behavior: 409. API code `API_ORDER_IDEMPOTENCY_CONFLICT`; manual keeps `MANUAL_ORDER_IDEMPOTENCY_CONFLICT`. |
| Same order, new key | Compared with the **existing strict canonical fingerprint** (no second hashing rule). Equal → replay original identifiers, `duplicate=true`, no new event, no dispatch, no credit hold. Different (including extras or an import-generated `IMP-…` order number) → 409 `API_ORDER_EXTERNAL_ID_CONFLICT`. |
| Existing order is held or withdrawn | An external-ID replay **never dispatches**. An order owned by a held import batch stays held until the merchant starts it; a withdrawn one stays withdrawn. The response is the normal `duplicate=true`; the dashboard is the source of truth. |
| Gates and error codes | Source and readiness blockers come from `StandaloneSourceResolver` and `StandaloneSendReadinessService` through `API_*` code maps (`API_SOURCE_UNAVAILABLE`, `API_SETUP_INCOMPLETE`, `API_AUTO_VERIFY_DISABLED`, `API_ENTITLEMENT_REQUIRED`, `API_PLAN_LIMIT_REACHED`, `API_VALIDATION_FAILED`). E04.5 credit denial codes are returned unchanged. |
| Hold | API orders are never held. The E04.6 hold primitive stays available but unused by this epic. |
| Rate-limit storage | MVP reuses the in-memory `ThrottlerStorage` pattern of `OrderImportUploadThrottleGuard`, keyed by `integrationId` plus a global key. Valid while the API runs as one backend instance; a Redis storage is required before scaling out (see Deferred). |

## Prioritized user stories

Delivery rank is the execution order. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-05-01 — Manage integration API keys securely](US-05-01-integration-api-key-lifecycle.md) | P0 | Feature | E04.5, E04.6 (implemented) | Implemented locally (release blocked) |
| 2 | [US-05-02 — Submit API orders to the existing ingestion command](US-05-02-authenticated-order-ingestion-endpoint.md) | P0 | Feature + core extraction | [US-05-01](US-05-01-integration-api-key-lifecycle.md) | Implemented locally (release blocked) |
| 3 | [US-05-03 — Extend shared idempotency to external order identity](US-05-03-idempotency-and-conflict-handling.md) | P0 | Technical enabler (core) | [US-05-02](US-05-02-authenticated-order-ingestion-endpoint.md) | Implemented locally (release blocked) |
| 4 | [US-05-04 — Add API abuse controls and safe operational errors](US-05-04-api-abuse-controls-and-audit.md) | P0 | Technical enabler | [US-05-03](US-05-03-idempotency-and-conflict-handling.md) | Backlog |
| 5 | [US-05-05 — Publish server-side integration guidance](US-05-05-server-integration-guide.md) | P1 | Feature | [US-05-04](US-05-04-api-abuse-controls-and-audit.md) | Backlog |
| 6 | [US-05-06 — Prove cross-channel equivalence, isolation and recovery](US-05-06-api-security-and-recovery-release-gate.md) | P0 | Quality gate | [US-05-05](US-05-05-server-integration-guide.md) | Backlog |

## Measurable exit criteria

1. **Primary — cross-channel equivalence.** The same canonical order via manual, file import and API produces identical normalized order, fingerprint, verification, credit, dispatch ledger, follow-up and dashboard behavior, all through `StandaloneOrderIngestionService`, and the architecture specs prove the API module contains no order business logic (US-05-06).
2. Valid clients can durably submit orders and safely retry lost responses; an existing external order is replayed or rejected, never duplicated.
3. Keys, orders, idempotency results, usage and errors cannot cross tenants.
4. Revocation, throttling, conflicting replay and database-outage recovery pass automated acceptance.
5. The manual-order, file-import, entitlement, credit and Shopify suites are unchanged before and after every story.
6. Every story meets its acceptance criteria and the [shared Definition of Done](../README.md).

## Deferred (post-pilot)

Deliberately out of the MVP, matching the minimal-operations approach taken for E04.6 US-04.6-09:

- A persistent `api_request_log` table, its retention policy and purge job (the MVP audit trail is the structured, redacted logs).
- Metrics dashboards and alerts (sustained 5xx rate, per-source 429 spikes, acceptance latency, queue age).
- A tenant-facing correlation-ID lookup endpoint.
- Redis-backed throttler storage (required before running more than one API instance).
- Key scopes, multiple keys per purpose, and status or callback endpoints.

## Dependency and rollout notes

Follow story dependency order and preserve existing Shopify, manual and file-import behavior. Core extractions (US-05-02, US-05-03) land before any API-only code in the same story and must keep the manual and import response bodies and codes byte-identical. No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all E05 implementation remains proposed. The "Core gaps" table and the code references in each story were verified against the `develop` branch on 2026-10-02 and are not test runs.
