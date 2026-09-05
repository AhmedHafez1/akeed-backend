# US-06-01 — Introduce tenant-owned messaging connections

- **Epic:** [E06 — Tenant-Aware WhatsApp Foundation](README.md)
- **Delivery rank:** 1 of 7
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md)

## User story and value

As a organization owner, I want my WhatsApp connection stored separately and securely, so that Akeed can send on my behalf without sharing credentials across merchants.

**Business value:** Akeed can send on my behalf without sharing credentials across merchants.

## Scope

Connection model, encrypted credential storage, state and additive migration from existing organization fields.

**Out of scope:** Self-service Meta authorization and multiple active merchant senders per organization.

## Acceptance criteria

1. A connection records organization, WABA/phone-number identity, provider, connection state and credential-version/rotation metadata.
2. Merchant credentials are encrypted at rest, never returned by read APIs or logs, and mutations require owner/admin or explicitly authorized operations access.
3. An active merchant phone-number identity cannot be assigned to two organizations; the shared Akeed sender has a distinct system identity.
4. Existing organization credentials are inventoried and migrated idempotently without assuming that populated fields prove readiness.
5. The environment-configured Akeed sender remains usable and no Shopify merchant is automatically migrated.

## Implementation notes

- **Backend:** Add a connection repository/resolver boundary; generalize encryption configuration while maintaining decryption compatibility with existing ciphertext.
- **Frontend:** No self-service connect wizard; expose only safe connection metadata required by later UI.
- **Data:** Add connection records with pending/ready/degraded/disconnected/revoked state and preserve legacy fields during transition.
- **Operations:** Use staged key migration, redacted preflight reports and explicit verification before marking a connection ready.

## Test requirements

- Encrypted write/read internally, no API secret exposure, duplicate phone ownership and role/tenant denial.
- Idempotent legacy migration, old-key decryption and missing/corrupt credential failure.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Expand and backfill first; retain legacy decryption support until migration and rollback evidence are complete.

## Evidence and references

**VERIFIED FROM CODE:** Organization WA fields and encryption on write exist, but WhatsAppService reads global environment credentials.

- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/organizations.repository.ts)
- [akeed-backend/src/shared/utils/token-encryption.util.ts](../../akeed-backend/src/shared/utils/token-encryption.util.ts)
- [akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts](../../akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts)
- [akeed-backend/src/modules/organizations/organizations.controller.ts](../../akeed-backend/src/modules/organizations/organizations.controller.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

