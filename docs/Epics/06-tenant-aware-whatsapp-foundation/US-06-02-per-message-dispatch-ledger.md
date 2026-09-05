# US-06-02 — Record every verification message dispatch

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 2 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-06-01](../06-tenant-aware-whatsapp-foundation/US-06-01-messaging-connections-and-credential-migration.md)

## User story and value

As a support operator, I want separate records for initial and follow-up sends, so that I can trace delivery and retry history to the correct sender.

**Business value:** I can trace delivery and retry history to the correct sender.

## Scope

Message ledger with connection identity, provider IDs, attempt/error state and lifecycle timestamps.

**Out of scope:** Replacing the verification business-state machine or promising exactly-once Meta delivery.

## Acceptance criteria

1. Each initial/follow-up logical dispatch has its own verification/org/connection identity, message kind, template and retry-safe dispatch key.
2. Provider message IDs are retained per send instead of replacing the only previous ID; attempts/errors and delivery timestamps are auditable.
3. Database uniqueness/claiming prevents two workers from intentionally sending the same dispatch concurrently.
4. If provider acceptance is uncertain after a timeout/crash, the ledger marks an unknown/reconciliation-needed outcome rather than blindly claiming failure and resending.
5. Legacy waMessageId values are backfilled as legacy-known messages without inventing whether they were initial/follow-up when history is unavailable.

## Implementation notes

- **Backend:** Create/claim the dispatch before calling Meta and persist the response after; separate logical dispatch identity from attempts.
- **Frontend:** Preserve current verification view; expose safe per-message diagnostics to authorized operations where needed.
- **Data:** Add ledger tables/indexes and keep existing waMessageId compatibility during staged rollout.
- **Operations:** Define reconciliation for ambiguous sends and audit actual uncertainty; do not label provider delivery exactly-once.

## Test requirements

- Initial plus multiple follow-ups, concurrent workers, known rejection, successful response and timeout after possible acceptance.
- Legacy backfill/replay and retained routing of earlier message IDs.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Dual-write/read-compatible migration before retiring legacy field use; compare records and never fabricate missing history.

## Evidence and references

**PARTIAL GROUNDWORK (2026-09-05):** US-04-03 added a shared initial/follow-up dispatch ledger for the Akeed system sender, durable unknown-provider outcomes, usage reservation, legacy ID backfill, callback lookup and audited staff resolution. This reduces the immediate retry/ambiguity failure window but does not implement connection identity, tenant sender selection, credential history, multiple follow-up sequence identities or the complete E06 operational diagnostics. This story therefore remains **Backlog** and its dependency on US-06-01 is unchanged.

- [US-04-03 implementation evidence](../../akeed-backend/docs/US-04-03-MANUAL-ORDER-VERIFICATION-LIFECYCLE-EVIDENCE.md)
- [Current dispatch repository](../../akeed-backend/src/infrastructure/database/repositories/verification-message-dispatches.repository.ts)

**Reproduced E01 failure windows (2026-08-31):** [Send, automation and repository evidence](../../akeed-backend/docs/E01-BASELINE-EVIDENCE.md) covers swallowed quota-release failures, provider acceptance followed by failed local persistence (initial and follow-up), repeated sending/reservation on retry, and replacement of the single mutable `waMessageId`. **Owner: backend messaging/reliability implementer.** These are current defects/limitations, not exactly-once guarantees. Triage urgent production fixes separately now; do not wait for merchant-owned sender rollout merely because the durable ledger is tracked in E06.

**VERIFIED FROM CODE:** Verifications have a single waMessageId and markFollowUpSent replaces it with the follow-up ID.

- [akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/verifications.repository.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)
