# US-05-01 — Manage integration API keys securely

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-04-05](../04-standalone-manual-order-mvp/US-04-05-manual-mvp-merchant-acceptance.md)

## User story and value

As a organization owner or admin, I want to issue and revoke server integration keys, so that my website can submit orders without sharing a user password.

**Business value:** My website can submit orders without sharing a user password.

## Scope

API-key creation, one-time display, listing metadata and immediate revocation for the Standalone source.

**Out of scope:** Browser SDKs, arbitrary scopes, and keys for more than one active commerce source.

## Acceptance criteria

1. Only owner/admin sessions can create or revoke keys for their own ready Standalone integration; viewers and other tenants are denied.
2. Generated secrets are cryptographically random, shown once, and stored only as one-way hashes with nonsecret prefix and lifecycle metadata.
3. List/read APIs never return the secret or hash; logs, URLs and analytics do not contain the full key.
4. Revoked keys fail subsequent authentication; rotating a key does not reset source usage or idempotency history.
5. The localized key-management UI explains server-only use, one-time copying and revocation consequences in Arabic/English and RTL.

## Implementation notes

- **Backend:** Add an integration-key repository and dedicated authentication guard; do not treat public API keys as Supabase/Shopify user sessions.
- **Frontend:** Use existing authenticated helpers for management and clear the one-time secret on navigation; avoid persistent browser storage.
- **Data:** Persist orgId/integrationId, hash, prefix, created/last-used/revoked metadata; enforce source ownership.
- **Operations:** Audit actor/action/key prefix, never secret; already accepted orders survive key revocation unless the source itself is disabled.

## Test requirements

- Owner/admin/viewer and cross-tenant CRUD; one-time secret exposure; revoked/unknown/malformed key.
- Concurrent key use and rotation with existing accepted orders/idempotency entries.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable key issuance only after the ingestion endpoint and controls are ready for the pilot.

## Evidence and references

**VERIFIED FROM CODE:** Dual auth and memberships exist, but the reviewed source has no integration API-key ingestion surface.

- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../akeed-backend/src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/infrastructure/database/repositories/memberships.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/memberships.repository.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/modules/organizations/organizations.controller.ts](../../akeed-backend/src/modules/organizations/organizations.controller.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-frontend/src/shared/lib/auth.ts](../../akeed-frontend/src/shared/lib/auth.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

