# US-04-03 — Process manual orders through the shared lifecycle

- **Epic:** [E04 — Standalone Manual Order MVP](README.md)
- **Delivery rank:** 3 of 5
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented locally — release blocked (2026-09-05)
- **Dependencies:** [US-04-02](../04-standalone-manual-order-mvp/US-04-02-localized-manual-order-entry.md)

## User story and value

As a Standalone merchant, I want manual orders to use Akeed verification and reminders, so that I receive the same operational benefit as integrated merchants.

**Business value:** I receive the same operational benefit as integrated merchants.

## Scope

Canonical manual ingestion into eligibility, entitlement, automation, messaging and local outcomes.

**Out of scope:** Remote Shopify/order-platform mutation for Standalone orders.

## Acceptance criteria

1. Eligible manual orders create one verification and use configured initial delay, quiet hours, follow-up and no-reply rules.
2. Explicitly non-COD or missing-payment-signal orders remain visible with an actionable eligibility reason and do not send.
3. Confirmation, customer cancellation and merchant no-reply cancellation update local state; the Standalone adapter performs no external commerce request.
4. Worker retries and customer callbacks do not duplicate verification or usage, and late replies respect merchant cancellation.
5. Source inactivity, entitlement limits and provider failure preserve visible, recoverable states.

## Implementation notes

- **Backend:** Reuse hub/send/automation and source-specific eligibility; represent accepted-but-ineligible orders without claiming a verification exists.
- **Frontend:** Map local outcomes and blocked/skipped reasons to localized display states.
- **Data:** Ensure order persistence precedes or accompanies eligibility evaluation where needed for manual/API visibility; retain verification uniqueness.
- **Operations:** Use the Akeed sender until an explicitly enabled merchant connection exists; preserve synthetic-order safeguards.

## Test requirements

- COD/non-COD, initial/follow-up/no_reply, confirmed/canceled and late-reply flows.
- Queue retry, exhausted entitlement, inactive source and failed provider send.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Pause workers, apply the additive migration and inspect its preflight/backfill counts, deploy the normalizer and ledger-aware worker, then resume workers. The migration safely requeues linked Standalone events previously skipped with `no_normalizer:standalone`. Rollback is application-only: disable new manual processing while retaining accepted orders, events, dispatches and usage history.

## Evidence and references

**IMPLEMENTED AND LOCALLY VERIFIED (2026-09-05):** Persisted schema-v1 manual orders now normalize into the shared lifecycle with queue/auth-derived tenant identity. Eligible orders create or reuse one verification; ineligible, blocked, failed and provider-review states are durable and exposed through the organization-scoped orders API. Owner/admin retries recheck current readiness and remain tenant/source safe.

- [Standalone normalizer](../../akeed-backend/src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts)
- [Verification lifecycle hub](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [Durable message dispatch ledger](../../akeed-backend/src/infrastructure/database/repositories/verification-message-dispatches.repository.ts)
- [Lifecycle and retry API](../../akeed-backend/src/modules/orders/orders.service.ts)
- [Local-only Standalone outcomes](../../akeed-backend/src/infrastructure/spokes/standalone/services/standalone-outcome.adapter.ts)
- [Additive migration and backfill](../../akeed-backend/drizzle/0028_manual_order_lifecycle_dispatch_ledger.sql)
- [Frontend lifecycle contract](../../akeed-frontend/src/features/dashboard/model/dashboard.model.ts)
- [Implementation evidence](../../akeed-backend/docs/US-04-03-MANUAL-ORDER-VERIFICATION-LIFECYCLE-EVIDENCE.md)

**LOCAL RESULT:** The 628-test backend regression, build, non-fixing lint, structured-log check, focused lifecycle tests, PostgreSQL manual/Shopify contracts, idempotent PostgreSQL migration rehearsal, frontend typecheck/lint/build, and E03 compatibility checks pass. The COD-only form and Shopify active-connection behavior remain unchanged.

**EXTERNAL PLATFORM DEPENDENCY:** Live Meta acceptance/callback reconciliation and target-environment rollout were not run. US-04-04, US-04-05 and their inherited provider gates still block release. The ledger is only partial US-06-02 groundwork; tenant-owned connection/sender work remains backlog.
