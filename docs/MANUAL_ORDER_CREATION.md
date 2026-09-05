# Standalone manual order creation

Last updated: 2026-09-05

## Contract

`POST /api/orders` accepts a manual order only for an authenticated owner or admin whose organization has exactly one active, onboarding-complete, entitled Standalone source. Organization, source, role, billing, activation, and external-order identity always come from trusted server context; extra body fields cannot change authority.

The caller must generate one stable `Idempotency-Key` for a logical form submission and reuse it for every retry. The value must contain 8–128 ASCII letters, numbers, dots, underscores, colons, or hyphens. A UUID is recommended. Never reuse a key for an edited submission.

Cross-origin browser submissions require an `OPTIONS /api/orders` preflight. The security middleware allows `Idempotency-Key` alongside the authentication and content headers for allowed origins. If this header is missing from `Access-Control-Allow-Headers`, the browser blocks the POST and the form enters its network-failure retry state.

```http
POST /api/orders
Authorization: Bearer <session token>
Idempotency-Key: 2e221df3-51f5-48d8-aa58-a75c41e1381e
Content-Type: application/json

{
  "customerPhone": "+201001234567",
  "customerName": "Customer name",
  "orderNumber": "ORD-1042",
  "totalPrice": "125.50",
  "currency": "EGP",
  "paymentMethod": "cash_on_delivery"
}
```

`customerName` and `orderNumber` are optional. Amounts are positive decimal strings with at most two fractional digits. Currency uses the onboarding currency allowlist. Phone and payment method values are normalized by the backend.

Successful durable acceptance returns HTTP `202`:

```json
{
  "orderId": "5fd84cd0-df9a-4c71-9dc8-11c6a41df851",
  "status": "accepted",
  "duplicate": false
}
```

`verificationId` is included only when a verification already exists. `status: "accepted"` means the order and processing intent are durable; it does not mean a verification was created, queued successfully, sent, delivered, or read. A matching retry returns the original `orderId` with `duplicate: true`. Reusing the key with changed normalized content returns `MANUAL_ORDER_IDEMPOTENCY_CONFLICT`.

## Standalone dashboard entry

The Standalone dashboard exposes a localized Arabic/English “New order” modal only when `page_context.permissions.can_create_manual_order` is explicitly `true` and the source is connected. The permission is true for owners/admins and false for viewers. Missing permission data fails closed. The embedded Shopify dashboard does not expose this action.

The modal accepts COD orders only and supports `USD`, `EUR`, `EGP`, `SAR`, `AED`, `QAR`, `KWD`, `BHD`, `OMR`, `JOD`, and `MAD`. A supported configured shipping currency is selected initially; an unsupported or missing value does not invent a fallback.

The browser creates the UUID only when the first valid request is sent and keeps it and the normalized submitted payload in component memory. It never stores the draft or token in local/session storage. Network failure, abort, the 30-second timeout, and `MANUAL_ORDER_ACCEPTANCE_FAILED` lock that exact snapshot and expose a same-token retry. Starting over requires a second localized confirmation because the earlier request may already have been accepted. Closing a failed modal preserves the retry state; closing an accepted modal or choosing “Create another order” resets fields and token.

Accepted and duplicate responses show the durable order ID and an accepted/processing-pending state. They never claim that verification, send, delivery, or read has occurred. The follow-up action opens the existing Standalone verifications view; complete accepted-order visibility remains owned by US-04-04.

## Stable error codes

| Code                                    | Meaning                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `MANUAL_ORDER_VALIDATION_FAILED`        | Body or key format is invalid; inspect `fieldErrors`.                  |
| `MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED` | The required retry key header is missing.                              |
| `MANUAL_ORDER_IDEMPOTENCY_CONFLICT`     | The key already identifies different normalized content.               |
| `MANUAL_ORDER_ROLE_REQUIRED`            | The current membership is not owner/admin.                             |
| `MANUAL_ORDER_SOURCE_UNAVAILABLE`       | No active source is available for this organization.                   |
| `MANUAL_ORDER_SOURCE_AMBIGUOUS`         | More than one active source exists; support investigation is required. |
| `MANUAL_ORDER_SOURCE_UNSUPPORTED`       | The active source is not Standalone.                                   |
| `MANUAL_ORDER_SETUP_INCOMPLETE`         | Standalone onboarding is incomplete.                                   |
| `MANUAL_ORDER_ENTITLEMENT_REQUIRED`     | The Standalone source is not currently entitled.                       |
| `MANUAL_ORDER_ACCEPTANCE_FAILED`        | Atomic durable acceptance failed; retry with the same key.             |

## Persistence and recovery

The backend atomically inserts the normalized `orders` row and a pending, dispatch-required `webhook_events` row. Existing source-scoped uniqueness constraints serialize concurrent retries. If either insert fails, both roll back. If queue dispatch fails after commit, the accepted event remains recoverable and the caller still receives the durable acceptance response.

No migration is required for this story. Operators must not delete an accepted event to unblock a retry or manually change its fingerprint. Investigate by event ID, organization, integration, and structured `manual-order-accept` / `manual-order-dispatch` logs without logging customer payloads. Retry with the original key after transient failure.

The Standalone normalizer and verification lifecycle are delivered by US-04-03. Until that gate is complete, local durable acceptance is not release authorization for merchant traffic.
