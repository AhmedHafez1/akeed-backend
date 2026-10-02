# US-05-05 — Publish server-side integration guidance

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-05-04](US-05-04-api-abuse-controls-and-audit.md)

## User story and value

As a custom website or delivery-system developer, I want a guide that lets me integrate Akeed into my back-end in minutes, so that I can connect once without bespoke Akeed engineering.

**Business value:** For API customers the documentation is the product: every question it answers is a support ticket that never gets opened.

## Scope

A versioned server API guide with copyable examples and a troubleshooting path, written so a developer can answer, from the guide alone: which fields are required, what "accepted" means, what happens to non-COD orders, what happens when a request is sent twice, what happens when the order already exists, what each error means, and how to generate an `Idempotency-Key`.

**Out of scope:** A JavaScript SDK, delivery-company-specific adapters, and outbound callbacks.

## Acceptance criteria

1. **Location.** An English guide at `akeed-frontend/content/docs/en/server-api.md`, structured like `bulk-order-import.md`, plus a short Arabic overview in `content/docs/ar` linking to it.
2. **Quick start.** Create a key, then one `curl` call with `Authorization: Bearer <key>`, `Idempotency-Key` and `Content-Type: application/json`, then find the order on the dashboard.
3. **Contract.** Required and optional fields (including the import extras), `externalOrderId` semantics, accepted-is-not-delivered, create-only semantics, server-only secrets and the one-source restriction.
4. **Idempotency, explained for integrators:**
   - one `Idempotency-Key` per order, derived from the integrator's own order id, reused on every retry of that order;
   - same key and same body → original response with `duplicate: true`; same key and a different body → 409 `API_ORDER_IDEMPOTENCY_CONFLICT`;
   - a new key for an order Akeed already has (by `externalOrderId`, from any channel, including file import) → `duplicate: true` if the order is identical, otherwise 409 `API_ORDER_EXTERNAL_ID_CONFLICT`. "Identical" is strict: extras and order number count, and file import generates `IMP-…` order numbers when none was given;
   - a replayed order that sits in a held or cancelled import keeps that state; the dashboard is the source of truth.
5. **Examples** in curl and raw HTTP with placeholders and synthetic data only: success, duplicate replay, both 409s, non-COD accepted-not-sent, 413, 429 with `Retry-After`, invalid phone, blocked or unready source, credit denial, and lost-response retry.
6. **Troubleshooting** decision path keyed by error `code`, the effective rate and body limits, and the support process (send the correlation ID). It links to the dashboard lifecycle and does not imply any status or callback endpoint.
7. **Proven.** An automated test runs every documented example against a test instance with a disposable key and asserts the documented status and code.
8. **Discoverable.** The Settings → API keys tab links to the guide (localized link text; the guide itself stays English).

## Implementation notes

- **Backend:** Examples are kept in a fixture the contract test reads, and the guide is checked against it, so the doc and the tested contract cannot drift. Version ownership is explicit (`/api/v1`).
- **Frontend:** Uses the existing `docs/[slug]` route; i18n keys for the link in both message files.
- **Data:** No schema changes; no production PII in examples.

## Test requirements

- The example suite above; a review of every documented status and error field against the actual responses.
- Satisfy the applicable [shared Definition of Done](../README.md).

## Migration and rollout

Publish with the API pilot; version breaking contract changes instead of silently changing examples.

## Evidence and references

**VERIFIED FROM CODE (2026-10-02):** The public docs content and route exist; the bulk-import guide is the structural model.

- [akeed-frontend/content/docs/en/bulk-order-import.md](../../../../akeed-frontend/content/docs/en/bulk-order-import.md)
- [akeed-frontend/content/docs/en/troubleshooting.md](../../../../akeed-frontend/content/docs/en/troubleshooting.md)
- [akeed-frontend/src/features/settings](../../../../akeed-frontend/src/features/settings)
- [akeed-backend/src/modules/order-imports/file-import.channel-adapter.ts](../../../src/modules/order-imports/file-import.channel-adapter.ts)

**ASSUMPTION / REQUIRES VALIDATION:** The acceptance criteria describe approved proposed work, not completed functionality. Priority stays P1 pending a product decision on raising it to P0.

**EXTERNAL PLATFORM DEPENDENCY:** None.
