# US-08-04 — Synchronize approved outcomes to EasyOrders

- **Epic:** [E08 — EasyOrders Integration](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-08-03](../08-easyorders-integration/US-08-03-easyorders-webhook-ingestion.md)

## User story and value

As a EasyOrders merchant, I want verification results reflected in my store, so that my staff can act from the order system they already use.

**Business value:** My staff can act from the order system they already use.

## Scope

Capability-aware EasyOrders status updates and explicit local-versus-remote result handling.

**Out of scope:** Automatic no-reply cancellation, refunds, fulfillment and arbitrary merchant workflows.

## Acceptance criteria

1. The adapter uses the US-08-01 approved mapping: customer confirmation to confirmed and customer/merchant-authorized cancellation to canceled only after side effects are validated.
2. Automatic no_reply remains local/unsupported for remote cancellation unless separately approved; it never reuses merchant cancellation authority.
3. Remote operations use the order's own integration/key and handle unsupported or invalid current states explicitly.
4. Retryable failures retain local customer intent and visible pending/failed synchronization; remote success is not falsely reported.
5. Repeated outcomes and reflected status webhooks do not create loops or duplicate harmful actions; terminal remote states are not blindly overwritten.

## Implementation notes

- **Backend:** Implement only the outcome adapter contract, isolate provider status names, and read/reconcile remote state when acceptance is ambiguous.
- **Frontend:** Display local verification outcome separately from remote sync failure/pending state with localized retry guidance.
- **Data:** Record safe provider operation/status/error correlation against the correct source and order.
- **Operations:** Use bounded backoff for rate/transient failures; credential/permission errors require assisted action rather than endless retries.

## Test requirements

- All approved mappings, unsupported no_reply, invalid terminal state and wrong-tenant dispatch.
- Timeout after potential success, throttling, revoked key and webhook feedback loop.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Enable synchronization only for mapped pilot states; retain Shopify's distinct tagging/cancellation semantics.

## Evidence and references

**VERIFIED FROM CODE:** Current commerce actions are Shopify-specific and must move behind the common outcome contract before this adapter is added.

- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../akeed-backend/src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../akeed-backend/src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../akeed-backend/src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/shared/ports](../../akeed-backend/src/shared/ports)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

