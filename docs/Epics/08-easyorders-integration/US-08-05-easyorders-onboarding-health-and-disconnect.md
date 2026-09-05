# US-08-05 — Provide EasyOrders setup and connection-health guidance

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-08-04](../08-easyorders-integration/US-08-04-easyorders-outcome-status-adapter.md)

## User story and value

As a EasyOrders merchant, I want clear setup, health and disconnect controls, so that I can identify integration problems without guessing whether orders are being processed.

**Business value:** I can identify integration problems without guessing whether orders are being processed.

## Scope

Source-specific onboarding, safe diagnostics, local disconnect and support guidance.

**Out of scope:** WhatsApp self-service setup, source switching and broad historical order import.

## Acceptance criteria

1. Onboarding identifies the connected store, verified currency/phone-country defaults, automation settings and Akeed sender status.
2. Health distinguishes credentials, last accepted event, processing failure and remote status-sync failure without equating silence with a broken store.
3. Owner/admin disconnect blocks new and queued external effects, follows the verified provider revocation/webhook procedure, and retains history.
4. Reconnect is to the same verified store/source and cannot attach another merchant's store or replace an active different source.
5. Arabic/English and RTL flows show success, pending, revoked, disconnected and actionable error states without secrets.

## Implementation notes

- **Backend:** Expose safe integration health and capability DTOs using common onboarding/settings services.
- **Frontend:** Extend existing source-driven skins/hooks; never create EasyOrders-specific branching inside verification core.
- **Data:** Retain original integration/order identity and lifecycle/audit history across disconnect/reconnect.
- **Operations:** Document provider-side removal steps validated in US-08-01 and a safe support escalation path.

## Test requirements

- Expired key, missing webhook, queue backlog, unsupported action and connection retry.
- Viewer/cross-tenant controls, same-store reconnect and historical reporting after disconnect.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Ship with the native pilot; do not advertise instant self-service recovery for unverified provider behavior.

## Evidence and references

**VERIFIED FROM CODE:** Platform-neutral onboarding is needed because current onboarding resolution is Shopify-specific despite reusable settings skins.

- [akeed-backend/src/modules/onboarding/onboarding-state.service.ts](../../akeed-backend/src/modules/onboarding/onboarding-state.service.ts)
- [akeed-frontend/src/features/onboarding](../../akeed-frontend/src/features/onboarding)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)
- [akeed-backend/src/infrastructure/database/schema.ts](../../akeed-backend/src/infrastructure/database/schema.ts)
- [akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts](../../akeed-backend/src/infrastructure/database/repositories/webhook-events.repository.ts)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Authorized app link](https://public-api-docs.easy-orders.net/docs/create_authorized_app_link)
- [EasyOrders — Webhooks](https://public-api-docs.easy-orders.net/docs/webhooks)
- [EasyOrders — Authentication](https://public-api-docs.easy-orders.net/docs/authentication)

