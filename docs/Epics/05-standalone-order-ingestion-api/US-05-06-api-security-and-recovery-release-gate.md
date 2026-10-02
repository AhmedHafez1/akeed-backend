# US-05-06 — Prove cross-channel equivalence, isolation and recovery

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 6 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Backlog
- **Dependencies:** [US-05-05](US-05-05-server-integration-guide.md)

## User story and value

As a product owner, I want proof that adding the API left the ingestion architecture intact and that the API is safe to pilot, so that customers can trust it with real orders and credentials and the next channel (E08) can reuse the same boundary.

**Business value:** The gate answers "does adding the API leave the existing ingestion architecture intact?", not only "does the API work?".

## Scope

Cross-channel equivalence, architecture guards, tenant isolation, revocation, and fault recovery for E05. This is a verification story: fix only the defects the gate uncovers, and name the owning story for each.

**Out of scope:** Broad public rollout and bespoke client implementation.

## Acceptance criteria

1. **Primary — cross-channel equivalence.** The same canonical order submitted via manual, file import and API yields identical normalized order, fingerprint, verification, dispatch ledger, credit charge, follow-up and dashboard lifecycle. Only `ingestionType` and the channel's envelope extras differ.
2. **Architecture guards** (extend the existing specs, don't add parallel ones):
   - `reuse-map.spec.ts`: widen the `CHANNELS` scope to `modules/order-api/`; every reuse-map row still has exactly one implementation.
   - `ingestion-boundary.spec.ts` and `release-gate-architecture.spec.ts`: `modules/order-api/` reaches persistence, envelope and dispatch only through `StandaloneOrderIngestionService`, and imports nothing on the README's forbidden list.
   - Nothing in `verification-core`, the normalizers or the eligibility strategies reads `ingestionType` (today it is read only by the envelope, the ingestion service, the preview and the Standalone normalizer's channel check).
3. **Tenant isolation.** Two-tenant tests prove credentials, idempotency responses, external-ID replays, orders, usage and errors cannot cross organizations.
4. **Revocation.** New requests fail at once; previously accepted orders stay auditable and follow source state.
5. **Fault recovery.** Concurrent duplicates, conflicting payloads, a database outage and a lost response after commit recover without duplicate business effects. Order, event, verification, dispatch and credit counts are reconciled after each case.
6. **End to end.** Every documented example (US-05-05) passes, and one API order travels through a fake messaging port to a confirmed outcome visible on the dashboard.
7. **No regressions.** The E04 manual journey, the E04.6 bulk-import suite, the entitlement and credit suites, the E01 Shopify gates and both-mode frontend checks stay green.

## Implementation notes

- **Backend:** Compose guard, controller, repository and worker tests; inject failures at the persistence and queue boundaries. Throttling is in-memory for the pilot, so there is no Redis-outage case for it; the BullMQ queue outage is covered by the dispatch-failure path.
- **Frontend:** Verify the key lifecycle, localized errors and API-created order visibility in both themes and both locales.
- **Data:** Reconcile counts after each fault test.
- **Operations:** Prepare, but don't execute, the authorized pilot with synthetic orders: checklist, support and recovery steps, and rollback (disable new acceptance, keep history).

## Test requirements

- The API contract and security suite, the equivalence suite and the extended architecture specs.
- The regression suites listed in [the prompts' shared rules](IMPLEMENTATION-PROMPTS.md#shared-rules), with every command and its counts recorded.
- Satisfy the applicable [shared Definition of Done](../README.md).

## Migration and rollout

Close out as "Implemented locally — release blocked (pilot pending)" until pilot results are provided. E08 may reuse the common ingestion boundary only after this gate is complete.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):** The E04.6 architecture specs exist and are the ones to extend.

- [akeed-backend/src/modules/order-ingestion/reuse-map.spec.ts](../../../src/modules/order-ingestion/reuse-map.spec.ts)
- [akeed-backend/src/modules/order-ingestion/ingestion-boundary.spec.ts](../../../src/modules/order-ingestion/ingestion-boundary.spec.ts)
- [akeed-backend/src/modules/order-ingestion/release-gate-architecture.spec.ts](../../../src/modules/order-ingestion/release-gate-architecture.spec.ts)
- [akeed-backend/src/modules/order-ingestion/release-gate-traceability.spec.ts](../../../src/modules/order-ingestion/release-gate-traceability.spec.ts)
- [akeed-backend/src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts](../../../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts)
- [akeed-frontend/src/features/dashboard](../../../../akeed-frontend/src/features/dashboard)

**ASSUMPTION / REQUIRES VALIDATION:** The acceptance criteria describe approved proposed work, not completed functionality.

**EXTERNAL PLATFORM DEPENDENCY:** The pilot uses Meta through the existing E01/E04 gates; no new provider capability.
