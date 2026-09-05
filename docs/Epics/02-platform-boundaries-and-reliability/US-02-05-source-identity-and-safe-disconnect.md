# US-02-05 — Enforce source-scoped identity and preserve history

- **Epic:** [E02 — Platform Boundaries and Reliability](README.md)
- **Delivery rank:** 5 of 7
- **Priority:** P0
- **Horizon:** NOW
- **Story type:** Technical enabler
- **Status:** Implemented — staging migration and authenticated dual-mode UI validation pending 2026-09-02
- **Dependencies:** [US-02-04](../02-platform-boundaries-and-reliability/US-02-04-provider-neutral-entitlements.md)

## User story and value

As a merchant, I want orders isolated by their source and retained after disconnect, so that identical provider IDs cannot collide and historical reporting remains trustworthy.

**Business value:** Identical provider IDs cannot collide and historical reporting remains trustworthy.

## Scope

Order lookups, trusted source relationships and normal disconnect semantics.

**Out of scope:** Multiple active sources per organization, source switching, or preventing authorized privacy deletion.

## Acceptance criteria

1. Order lookup/deduplication uses integrationId plus externalOrderId and verifies organization ownership.
2. The same external ID in separate source fixtures never resolves to the other source's order.
3. Normal disconnect deactivates the source and credentials, blocks new/queued effects, and retains order/verification/usage history.
4. Authorized privacy redaction remains a separate explicit deletion path; migration detects orphaned/ambiguous rows rather than guessing ownership.

## Implementation notes

- **Backend:** Align repositories with the database identity model and enforce source ownership before mutation.
- **Frontend:** Represent inactive/disconnected sources without deleting their dashboard history.
- **Data:** Review cascade FKs and use an additive preservation strategy; do not mass-reassign historical integration IDs.
- **Operations:** Provide preflight counts, exception reporting and rollback instructions for identity/retention changes.

## Test requirements

- Same external ID across tenants/sources; mismatched relationship; disconnect with queued jobs.
- Historical reporting after disconnect and separately authorized redaction regression.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Repair only unambiguous mappings; stop migration on ambiguous ownership and retain evidence.

## Evidence and references

Implementation, rollout and test results: [US-02-05 evidence](../../akeed-backend/docs/US-02-05-SOURCE-IDENTITY-AND-SAFE-DISCONNECT-EVIDENCE.md).

**IMPLEMENTED FROM CODE:** Order lookup now scopes by organization, integration and external ID. Composite foreign keys verify source ownership, and normal source-linked history foreign keys no longer cascade integration deletion. Organization deletion and the admin lifecycle retain their explicit privacy/lifecycle cascade semantics.

- [akeed-backend/src/infrastructure/database/repositories/orders.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/orders.repository.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/verification-core/verification-send.service.ts](../../akeed-backend/src/modules/verification-core/verification-send.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)

**RELEASE VALIDATION PENDING:** Local unit, PostgreSQL contract, Shopify contract, build, lint, typecheck and production UI build results are recorded in the implementation evidence. Dedicated staging preflight/migration and authenticated embedded/Standalone locale smoke checks remain open; no live source was disconnected.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.
