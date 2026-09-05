# US-01-02 — Characterize Shopify webhook security and duplicates

- **Epic:** [E01 — Shopify Baseline Stabilization](README.md)
- **Delivery rank:** 2 of 6
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Quality gate
- **Status:** Complete — evidence validated 2026-08-31; US-01-06 gate completed
- **Dependencies:** [US-01-01](../01-shopify-baseline-stabilization/US-01-01-deterministic-test-baseline.md)

## User story and value

As a Shopify merchant, I want only authentic order notifications to be processed once, so that forged or repeated deliveries cannot trigger duplicate customer contact.

**Business value:** Forged or repeated deliveries cannot trigger duplicate customer contact.

## Scope

Characterize the existing HMAC, raw-body, delivery-ID and queue acceptance path.

**Out of scope:** Repairing the persistence/enqueue failure window; that belongs to US-02-06.

## Acceptance criteria

1. Valid signed raw payloads reach ingestion; changed bodies and missing/invalid HMAC signatures fail before ingestion. Shop-domain, topic and delivery-ID headers are characterized separately: missing IDs use the timestamp fallback and routing headers currently have no dedicated validation. Discovered signature or tenant-routing bypasses block the affected release and require an explicit fix.
2. Two deliveries with the same Shopify webhook ID follow the existing duplicate result and create one event/job.
3. Tests record the missing-webhook-ID timestamp fallback as current behavior and explicitly identify its limitation rather than claiming safe deduplication.
4. Unknown-store and inactive-store cases are characterized without accepting a payload-supplied organization as tenant authority.

## Implementation notes

- **Backend:** Exercise controller/guard and producer boundaries with fixtures; verify raw bytes, not reserialized JSON.
- **Frontend:** No UI changes.
- **Data:** Use isolated event fixtures; never real customer payloads.
- **Operations:** Keep signature/token values out of test logs and document the later recovery dependency.

## Test requirements

- Valid/invalid/missing HMAC; raw-body mutation; duplicate ID and concurrent duplicate delivery.
- Queue error after event insert is a documented failure fixture, not a falsely green recovery assertion.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Add tests without changing the accepted webhook HTTP contract.

## Evidence and references

**Implementation evidence (2026-08-31):** [HTTP, producer and real PostgreSQL contracts](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md). The isolated race proves one persisted event/one enqueue, not exactly-once delivery. Failed enqueue followed by duplicate redelivery remains unrecovered under US-02-06.

**VERIFIED FROM CODE:** The Shopify ingestion service derives idempotency from the delivery header, with a timestamp fallback; the producer skips existing events.

- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts)
- [akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts](../../akeed-backend/src/modules/webhook-queue/webhook-queue.producer.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts)

**VALIDATION BOUNDARY:** The linked evidence records the repeated automated gate, authenticated existing-session checks in both modes/locales, and isolated cancellation feedback. US-01-06 is complete for this recorded working tree. Fresh credential submission/new-account creation, live-provider readiness, recoverable dispatch and exactly-once sending are not claimed. Known E02/E06 reliability work remains open; repeat the gate on the next candidate.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Shopify — Webhooks](https://shopify.dev/docs/apps/build/webhooks)
