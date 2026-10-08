# US-06-04 — Synchronize approved outcomes to EasyOrders

- **Epic:** [E06 — EasyOrders Integration](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Done — ready for deploy (2026-10-08) — [evidence](../../US-06-04-EASYORDERS-OUTCOME-SYNC-EVIDENCE.md); behind `EASYORDERS_OUTCOME_SYNC_ENABLED=false`, turned on at deploy; the US-06-01 go-live block was lifted on the product owner's end-to-end test report
- **Dependencies:** [US-06-03](../06-easyorders-integration/US-06-03-easyorders-webhook-ingestion.md)

## User story and value

As a EasyOrders merchant, I want verification results reflected in my store, so that my staff can act from the order system they already use.

**Business value:** My staff can act from the order system they already use.

## Scope

Capability-aware EasyOrders status updates and explicit local-versus-remote result handling.

**Out of scope:** Automatic no-reply cancellation, refunds, fulfillment and arbitrary merchant workflows.

## Acceptance criteria

1. The adapter uses the US-06-01 approved mapping: customer confirmation to confirmed and customer/merchant-authorized cancellation to canceled only after side effects are validated.
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

**VERIFIED FROM CODE (corrected 2026-10-03):** This note used to say commerce actions were still Shopify-specific and had to move behind a common outcome contract first. They already were behind one when the story was implemented: `src/shared/commerce/commerce-outcome.ts` and `CommerceOutcomeRegistryService` (E02), with `ShopifyOutcomeAdapter` as the first adapter. What was missing was stored sync state, retry and status-event routing around that contract; see the [evidence](../../US-06-04-EASYORDERS-OUTCOME-SYNC-EVIDENCE.md).

- [akeed-backend/src/infrastructure/spokes/shopify/services/shopify-api.service.ts](../../../src/infrastructure/spokes/shopify/services/shopify-api.service.ts)
- [akeed-backend/src/modules/verification-core/verification-hub.service.ts](../../../src/modules/verification-core/verification-hub.service.ts)
- [akeed-backend/src/modules/verifications/verifications.service.ts](../../../src/modules/verifications/verifications.service.ts)
- [akeed-backend/src/modules/verification-automation/verification-automation.processor.ts](../../../src/modules/verification-automation/verification-automation.processor.ts)
- [akeed-backend/src/shared/ports](../../../src/shared/ports)

**ASSUMPTION / REQUIRES VALIDATION:** Acceptance criteria above describe approved proposed work, not completed functionality. Resolve any implementation discovery against the epic exit criteria; do not silently expand scope.

**EXTERNAL PLATFORM DEPENDENCY:** Revalidate relevant provider behavior before enabling live traffic. These primary sources are reference inputs, not proof of this integration's readiness.

- [EasyOrders — Update order status](https://public-api-docs.easy-orders.net/docs/update-order-status)
- [EasyOrders — Rate limit](https://public-api-docs.easy-orders.net/docs/rate-limit)

