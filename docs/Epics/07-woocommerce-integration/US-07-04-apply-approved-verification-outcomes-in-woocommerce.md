# US-07-04 — Apply approved verification outcomes in WooCommerce

- **Epic:** [E07 — WooCommerce Integration](README.md)
- **Delivery rank:** 4 of 6
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Backlog
- **Dependencies:** [US-07-03](US-07-03-ingest-signed-woocommerce-order-webhooks.md)

## User story and value

As a WooCommerce merchant, I want verification outcomes reflected safely in my store, so that staff can act on verified intent without accidental payment or fulfillment changes.

**Business value:** Staff can act on verified intent without accidental payment or fulfillment changes.

## Scope

A WooCommerce outcome adapter on the existing outcome contract and sync tracking, with the mapping approved on 2026-10-04, and handling of the store's own order updates. Shipped behind `WOOCOMMERCE_OUTCOME_SYNC_ENABLED`.

**Out of scope:** marking orders paid or completed; refunds and fulfillment; automatic no-reply cancellation; custom statuses; per-merchant mappings.

## Acceptance criteria

1. Customer confirmation writes an Akeed meta marker and one order note, and changes no status. It never sets `processing`, `completed` or a paid state.
2. Customer cancellation and merchant no-reply cancellation write `cancelled`, only from the current statuses the contract record allows. Automatic no-reply writes nothing and is reported as unsupported; it never reuses merchant cancellation authority.
3. The adapter reads the order before writing. A terminal, custom or otherwise unlisted current status produces an explicit conflict result and is not overwritten. Nothing falls through to Shopify behavior.
4. Every call uses the order's own integration and key through the restricted outbound client. A dispatch naming another tenant's order or integration is refused before any request.
5. Writes are safe to repeat: the marker and status go in one idempotent order update, and the note is added at most once. After a timeout or an ambiguous answer the adapter reads the order back before any retry, and never reports success that was not confirmed.
6. Local customer intent is kept whatever the remote result. The remote side is stored and shown as pending, succeeded, failed or unsupported with a safe provider status and error code. Credential and permission failures stop retrying and are flagged for assisted action; throttling and transient failures use the bounded retry already in place.
7. The `order.updated` delivery caused by Akeed's own write is recognized as reflected and causes nothing. A merchant's own status change in WooCommerce is recorded as observed and never changes the verification. Neither can start a second verification.
8. With the switch off the adapter advertises no capability: every outcome is recorded as unsupported and no request is made.

## Implementation notes

- **Backend:** Implement `CommerceOutcomeAdapter` for `woocommerce` with `tracksSynchronization: true` and register it. Add a `WebhookOrderUpdateHandler`. Reuse the sync tracker, retry worker, policy and retry endpoint unchanged. WooCommerce status names stay inside the spoke.
- **Frontend:** The existing "Store update" section and retry already show local versus remote state; add messages for any new error codes in Arabic and English. No WooCommerce branching in shared dashboard logic.
- **Data:** No new table: `commerce_outcome_syncs` is reused. Record the mapped action, safe provider status and error correlation against the right source and order.
- **Operations:** A host or WAF may throttle; honor `429`, `503` and `Retry-After` through the existing deferral. There is no per-store request budget.

## Test requirements

- The shared outcome-adapter contract, run for WooCommerce.
- Each approved mapping with the request asserted; unsupported automatic no-reply; terminal and custom current status; wrong-tenant dispatch; disconnected source; switch off.
- Timeout before and after the write was taken, read-back, repeated outcome (one note), throttling, revoked key, and the feedback loop on `order.updated`.
- Satisfy the applicable [shared Definition of Done](../README.md); record test results during implementation, not when this backlog is authored.

## Migration and rollout

Ships with `WOOCOMMERCE_OUTCOME_SYNC_ENABLED=false`. Enable per pilot only after the US-07-06 live run has shown the real effect of the note, the marker and `cancelled` on a store. A change to the mapping needs product-owner approval and renewed contract tests.

## Evidence and references

**VERIFIED FROM CODE (2026-10-04):** The common outcome contract and registry exist (E02), and E06 added what sits around them: stored sync state, a retry worker, a merchant retry endpoint, `order.update` routing to per-platform handlers, and the dashboard section. Shopify and Standalone do not track; EasyOrders does and is the model. Nothing needs to be extracted.

- [akeed-backend/src/shared/commerce/commerce-outcome.ts](../../../src/shared/commerce/commerce-outcome.ts)
- [akeed-backend/src/modules/commerce-outcomes/commerce-outcome.module.ts](../../../src/modules/commerce-outcomes/commerce-outcome.module.ts)
- [akeed-backend/src/modules/commerce-outcomes/commerce-outcome-registry.service.ts](../../../src/modules/commerce-outcomes/commerce-outcome-registry.service.ts)
- [akeed-backend/src/modules/commerce-outcomes/commerce-outcome-sync.policy.ts](../../../src/modules/commerce-outcomes/commerce-outcome-sync.policy.ts)
- [akeed-backend/src/modules/webhook-queue/interfaces/webhook-order-update-handler.interface.ts](../../../src/modules/webhook-queue/interfaces/webhook-order-update-handler.interface.ts)
- [akeed-backend/src/infrastructure/spokes/easyorders/easyorders-outcome.adapter.ts](../../../src/infrastructure/spokes/easyorders/easyorders-outcome.adapter.ts)
- [akeed-backend/src/infrastructure/spokes/easyorders/easyorders-status-update.handler.ts](../../../src/infrastructure/spokes/easyorders/easyorders-status-update.handler.ts)
- [akeed-backend/test/contracts/commerce-outcome-adapter.contract.ts](../../../test/contracts/commerce-outcome-adapter.contract.ts)
- [US-06-04 evidence](../../US-06-04-EASYORDERS-OUTCOME-SYNC-EVIDENCE.md)

**ASSUMPTION / REQUIRES VALIDATION:** The exact side effects of `cancelled` (stock, emails) and whether a meta-only update produces an `order.updated` delivery are confirmed at the gate. Known open item carried from E06: a sync left `pending` by a process that died has no sweeper.

**EXTERNAL PLATFORM DEPENDENCY:** WooCommerce behavior comes from the US-07-01 contract record. These are its sources.

- [WooCommerce — REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
- [WooCommerce — Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/)
