# US-05-01 — Manage integration API keys securely

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 1 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Done — E05 gate passed locally; shipped to production 2026-10-02 and validated 2026-10-03 (product-owner-reported); see [evidence](../../US-05-01-INTEGRATION-API-KEY-LIFECYCLE-EVIDENCE.md)
- **Dependencies:** [US-04.5-08](../04.5-standalone-paymob-usage-billing/US-04.5-08-sandbox-and-production-release-gate.md), [US-04.6-10](../04.6-standalone-bulk-order-import/US-04.6-10-bulk-import-release-gate.md) (both implemented)

## User story and value

As an organization owner or admin, I want to issue and revoke server credentials for my Standalone integration, so that my website or back-end can submit orders without sharing a user password.

**Business value:** A merchant's own server can submit orders into Akeed safely, and access can be cut off instantly.

## Scope

Credentials **for a Standalone integration**: creation, one-time display, metadata listing and immediate revocation, plus the guard that authenticates a key into the existing ingestion context. This is not a generic authentication framework: a key belongs to exactly one integration and grants exactly one capability (submitting orders to it).

**Out of scope:** Browser SDKs, scopes or permissions per key, keys for more than one active commerce source, and the order endpoint itself (US-05-02).

## Acceptance criteria

1. Only owner/admin sessions can create or revoke keys for their own ready Standalone integration; viewers and other tenants are denied. The integration is found by the existing `StandaloneSourceResolver.resolveWritable(user, API_KEY_SOURCE_CODES)` — a new `StandaloneSourceCodeMap` constant beside `MANUAL_ORDER_SOURCE_CODES` — never by a new integrations query.
2. Generated secrets are cryptographically random, shown once, and stored only as one-way hashes with a non-secret prefix and lifecycle metadata.
3. List/read APIs never return the secret or hash; logs, URLs and analytics do not contain the full key.
4. Revoked keys fail subsequent authentication immediately; revocation is idempotent. Rotating a key does not reset source usage or idempotency history (idempotency is scoped to the source, see US-05-03).
5. The localized key-management UI (Standalone only) explains server-only use, one-time copying and revocation consequences in Arabic/English, RTL and dark mode.
6. `IntegrationApiKeyGuard` accepts only `Authorization: Bearer <key>` (query-string keys are rejected), compares hashes timing-safe, answers a uniform 401 for unknown, malformed or revoked keys, and attaches a principal `{orgId, integrationId, keyId, prefix}`. It does **not** build the ingestion context: US-05-02 turns the principal into the existing `StandaloneIngestionContext` `{orgId, source}` through the source resolver, so the command never needs to know which authentication produced it.

## Implementation notes

- **Backend:** A key repository and a dedicated guard; public API keys are not Supabase or Shopify sessions and never pass through `DualAuthGuard`. Key management controllers stay thin and follow the existing role pattern (`assertOrganizationWriteAllowed` via the resolver's `roleRequired` copy).
- **Frontend:** A Settings → "API keys" tab (Standalone mode only) using existing `api.*` helpers and `shared/ui` primitives. The secret lives only in component state and is cleared on close or navigation; no browser storage.
- **Data:** Additive, hand-written migration `integration_api_keys` (id, org_id, integration_id, prefix, key_hash, name, created_by, created_at, last_used_at, revoked_at, revoked_by) with RLS by org_id, a unique prefix and an index on (integration_id, revoked_at). Add it to the order-imports contract migration list.
- **Operations:** Audit create/revoke with actor, action and prefix via `buildBackendLog` — never the secret or hash. `last_used_at` is updated at most once per minute. Accepted orders survive key revocation unless the source itself is disabled.

## Test requirements

- Owner/admin/viewer and cross-tenant matrix; one-time secret exposure; revoked, unknown and malformed keys; a query-string key is rejected; concurrent use during rotation.
- The guard principal resolves to the same `StandaloneIngestionContext` as the session path for the same org (type-level and runtime test; completed in US-05-02 once `resolveForIntegration` exists).
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation.

## Migration and rollout

Ship issuance behind the pilot: keys can be created only once US-05-02 to US-05-04 are ready.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):** Dual auth, memberships and the Standalone source resolver exist; there is no integration API-key surface yet.

- [akeed-backend/src/modules/auth/guards/dual-auth.guard.ts](../../../src/modules/auth/guards/dual-auth.guard.ts)
- [akeed-backend/src/modules/auth/organization-role.ts](../../../src/modules/auth/organization-role.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-source-resolver.ts](../../../src/modules/order-ingestion/standalone-source-resolver.ts)
- [akeed-backend/src/modules/order-ingestion/standalone-order-ingestion.types.ts](../../../src/modules/order-ingestion/standalone-order-ingestion.types.ts)
- [akeed-backend/src/infrastructure/database/schema.ts](../../../src/infrastructure/database/schema.ts)
- [akeed-frontend/src/features/settings](../../../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** The acceptance criteria describe approved proposed work, not completed functionality.

**EXTERNAL PLATFORM DEPENDENCY:** None.
