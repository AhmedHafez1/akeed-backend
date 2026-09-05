# US-05-05 — Publish server-side integration guidance

- **Epic:** [E05 — Standalone Order Ingestion API](README.md)
- **Delivery rank:** 5 of 6
- **Priority:** P1
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-05-04](../05-standalone-order-ingestion-api/US-05-04-api-abuse-controls-and-audit.md)

## User story and value

As a custom website or delivery-system developer, I want clear examples of authentication and safe retries, so that I can connect once without bespoke Akeed engineering.

**Business value:** I can connect once without bespoke Akeed engineering.

## Scope

Versioned API guide, synthetic examples and troubleshooting for the common server API.

**Out of scope:** A JavaScript SDK, delivery-company-specific adapter or outbound callbacks.

## Acceptance criteria

1. The guide documents key creation/revocation, Authorization header, required idempotency, fields, readiness and acceptance-versus-delivery semantics.
2. Copyable server-side curl/HTTP examples use placeholders and synthetic customer data, never real keys.
3. Duplicate, 409 conflict, 429, invalid-phone, blocked-source and lost-response retry cases match automated contract tests.
4. The guide states create-only semantics, server-only secrets, manual/free pilot entitlement and the one-source restriction.
5. Documentation links the dashboard lifecycle and support correlation ID without implying an unimplemented API status/callback endpoint.

## Implementation notes

- **Backend:** Generate/maintain examples from the implemented DTO and tested error contract; keep version ownership explicit.
- **Frontend:** Add discoverable localized links/help in key management while keeping technical API documentation in English.
- **Data:** No schema changes; examples must not include production PII.
- **Operations:** Include a troubleshooting decision path and the supported integration contact process.

## Test requirements

- Execute example requests against a test instance using disposable keys.
- Review every documented status/error field against actual endpoint responses.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Publish with the API pilot, and version breaking contract changes rather than silently changing examples.

## Evidence and references

**VERIFIED FROM CODE:** Standalone API capability is proposed; existing authenticated frontend helpers and backend order model define reusable terms.

- [akeed-backend/src/shared/interfaces/order.interface.ts](../../akeed-backend/src/shared/interfaces/order.interface.ts)
- [akeed-backend/src/modules/orders/orders.controller.ts](../../akeed-backend/src/modules/orders/orders.controller.ts)
- [akeed-frontend/src/shared/lib/auth.ts](../../akeed-frontend/src/shared/lib/auth.ts)
- [akeed-frontend/src/features/settings](../../akeed-frontend/src/features/settings)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** No new provider capability is assumed by this story; inherited Shopify/Meta dependencies remain subject to their owning epic gates.

