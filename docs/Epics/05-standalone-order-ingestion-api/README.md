# E05 — Standalone Order Ingestion API

- **Horizon:** NEXT
- **Status:** Backlog
- **Stories:** 6
- **Prerequisite epics:** [E04.5 — Standalone Paymob Usage-Based Billing MVP](../04.5-standalone-paymob-usage-billing/README.md), [E04.6 — Standalone Bulk Order Import](../04.6-standalone-bulk-order-import/README.md)
- **Implementation prompts:** [one prompt per story](IMPLEMENTATION-PROMPTS.md)
- **Roadmap:** [Expansion backlog](../README.md)

## Business objective

Serve custom websites and delivery businesses through one secure server-to-server ingestion contract.

## Scope and boundaries

API-key lifecycle, POST /api/v1/orders, idempotency, abuse controls, documentation, and fault/isolation acceptance.

**Out of scope:** Browser SDK, bespoke delivery adapters, CSV automation, a batch/bulk API endpoint (merchant file import is E04.6), and generic outbound callbacks.

## Architecture — the API is one more channel adapter

E05 adds **no** ingestion path of its own. It follows the adapter boundary defined in [E04.6 — Architecture](../04.6-standalone-bulk-order-import/README.md#architecture--adapters-in-one-core-out):

```text
POST /api/v1/orders
  → IntegrationApiKeyGuard            (authenticates, resolves {orgId, integrationId, keyId})
  → abuse controls (US-05-04)         (throttle / size limits BEFORE any business work)
  → ApiOrderChannelAdapter            (request DTO → CanonicalOrderInput; nothing else)
  → StandaloneOrderIngestionService.acceptOne(ctx, input, {channel: 'api', idempotencyKey})
      ├─ StandaloneSourceResolver          (shared with manual + file import)
      ├─ StandaloneSendReadinessService    (shared gates and blocker codes)
      ├─ buildStandaloneOrderEnvelope / fingerprintCanonicalOrder
      ├─ ManualOrderIngestionRepository.acceptWithinTransaction  (shared transaction core)
      └─ dispatchById                      (API orders are never held)
  → webhook_events → standalone normalizer → OrderEligibilityService → VerificationHubService  (unchanged core)
```

## Approved product decisions

| Decision | Approved value |
| --- | --- |
| Ingestion command | `StandaloneOrderIngestionService.acceptOne` from E04.6. The API controller and adapter must not import the ingestion repository, the envelope builder, the dispatcher, credit services or `verification-core`. |
| Channel | `channel = 'api'` → `ingestionType = 'api'`, added to the shared `STANDALONE_INGESTION_CHANNELS` constant. It is audit and reporting metadata only. No normalizer, strategy, hub or send code may branch on it. |
| Order identity | The client's `externalOrderId` goes through the **same** reference normalizer as file-import order references, giving `ref:<normalized>`. An order imported by file and later posted by API (or the reverse) is therefore one order per source. |
| Idempotency key space | Keys are namespaced by the command per channel: API `api:<key>`, file import `import:<batchId>:<row>`, manual unchanged (backward compatible). A client key can never collide with a manual or import key. |
| Same order, new key | Handled once in the command. Existing `externalOrderId` with an identical canonical fingerprint → replay the original identifiers with `duplicate=true` and **no** new event (so no second message). A different fingerprint → 409 `API_ORDER_EXTERNAL_ID_CONFLICT`. |
| Gates and error codes | Readiness and credit blockers come from `StandaloneSendReadinessService` through an `API_*` code map. E04.5 credit denial codes are returned unchanged. |
| Hold | API orders are never held. The E04.6 hold primitive stays available but is unused by this epic. |

## Prioritized user stories

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-05-01 — Manage integration API keys securely](US-05-01-integration-api-key-lifecycle.md) | P0 | Feature | [US-04.5-08](../04.5-standalone-paymob-usage-billing/US-04.5-08-sandbox-and-production-release-gate.md) | Backlog |
| 2 | [US-05-02 — Accept orders through the Standalone ingestion API](US-05-02-authenticated-order-ingestion-endpoint.md) | P0 | Feature | [US-05-01](../05-standalone-order-ingestion-api/US-05-01-integration-api-key-lifecycle.md) | Backlog |
| 3 | [US-05-03 — Make API retries idempotent and conflict-safe](US-05-03-idempotency-and-conflict-handling.md) | P0 | Technical enabler | [US-05-02](../05-standalone-order-ingestion-api/US-05-02-authenticated-order-ingestion-endpoint.md) | Backlog |
| 4 | [US-05-04 — Add API abuse controls and safe operational errors](US-05-04-api-abuse-controls-and-audit.md) | P0 | Technical enabler | [US-05-03](../05-standalone-order-ingestion-api/US-05-03-idempotency-and-conflict-handling.md) | Backlog |
| 5 | [US-05-05 — Publish server-side integration guidance](US-05-05-server-integration-guide.md) | P1 | Feature | [US-05-04](../05-standalone-order-ingestion-api/US-05-04-api-abuse-controls-and-audit.md) | Backlog |
| 6 | [US-05-06 — Verify API tenant isolation and failure recovery](US-05-06-api-security-and-recovery-release-gate.md) | P0 | Quality gate | [US-05-05](../05-standalone-order-ingestion-api/US-05-05-server-integration-guide.md) | Backlog |

## Measurable exit criteria

- Valid clients can durably submit orders and safely retry lost responses.
- API, manual and file-imported orders with the same canonical data produce identical verification, credit, follow-up and dashboard behavior, all through `StandaloneOrderIngestionService`. This is proven by the equivalence and architecture checks in US-05-06.
- Keys, orders, idempotency results, usage, and errors cannot cross tenants.
- Revocation, throttling, conflicting replay, and outage recovery pass automated acceptance.
- Every story meets its acceptance criteria and the [shared Definition of Done](../README.md); unresolved platform validation blocks dependent release.

## Dependency and rollout notes

Follow story dependency order, make additive compatibility changes where needed, and preserve existing Shopify behavior. E04.6 must be implemented first, because it delivers the ingestion command, shared rules, source resolver, readiness service and envelope builder this epic reuses. If E05 is started before E04.6, those extractions (E04.6 US-04.6-01, -02, -04, -06 and -07 backend parts) must be done first under their E04.6 story IDs, not re-implemented here.
No calendar estimate or staffing commitment is implied by priority.

## Evidence discipline

The product sequence is approved; all implementation remains proposed. Story-level links distinguish code evidence from assumptions and external dependencies. Historical baseline results are dated 2026-08-30 and are not fresh test runs.

