# Integrations, Webhooks, And Automation Platform

Last updated: 2026-05-28

## Purpose

This document explains how Akeed integrates with external platforms (Shopify, Meta/WhatsApp), processes inbound webhooks, manages asynchronous job queues, and runs the verification automation pipeline. It covers the ingestion path from Shopify order webhook to WhatsApp send (Standalone merchants add orders through the manual and bulk-import channels instead; see `MANUAL_ORDER_CREATION.md` and `BULK_ORDER_IMPORT.md`), the customer reply flow, follow-up and escalation scheduling, quiet-hours handling, billing entitlement checks, and GDPR compliance webhooks.

For the verification lifecycle state machine and merchant controls, see `ORDER_CONFIRMATION_WORKFLOW.md`.
For dashboard and settings screens, see `MERCHANT_OPERATIONS.md`.
For Standalone bulk order import (held orders and paced release), see `BULK_ORDER_IMPORT.md`.
For authentication and organization management, see `IDENTITY_ACCESS_AND_ORGANIZATION.md`.

## Scope

In scope:

- Shopify webhook ingestion (orders, billing, uninstall, GDPR).
- BullMQ queue infrastructure (webhook processing, verification automation).
- WhatsApp Cloud API integration (template sends, status callbacks, customer replies).
- Verification core pipeline (eligibility, billing reservation, send, finalization).
- Automation scheduling (initial send, follow-up, no-reply escalation).
- Quiet-hours engine.
- Shopify Admin GraphQL API (order tagging, cancellation, billing subscriptions).
- Port/adapter architecture for platform abstraction.
- COD payment detection.
- Idempotency and deduplication.
- GDPR data request, customer redact, and shop redact handlers.

Out of scope:

- Authentication and token validation (see `IDENTITY_ACCESS_AND_ORGANIZATION.md`).
- Onboarding and billing plan activation (see `ONBOARDING_AND_BILLING.md`).
- Dashboard UI and settings (see `MERCHANT_OPERATIONS.md`).

## Architecture Overview

Core order outcomes use CommerceOutcomeRegistryService. It reloads the source-scoped persisted order and integration before selecting an adapter. ShopifyOutcomeAdapter wraps the existing ShopifyApiService GraphQL implementation. Shopify-specific eligibility also lives in the spoke and is injected through ORDER_ELIGIBILITY_STRATEGIES.

| Boundary | Implementation |
| --- | --- |
| MessagingPort | WhatsAppService (existing Akeed sender) |
| CommerceOutcomeRegistryService | ShopifyOutcomeAdapter selected from the persisted integration |
| ORDER_ELIGIBILITY_STRATEGIES | ShopifyOrderEligibilityStrategy supplied at composition time |
| STORE_PLATFORM_PORT | ShopifyApiService for existing onboarding/billing; separation remains US-02-04 |

ORDER_ADMIN_PORT and ORDER_TAGGING_PORT remain legacy interface files, with no runtime global bindings or core consumers. ShopifyCommerceModule provides the API and outcome adapter without importing webhook ingestion.

See [US-02-03 implementation evidence and rollout](US-02-03-SHOPIFY-ADAPTER-EVIDENCE.md).

## Shopify Webhooks

### Registered Topics

Webhooks are registered automatically after app install (both OAuth and token exchange paths).

| Topic                      | Route                                             | Handler service                |
| -------------------------- | ------------------------------------------------- | ------------------------------ |
| `ORDERS_CREATE`            | `POST /webhooks/shopify/orders-create`            | `ShopifyOrderWebhookService`   |
| `APP_SUBSCRIPTIONS_UPDATE` | `POST /webhooks/shopify/app-subscriptions-update` | `ShopifyBillingWebhookService` |
| `APP_UNINSTALLED`          | `POST /webhooks/shopify/uninstalled`              | `ShopifyBillingWebhookService` |
| `customers/data_request`   | `POST /webhooks/shopify/customers/data_request`   | `ShopifyGdprWebhookService`    |
| `customers/redact`         | `POST /webhooks/shopify/customers/redact`         | `ShopifyGdprWebhookService`    |
| `shop/redact`              | `POST /webhooks/shopify/shop/redact`              | `ShopifyGdprWebhookService`    |

All webhook routes are protected by `ShopifyHmacGuard` (HMAC-SHA256 body signature verification with `crypto.timingSafeEqual`).

### Order Webhook Ingestion

The order webhook is a thin, fast-path handler designed to return 200 OK immediately. All business logic runs asynchronously.

```
POST /webhooks/shopify/orders-create
  → ShopifyHmacGuard (HMAC verification)
  → ShopifyOrderWebhookService.handleOrderCreate()
    → Extracts idempotency key from X-Shopify-Webhook-Id header
      (fallback: shopify-order-{id}-{timestamp})
    → WebhookQueueProducer.ingest()
      → Inserts webhook_events row (dedup by platform + idempotencyKey)
      → Enqueues BullMQ job with deterministic jobId
    → Returns { received: true } immediately
```

If the idempotency key already exists, returns `{ received: true, duplicate: true }` without re-enqueueing.

### Billing Webhook

`APP_SUBSCRIPTIONS_UPDATE` updates the integration's billing status.

Handled statuses: `active`, `cancelled`, `declined`, `expired`, `frozen`.

Billing webhooks never change `is_active`, which is reserved for Shopify installation state. Updates received for an uninstalled integration are acknowledged and ignored so a late `active` event cannot reactivate service.

Smart filtering: ignores blocked-status webhooks for non-current subscriptions. This prevents a failed upgrade attempt from disabling the active billing on the current plan.

### Uninstall Webhook

`APP_UNINSTALLED` transactionally marks the integration inactive, clears Shopify credentials, marks local billing cancelled, clears any pending plan, and closes the current installation lifecycle. Historical configuration, plan, subscription, order, verification, and usage records remain until `shop/redact` performs the explicit GDPR wipe. Accepted webhook jobs carry their trusted organization/source identity and are skipped before business processing if the source is disconnected or the relationship no longer matches.

Queued automation re-checks both installation and billing state at execution time. Pending initial sends become `failed` with an `integration_inactive` or `billing_not_active` reason; follow-up and escalation jobs retain the existing verification status and record skip metadata. No quota is reserved and no WhatsApp send, quiet-hours reschedule, or Shopify tag is attempted for blocked jobs.

### GDPR Webhooks

Required by Shopify for app listing compliance.

| Handler                     | Action                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| `handleCustomerDataRequest` | Exports orders + verifications for the customer (phone-based lookup). |
| `handleCustomerRedact`      | Deletes all customer data (orders, verifications, memberships).       |
| `handleShopRedact`          | Deletes all store data (complete uninstall + GDPR wipe).              |

Phone numbers are normalized to multiple variations for lookup. Exported orders are filtered by the order IDs in the Shopify request payload.

## Queue Infrastructure

### BullMQ Configuration

Redis-backed queues with global defaults:

| Setting                | Value                                           |
| ---------------------- | ----------------------------------------------- |
| Redis URL              | `REDIS_URL` (default: `redis://localhost:6379`) |
| Default retry attempts | 5                                               |
| Backoff strategy       | Exponential, 3s base                            |
| Completed job cleanup  | 7 days                                          |
| Failed job cleanup     | 30 days                                         |

### Queue: `webhook-processing`

Processes inbound webhook payloads asynchronously.

| Property      | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Concurrency   | 10                                                                       |
| Job types     | `ORDER_CREATE`, `ORDER_UPDATE`, `APP_UNINSTALLED`, `SUBSCRIPTION_UPDATE` |
| Job ID format | `{platform}-{idempotencyKey}`                                            |

**Processing flow:**

1. Mark `webhook_events` row as `processing`.
2. Route by `jobType` (currently `ORDER_CREATE` is the active path).
3. Look up integration by store domain and platform.
4. Normalize payload via platform-specific normalizer (e.g., `ShopifyOrderNormalizer`).
5. Delegate to `VerificationHubService.handleNewOrder()`.
6. Mark event as `completed`, `skipped`, or `failed`.

**Failure handling:**

After 5 failed attempts, the `@OnWorkerEvent('failed')` listener marks the webhook event as `failed` in the database with the error message.

**Extensibility:**

Order normalizers are registered via the `WEBHOOK_ORDER_NORMALIZERS` multi-token (Shopify, Standalone, EasyOrders, WooCommerce), allowing future platforms (Salla, Zid) to plug in without modifying the processor.

### Queue: `verification-automation`

Schedules and executes time-delayed verification lifecycle actions.

| Property    | Value                                            |
| ----------- | ------------------------------------------------ |
| Concurrency | 5                                                |
| Job types   | `INITIAL_SEND`, `FOLLOW_UP`, `ESCALATE_NO_REPLY` |

Job ID patterns (deterministic, ensuring idempotency):

| Job type            | Job ID format                               |
| ------------------- | ------------------------------------------- |
| `INITIAL_SEND`      | `verification-{verificationId}-initial`     |
| `FOLLOW_UP`         | `verification-{verificationId}-follow-up-1` |
| `ESCALATE_NO_REPLY` | `verification-{verificationId}-no-reply`    |

### Webhook Events Table

Tracks webhook lifecycle for audit and deduplication.

| Column            | Type      | Notes                                                      |
| ----------------- | --------- | ---------------------------------------------------------- |
| `id`              | UUID      | Primary key.                                               |
| `platform`        | text      | `shopify`, `salla`, `woocommerce`, `zid`.                  |
| `job_type`        | text      | `ORDER_CREATE`, etc.                                       |
| `idempotency_key` | text      | From webhook header or generated.                          |
| `store_domain`    | text      | Shop domain.                                               |
| `org_id`          | UUID      | FK → organizations.                                        |
| `integration_id`  | UUID      | FK → integrations.                                         |
| `status`          | enum      | `pending` → `processing` → `completed`/`failed`/`skipped`. |
| `raw_payload`     | JSONB     | Original webhook body.                                     |
| `attempts`        | int       | Retry count.                                               |
| `last_error`      | text      | Error message from last failure.                           |
| `processed_at`    | timestamp | When processing completed.                                 |
| `received_at`     | timestamp | When webhook was received.                                 |

Unique constraint on `(platform, idempotency_key)` for deduplication.

## WhatsApp Integration (Meta Spoke)

### Sending Verification Templates

`WhatsAppService` implements `MessagingPort` and sends WhatsApp template messages via the Meta Cloud API.

**Endpoint:** `POST https://graph.facebook.com/v24.0/{WA_PHONE_NUMBER_ID}/messages`

**Authentication:** Bearer token from `WA_ACCESS_TOKEN` environment variable.

**Template resolution:**

1. If `preferredLanguage` is `ar` or `en`, use it directly.
2. If `auto`, detect from the customer phone number's country code.

Arabic country codes: `+966` (SA), `+971` (UAE), `+973` (BH), `+20` (EG), `+212` (MA), and others.

**Available template variants:**

| Language | Variants                                      | Default    |
| -------- | --------------------------------------------- | ---------- |
| Arabic   | `standard`, `egyptian`, `gulf`, `short`       | `standard` |
| English  | `friendly`, `professional`, `direct`, `short` | `friendly` |

Each variant defines a Meta template name, language code, and parameter order.

**Template parameters:**

Body parameters are mapped according to the variant's `bodyParameterOrder` (e.g., `['customer', 'store', 'order', 'total']`).

**Quick-reply buttons:**

Two buttons are attached to every template:

- Confirm: payload `confirm_{verificationId}`
- Cancel: payload `cancel_{verificationId}`

### Receiving WhatsApp Webhooks

**Webhook subscription verification:**

`GET /webhooks/whatsapp` — Meta sends a challenge request with `hub.verify_token`. The controller compares it against `WA_VERIFY_TOKEN` (normalized, case-insensitive). On match, returns `hub.challenge`. On mismatch, throws `ForbiddenException`.

**Incoming messages:**

`POST /webhooks/whatsapp` — receives customer replies and delivery status updates.

**Customer reply processing:**

1. Extract button payload from `message.button.payload` or `message.interactive.button_reply.id`.
2. Parse action: `confirm_{id}` → `confirmed`, `cancel_{id}` → `canceled`. Exactly
   one underscore is required — verification ids are UUIDs and never contain one,
   so a payload with more segments did not come from an Akeed template.
3. A customer who types instead of tapping is also handled: `message.text.body`
   is matched against the accepted yes/no answers in
   `src/shared/verification/customer-reply-intent.ts` (Arabic, English and
   digits), and the verification is located via `message.context.id` — the wamid
   of the template being replied to — against `verifications.wa_message_id`.
   Anything ambiguous resolves to no intent and is logged as
   `unresolved_reply` rather than guessed at.
4. Check if merchant already canceled (`merchant_canceled_at` is set) → skip to prevent customer from overriding merchant action.
4. Update verification status in database.
5. Set `cancellationSource: 'customer'` for customer-initiated cancellations.
6. Call `VerificationHubService.finalizeVerification()` → dispatch the customer outcome through the registry. Shopify adds the existing tag; customer cancellation never calls remote order cancellation.

**Status updates:**

Delivery statuses from Meta (`delivered`, `read`, `failed`) are matched by `waMessageId` and update the verification record.

`VerificationMessageDispatchesRepository.resolveOrParkReceipt` resolves each status to one of three outcomes:

- **Dispatch-ledger row:** the status goes through `recordProviderStatus`.
- **Pre-ledger verification:** the status goes through `updateStatusByWamid`.
- **Nothing yet:** the status is parked in `provider_message_receipts`, and the log line is `outcome: retry` with `reason: awaiting_acceptance`.

Meta can report delivery before the transaction that stores the wamid has committed. This is routine for prepaid sends, because their acceptance also moves credits under the org credit lock. Such a receipt used to be dropped, and because the webhook still answers 200, Meta never resent it. Now `markAccepted` applies the parked receipts in its own transaction, oldest first, using the same rules as the live path. It then sets `applied_at`.

Both sides take a transaction-scoped advisory lock on the wamid, so whichever side runs second always sees the other's committed write. Receipts for wamids Akeed never sent stay parked with `applied_at IS NULL`.

## Verification Core Pipeline

### Order Eligibility

`OrderEligibilityService` routes to a platform-specific strategy. Currently only `ShopifyOrderEligibilityStrategy` is implemented.

The canonical commerce-source values are `shopify`, `salla`, `zid`, `woocommerce`, `standalone`, and `easyorders`. This list is a storage and TypeScript compatibility contract; only platforms with a registered normalizer and eligibility strategy can process orders. Unknown, differently cased, or whitespace-padded values are unsupported and never fall back to Shopify.

`NormalizedOrder` carries trusted `orgId`/`integrationId`, source order ID/reference, E.164 phone, optional customer name, decimal-string amount, currency, normalized `paymentSignals`, and `codStatus` (`cod`, `non_cod`, or `unknown`). `rawPayload` is an opaque `Record<string, unknown>` interpreted only by provider-specific adapters or strategies.

**COD detection:**

An explicit `codStatus` of `cod` or `non_cod` takes precedence. For `unknown` and legacy callers that omit it, the Shopify strategy collects payment signals from:

- `order.paymentSignals[]`
- `order.paymentMethod`
- `rawPayload.payment_gateway_names[]`
- `rawPayload.gateway`
- `rawPayload.transactions[].gateway`

Each signal is tested against COD patterns:

```
/\bcod\b/i
/\bcash\s*on\s*delivery\b/i
/\bcollect\s*on\s*delivery\b/i
/الدفع عند الاستلام/i
/كاش عند الاستلام/i
```

Results:

| Outcome           | Reason                       |
| ----------------- | ---------------------------- |
| `eligible: true`  | `cod_match` + matched signal |
| `eligible: false` | `non_cod_payment_method`     |
| `eligible: false` | `missing_payment_signal`     |

### Platform Constraint Rollout and Rollback

Apply migration `0023_expand_commerce_platform_contracts.sql` before deploying any writer that stores `standalone` or `easyorders`. The migration retains all existing values and does not update existing integrations or billing claims. An application rollback must leave the expanded database checks in place; removing a value after it has been written would make valid retained rows incompatible with the old constraint.

### Verification Hub Service

The central orchestrator for new order processing.

**`handleNewOrder(orderData, integration)` flow:**

1. **Eligibility check:** Must be COD payment method.
2. **Integration readiness:** Auto-verify enabled, onboarding completed, integration active, billing active.
3. **Order persistence:** Find or create order in database.
4. **Deduplication:** If verification already exists for this order, skip.
5. **Billing reservation:** Reserve a slot in the monthly usage table.
6. **Create verification:** Status = `pending`.
7. **Dispatch initial send.**

**Initial send dispatch:**

- If `sendDelayMinutes > 0` or quiet-hours adjustment needed → enqueue delayed `INITIAL_SEND` job.
- If `sendDelayMinutes == 0` and outside quiet hours → send immediately via `VerificationSendService.sendInitial()`.
  - On success → schedule follow-up and escalation.
  - On `plan_limit_reached` → mark verification as `failed`.

**`scheduleFollowUpAndEscalation()` logic:**

- Follow-up due time: `now + followUpDelayMinutes`, adjusted for quiet hours.
- Escalation due time: `now + escalationDelayMinutes`, adjusted for quiet hours.
- If follow-up is enabled and escalation would fire before or at the same time as follow-up, escalation is pushed to `followUpDueTime + 60s` to ensure ordering.

**`finalizeVerification()` — post-reply actions:**

| Customer action | Shopify tag       |
| --------------- | ----------------- |
| Confirmed       | `Akeed: Verified` |
| Canceled        | `Akeed: Canceled` |

Tagging is skipped for test orders (prefix `akeed-test-`).

### Verification Send Service

Handles the actual WhatsApp send for both initial and follow-up messages.

**`sendInitial(verificationId)` flow:**

1. Load verification + order + its linked integration. Missing linkage returns `missing_linked_integration`; inconsistent order/integration ownership returns `source_identity_mismatch` before quota or messaging. No Shopify fallback lookup.
2. Reserve billing slot → if limit reached, return `plan_limit_reached`.
3. Resolve template selection from integration settings (`codTemplateArVariant`, `codTemplateEnVariant`).
4. Call `MessagingPort.sendVerificationTemplate()`.
5. Extract `waMessageId` from response.
6. If missing or error → release billing reservation, mark verification as `failed`.
7. Update verification status: `pending` → `sent`.
8. Return `{ status: 'sent', waMessageId, sentAt }`.

**`sendFollowUp(verificationId)` flow:**

Same as initial but:

- Does not change verification status (remains at current status).
- Increments `follow_up_attempts`.
- Records `follow_up_sent_at` and `waMessageId` for the follow-up.
- On failure, logs to verification `metadata` (e.g., `follow_up_failed`, `follow_up_skipped`, `plan_limit_reached`).

### Billing Entitlement Service

Controls plan-based send limits.

**Billing plans:**

| Plan     | Included verifications | Monthly price |
| -------- | ---------------------- | ------------- |
| Starter  | 30                     | Free          |
| Basic    | 300                    | $9.99         |
| Pro      | 1,000                  | $22.99        |
| Business | 2,500                  | $49.99        |

**Billing cycle:**

Rolling 30-day period from `billingActivatedAt`. Computed as: `activationDate + (completedCycles × 30 days)`.

Fallback: 1st of the current UTC calendar month if no activation date.

**Reservation flow:**

1. `reserveVerificationSlot(integration)`:
   - Computes current period start.
   - Atomically increments `consumed_count` in `integration_monthly_usage`.
   - Returns `{ allowed: true/false, consumedCount, includedLimit }`.
2. `releaseVerificationSlot(params)`: decrements count on send failure.
3. `hasAvailableSlot(integration)`: read-only check without reservation.

## Automation Engine

### Job Types

| Job type            | Trigger                                   | Delay source                                      |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| `INITIAL_SEND`      | New COD order with `sendDelayMinutes > 0` | `sendDelayMinutes` + quiet-hours adjustment       |
| `FOLLOW_UP`         | Successful initial send                   | `followUpDelayMinutes` + quiet-hours adjustment   |
| `ESCALATE_NO_REPLY` | Successful initial send                   | `escalationDelayMinutes` + quiet-hours adjustment |

### Initial Send Handler

1. Load verification + order + integration.
2. Verify: auto-verify enabled, verification status is `pending`.
3. Apply quiet-hours delay if currently inside quiet window.
4. Call `VerificationSendService.sendInitial()`.
5. On success → schedule follow-up and escalation via `VerificationHubService`.
6. On `plan_limit_reached` → mark verification as `failed`.

### Follow-Up Handler

1. Check: follow-up enabled on integration, verification not in terminal status.
2. Check: merchant has not already canceled (`merchant_canceled_at`).
3. Apply quiet-hours delay if active.
4. Call `VerificationSendService.sendFollowUp()`.
5. On success → update follow-up tracking fields.
6. On failure → log to verification metadata (`follow_up_failed`, `follow_up_skipped`, `plan_limit_reached`).

### No-Reply Escalation Handler

1. Check: verification not in terminal status, merchant has not already canceled.
2. **Deferred follow-up check:** if follow-up is still pending (no `follow_up_sent_at` and follow-up enabled), reschedule escalation +60 seconds to allow follow-up to complete first.
3. Mark verification status as `no_reply`.
4. Dispatch `automatic_no_reply_tagging`; Shopify adds `Akeed: No Reply`. The registry suppresses external work for persisted `isTest` orders and `akeed-test-` IDs after validating source and capability.

### Quiet-Hours Engine

Quiet hours prevent sends during merchant-configured off-hours.

**Configuration:**

| Field               | Type    | Example       |
| ------------------- | ------- | ------------- |
| `quietHoursEnabled` | boolean | `true`        |
| `quietHoursStart`   | HH:mm   | `21:00`       |
| `quietHoursEnd`     | HH:mm   | `09:00`       |
| `timezone`          | string  | `Asia/Riyadh` |

Cross-midnight windows are supported (e.g., 21:00–09:00).

**Behavior:**

- `isInsideQuietHours(config)` — checks if the current time falls within the quiet window in the merchant's timezone.
- `adjustForQuietHours(config)` — if inside quiet hours, computes the delay until the quiet window ends.
- When a job fires during quiet hours, it throws a `DelayedError` to signal BullMQ to reschedule the job to the next valid time (job is not marked as completed or failed).

## Shopify Admin API

`ShopifyApiService` provides Shopify Admin GraphQL API operations.

**API version:** `2026-01`

**Endpoint:** `https://{platformStoreUrl}/admin/api/{version}/graphql.json`

**Authentication:** Decrypted offline access token from the integration record.

### Operations

**Order tagging:**

- `addOrderTag(integration, externalOrderId, tag)` — GraphQL `tagsAdd` mutation.
- Tags used: `Akeed: Verified`, `Akeed: Canceled`, `Akeed: No Reply`.

**Order cancellation:**

- `cancelOrder(integration, externalOrderId, reason)` — GraphQL `orderCancel` mutation.
- Reason: `"Canceled by Akeed after no reply to COD verification"`.
- Restock enabled, refund disabled, no customer notification.
- The API retains its optional `jobId`. The outcome adapter exposes `pending_provider_operation` with `providerOperationId`; absence of a reference is `accepted_without_reference`, never proof of completion.

**Billing operations:**

- `createRecurringApplicationCharge()` — GraphQL `appSubscriptionCreate` with usage pricing line items.
- `getAppSubscriptionStatus()` — queries subscription status (`active`, `pending`, etc.).
- `cancelAppSubscription()` — GraphQL `appSubscriptionCancel` with proration.
- `reportUsageCharge()` — GraphQL `appUsageRecordCreate` for overage reporting.

**Shop metadata:**

- `getShopName()` — GraphQL `shop { name }`.

### Error Handling

- GraphQL errors and user validation errors are logged with request IDs. Tagging errors now propagate to registry failure results while callers preserve local outcomes and best-effort semantics.
- Access tokens are decrypted per-request using `SHOPIFY_TOKEN_ENCRYPTION_KEY`.

## Backend Code Map

| Area                           | File                                                                         | Responsibility                                                              |
| ------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Shopify webhook controller     | `infrastructure/spokes/shopify/shopify.controller.ts`                        | Routes 6 webhook topics to handler services.                                |
| Order webhook service          | `infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts`    | Thin ingestion: dedup + enqueue, returns immediately.                       |
| Billing webhook service        | `infrastructure/spokes/shopify/services/shopify-billing-webhook.service.ts`  | Billing status updates, uninstall handling.                                 |
| GDPR webhook service           | `infrastructure/spokes/shopify/services/shopify-gdpr-webhook.service.ts`     | Data export, customer redact, shop redact.                                  |
| Shopify API service            | `infrastructure/spokes/shopify/services/shopify-api.service.ts`              | GraphQL operations: tags, cancel, billing, shop metadata.                   |
| Shopify order normalizer       | `infrastructure/spokes/shopify/services/shopify-order.normalizer.ts`          | Converts Shopify order JSON to `NormalizedOrder`.                           |
| WhatsApp service               | `infrastructure/spokes/meta/whatsapp.service.ts`                             | Template sends via Meta Cloud API.                                          |
| WhatsApp webhook controller    | `infrastructure/spokes/meta/whatsapp.webhook.controller.ts`                  | Subscription verification + incoming message handler.                       |
| WhatsApp webhook service       | `infrastructure/spokes/meta/whatsapp.webhook.service.ts`                     | Customer reply parsing, status update processing.                           |
| Meta module                    | `infrastructure/spokes/meta/meta.module.ts`                                  | Exports `WhatsAppService` as singleton.                                     |
| Webhook queue module           | `modules/webhook-queue/webhook-queue.module.ts`                              | Registers `webhook-processing` queue and normalizers.                       |
| Webhook queue producer         | `modules/webhook-queue/webhook-queue.producer.ts`                            | Dedup + enqueue webhook jobs.                                               |
| Webhook queue processor        | `modules/webhook-queue/webhook-queue.processor.ts`                           | Async job handler: normalize → route to VerificationHub.                    |
| Webhook queue constants        | `modules/webhook-queue/webhook-queue.constants.ts`                           | Queue name, job types, platform types.                                      |
| Webhook events repository      | `infrastructure/database/repositories/webhook-events.repository.ts`          | CRUD with conflict-based dedup, status transitions.                         |
| Verification automation module | `modules/verification-automation/verification-automation-queue.module.ts`    | Registers `verification-automation` queue.                                  |
| Automation producer            | `modules/verification-automation/verification-automation.producer.ts`        | Enqueue delayed initial-send, follow-up, and escalation jobs.               |
| Automation processor           | `modules/verification-automation/verification-automation.processor.ts`       | Handles INITIAL_SEND, FOLLOW_UP, ESCALATE_NO_REPLY with quiet-hours.        |
| Automation constants           | `modules/verification-automation/verification-automation.constants.ts`       | Queue name and job type constants.                                          |
| Verification hub service       | `modules/verification-core/verification-hub.service.ts`                      | Central orchestrator: eligibility → reserve → create → dispatch → finalize. |
| Verification send service      | `modules/verification-core/verification-send.service.ts`                     | WhatsApp send for initial and follow-up, billing reservation/release.       |
| Billing entitlement service    | `modules/verification-core/billing-entitlement.service.ts`                   | Plan limit checks, slot reservation/release, period computation.            |
| Order eligibility service      | `modules/verification-core/order-eligibility.service.ts`                     | Routes to platform-specific COD detection strategy.                         |
| Shopify eligibility strategy   | `infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy.ts` | Multi-signal COD payment detection with Arabic support.                     |
| Messaging port                 | `shared/ports/messaging.port.ts`                                             | Interface for template-based messaging.                                     |
| Order admin port               | `shared/ports/order-admin.port.ts`                                           | Interface for order cancellation.                                           |
| Order tagging port             | `shared/ports/order-tagging.port.ts`                                         | Interface for order tag management.                                         |
| Store platform port            | `shared/ports/store-platform.port.ts`                                        | Interface for billing and shop metadata.                                    |
| Phone service                  | `shared/services/phone.service.ts`                                           | Phone number normalization and validation.                                  |

## Integration API Keys (Standalone, US-05-01)

Server credentials that let a merchant's own back end submit orders to their Standalone store. A key belongs to exactly one integration and grants exactly one capability: submitting orders to it (the order endpoint arrives in US-05-02). It is not a general authentication framework.

**Format.** `ak_live_<8 lowercase alphanumerics>_<43 base64url chars>`. The first 16 characters are the non-secret, unique **prefix**. The rest encodes 32 random bytes. Only the SHA-256 of those 32 bytes is stored (`integration_api_keys.key_hash`), and the full key is returned once, in the create response.

**Management (session auth).** All three endpoints sit behind `DualAuthGuard` and answer `Cache-Control: no-store`.

| Method | Endpoint | Who | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/integration-keys` | any member | Metadata only (`id, name, prefix, status, createdAt, lastUsedAt, revokedAt`), active keys first, at most 50. Also returns `maxActive`. |
| `POST` | `/api/integration-keys` | owner, admin | Body `{ name }` (1-60 chars). The source comes from `StandaloneSourceResolver.resolveWritable(user, API_KEY_SOURCE_CODES)`. 201 `{ key, secret }`. |
| `DELETE` | `/api/integration-keys/:id` | owner, admin | Revokes immediately and idempotently: an already revoked key keeps its original time and actor. It does not require a ready source, so an owner can always cut access. Returns the key's metadata. |

At most **5 active keys** per integration, which leaves room for zero-downtime rotation. A per-integration advisory lock holds the cap under concurrent creates.

**Error codes.**
- `API_KEY_ROLE_REQUIRED` (403)
- `API_KEY_SOURCE_UNAVAILABLE` / `API_KEY_SOURCE_AMBIGUOUS` / `API_KEY_SETUP_INCOMPLETE` (409)
- `API_KEY_SOURCE_UNSUPPORTED` (403)
- `API_KEY_LIMIT_REACHED` (409, with `maxActive`)
- `API_KEY_NOT_FOUND` (404; this includes another organization's key and a malformed id)
- `API_KEY_VALIDATION_FAILED` (400, with `fieldErrors`)

**`IntegrationApiKeyGuard`** (`modules/integration-keys/guards/integration-api-key.guard.ts`, exported by `IntegrationKeysModule`):
- It accepts only `Authorization: Bearer <key>`. A request with a key-like query parameter (`api_key`, `apikey`, `key`, `access_token`, `token`, `authorization`) or any query value containing `ak_live_` is refused, even when the header also holds a valid key.
- It looks the key up by prefix, compares hashes in constant time (an unknown prefix still runs a comparison) and refuses revoked keys.
- Every failure answers the same 401 `API_KEY_INVALID`. The reason (`malformed`, `unknown`, `mismatch`, `revoked`, `query_string`, `missing_header`) appears only in the warn log, beside the prefix.
- On success it attaches `request.integrationApiKey = { orgId, integrationId, keyId, prefix }`, which a handler reads with `@CurrentIntegrationKey()`. It never builds a `StandaloneIngestionContext`: US-05-02 turns the principal into one through the source resolver.
- `last_used_at` is written at most once a minute per key, by a conditional `UPDATE` that never touches `revoked_at`. A failed write never fails the request.

**Data and RLS.** `integration_api_keys` (migration `0046`) has a composite FK to `integrations (id, org_id)`, a unique `prefix`, and indexes `(integration_id, revoked_at)` and `(org_id, created_at DESC)`. RLS is enabled. `anon` and `authenticated` lose every grant, then get back `SELECT` on the metadata columns only, under an `org_id = get_user_org_id()` policy. Members can read their organization's key metadata, never the hash, and cannot insert, update or delete through PostgREST.

**Audit.** Create and revoke log `integration-api-key-create` / `integration-api-key-revoke` with `orgId`, `userId` (the actor), `integrationId`, `keyId` and `keyPrefix`. Logs never contain the secret or the hash. `key_hash`, `keyhash` and `plaintext` are in `REDACTED_KEYS` as a backstop.

**Operations.** Accepted orders survive key revocation; only disabling the source stops their processing. Idempotency is scoped to the source, so rotating a key resets neither usage nor idempotency history. Contract suite: `npm run test:contract:integration-keys`, or `scripts/test-integration-api-keys-contract.ps1` for a disposable PostgreSQL.

## EasyOrders Connection (US-06-02)

The EasyOrders spoke lives in `src/infrastructure/spokes/easyorders/`. This section covers the authorized connection; order webhooks are in [EasyOrders Webhook Ingestion](#easyorders-webhook-ingestion-us-06-03) and status writes in [EasyOrders Outcome Synchronization](#easyorders-outcome-synchronization-us-06-04) below. EasyOrders behavior is taken from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), not from the public docs.

**Flow.**

1. Signup records the chosen source. `POST /api/organizations` with `sourceMode: "connect"` creates the organization and owner membership with no source (`StandaloneOrganizationProvisioningRepository.provisionWithoutSource`). Nothing is converted later.
2. `POST /api/easyorders/install` (owner or admin, Supabase session, switch on, organization on the allow-list, organization has no integration row or only its own disconnected EasyOrders source) opens a context in `easyorders_pending_installs` and returns the authorized-app link. The link asks for `orders:read,orders:update` only. It carries two different 256-bit tokens in URL paths: the one-time callback token and the webhook URL token. Only their SHA-256 is stored. A new install retires the organization's earlier open context. A context lives 15 minutes.
3. The seller accepts in EasyOrders. Their browser calls `POST /api/easyorders/install/callback/:token` with `{ api_key, store_id }`. The endpoint is public; the path token is the only tenant binding.
4. The callback looks the context up by hash. Unknown, expired, used, retired or exhausted (5 refused callbacks) contexts all answer `401 EASYORDERS_INSTALL_CONTEXT_INVALID`. The key is then checked server-side with `GET orders/<random UUID>`: only a 2xx or the exact inactive-store `400` passes (fail closed, a `404` does not). A timeout, `429` or `5xx` is `503 EASYORDERS_PROVIDER_UNAVAILABLE` and the same link may be retried.
5. One transaction (`EasyOrdersConnectionsRepository.connect`, in `withSerializableRetry`) locks the context and the organization, re-checks that no source exists, inserts the `easyorders` integration and its `easyorders_connections` row, and marks the context used. The answer is an empty `204`.
6. The seller copies the two webhook secrets from EasyOrders into `PUT /api/easyorders/connection/webhook-secrets` (owner or admin, write-only).

**What is stored.**

- `integrations`: `platform_type = 'easyorders'`, source identity `easyorders:<orgId>`, the Starter / `not_required` pilot entitlement, the Standalone onboarding defaults with `assume_cod_when_payment_missing = false`. `access_token` and `webhook_secret` stay NULL.
- `easyorders_connections`: the API key and both webhook secrets as `encryptToken` ciphertext (a CHECK refuses anything that is not a `v1:` envelope), the webhook URL token's hash and its last six characters, `health` (`ok` or `store_inactive`), and the claimed `store_id`.
- Both tables have RLS on with no policy and all `anon` / `authenticated` grants revoked.

**Store ownership.** The callback's `store_id` is a claim (`store_verified_at` NULL). A partial unique index makes a store unique only once verified, so a claim never blocks the real owner. A callback naming a store that is verified for another organization is refused (`409 EASYORDERS_STORE_UNAVAILABLE`). The claim is verified on the first order (US-06-03, below).

**Secrets.** The key, both tokens, both secrets and the install link are never logged (added to `REDACTED_KEYS`) and never returned, with one exception: the install link is returned once to the member who started the install, because the browser has to carry it to EasyOrders. `GET /api/easyorders/connection` reports state, store id, health, the URL hint and whether each secret is set.

**Disconnect and reconnect** are in [EasyOrders Setup, Health and Disconnect](#easyorders-setup-health-and-disconnect-us-06-05) below. A source of another platform, active or not, still blocks a connect: there is no source switching.

**Validate.** `scripts/test-easyorders-connection-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/easyorders`.

## EasyOrders Setup, Health and Disconnect (US-06-05)

No switch of its own. Behavior comes from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), sections 1, 2, 4, 6 and 7. Operations are in the [runbook](Epics/06-easyorders-integration/evidence/US-06-05-disconnect-and-support-runbook.md).

**Source setup seam.** A source whose connection has state of its own registers a `SourceSetupContributor` in `SOURCE_SETUP_CONTRIBUTORS` (`src/shared/commerce/source-setup.ts`, bound in `onboarding.module.ts`). `SourceSetupService` reads it by platform type; the onboarding module never names a provider. `EasyOrdersSetupContributor` answers from the connection row alone, with no provider call.

- `GET /api/onboarding/state` and `GET /api/settings` carry `sourceSetup` for such a source: connection state, store, order defaults, the Akeed sender status and the blocked reasons (`order_defaults_missing`, `webhook_secrets_missing`, `credentials_rejected`, `source_disconnected`, and `webhook_disabled` for a source whose store can disable a webhook, after the common ones). The key is absent for Shopify and Standalone.
- `POST /api/onboarding/complete` refuses with `409 ONBOARDING_BLOCKED` and those reasons.
- Both reads stay available for a source its merchant disconnected. Every write still answers `404 ONBOARDING_SOURCE_INACTIVE`.

**Health.** `GET /api/settings/source-health` (any member) returns separate signals and no overall status: credentials (the provider's last answer, not a live check), the last accepted event and the count in the last 7 days, processing failures, events waiting, store updates that failed or are pending, deliveries refused before processing, and each outcome action with whether the store takes it now. A null last event means "no events yet" and is never a fault. A contributor that can read its webhooks from the store (optional `inspectWebhooks`; WooCommerce) adds a `webhooks` block with each one's state; the key is absent for every other source.

**Disconnect.** `DELETE /api/easyorders/connection` (owner or admin; not gated by the connect switch or the pilot list). One transaction: open install contexts are retired, `integrations.is_active` becomes false, and the API key, the URL token, both webhook secrets and the verified-store claim are wiped. The store id, the settings and all history stay. Waiting store updates are then closed as `integration_inactive`. Queued events, messages and store writes are stopped by the same `is_active` checks that already guarded them. Nothing is removed at EasyOrders; the merchant deletes the key and webhooks there.

**Reconnect.** The same install and callback. Only when the organization's one source is its own disconnected EasyOrders source, and only for the same `store_id` (`409 EASYORDERS_RECONNECT_STORE_MISMATCH` otherwise). The same integration row is reactivated in place with a new key and a new URL token and no secrets, so webhooks are refused until the two new secrets are pasted.

**Validate.** The three `scripts/test-easyorders-*-contract.ps1` suites, `npx jest src/modules/onboarding src/infrastructure/spokes/easyorders`.

## EasyOrders Webhook Ingestion (US-06-03)

Order-created webhooks enter the common queue through the EasyOrders spoke. It ships dark behind `EASYORDERS_INGESTION_ENABLED`. Behavior comes from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), sections 2 to 4, 6 and 8.

**Routes.** `POST /webhooks/easyorders/orders/:token` and `POST /webhooks/easyorders/status/:token` (`EasyOrdersWebhookController`). Public, with a per-address flood cap instead of the app-wide limit.

**Acceptance (`EasyOrdersWebhookService`), in this order.**

1. Switch off: `404`, nothing read or stored.
2. The URL token is looked up by its SHA-256 (`findByWebhookTokenHash`). It alone decides the tenant. An unknown or rotated token, or a source that is not active, is `401 EASYORDERS_WEBHOOK_UNAUTHORIZED`.
3. The `secret` header must equal that webhook's stored secret (orders and status have different ones). It is a static shared secret, not a signature: it is compared in constant time after a length check. A secret Akeed does not hold yet, a missing header or a wrong value is the same `401`. A wrong value on a valid token also increments `easyorders_connections.rejected_deliveries`.
4. An order's `store_id` must equal the integration's store: otherwise `403 EASYORDERS_WEBHOOK_STORE_MISMATCH`.
5. An order payload has no `event_type`. One that has, or one without a text `id`, is `400 EASYORDERS_WEBHOOK_MALFORMED`, so status and unknown events never reach the create path.
6. `WebhookQueueProducer.ingest` writes the `webhook_events` row and dispatches. The answer is `200` only after the row is written. A queue outage still answers `200`: the row is the durable record and the dispatcher recovers it. A database failure answers `5xx` and logs `easyorders-webhook-not-persisted`, which should alert, because EasyOrders is assumed not to retry.

Nothing is stored for steps 1 to 5.

**Idempotency.** EasyOrders sends no delivery id. The key is `order.create:<integrationId>:<orderId>`, and `order.status:<integrationId>:<orderId>:<old>:<new>` for a status event, under source identity `easyorders:<orgId>`. Repeated and concurrent deliveries collapse into one event; the order and verification unique constraints are the second line.

**Status events** are authenticated and recorded as `order.update` only. The worker has no handler for that job type and marks them skipped, so no order is read or changed. Handling them is US-06-04.

**Normalization (`EasyOrdersOrderNormalizer`, in the worker).** Registered in `WEBHOOK_ORDER_NORMALIZERS` next to the Shopify and Standalone ones.

- Currency and phone country come from `easyorders_connections.currency` and `phone_country`, set by an owner or admin through `PUT /api/easyorders/connection/order-settings`. While either is NULL the order is recorded as `missing_currency` or `missing_phone_country`. Nothing is inferred from the payload, `government` or an IP country.
- The phone is read with `PhoneService.standardizeMobile` in that country; a number that does not parse or is a landline is `invalid_phone`. The amount is `total_cost` as decimal text; zero, negative or malformed is `invalid_amount`.
- `orderNumber` is the first eight characters of the order id, because the payload has no reference field.
- Skip reasons are written to `webhook_events.last_error` with status `skipped`: `store_mismatch`, `store_unverified`, `store_unavailable`, `source_credentials_rejected`, `order_not_found`, `incomplete_payload`, `missing_currency`, `missing_phone_country`, `invalid_phone`, `invalid_amount`, `source_connection_missing`.

**Eligibility (`EasyOrdersOrderEligibilityStrategy`).** `payment_method` equal to `cod` is `cod_match`. Any other value is `non_cod_payment_method` and a missing one is `missing_payment_signal`, until the real value list is observed.

**Order lookup.** Never while a webhook is being received. In the worker, `GET orders/:id` with the integration's own key runs only when `total_cost`, `phone`, `full_name` or `payment_method` is missing, or while the store is still an unverified claim. Fetched values only fill what the webhook lacked.

- A fetched order naming the same store sets `store_verified_at`. One naming another store, or none, stops the order and verifies nothing. If another integration already holds the verified store the order is `store_unavailable`.
- Budget (`EasyOrdersRateLimiter`): 30 requests a minute per integration, 20 of them for lookups so outcome writes keep headroom, on the clock minute. In memory, per instance.
- `429`: the integration's calls pause for `Retry-After`, or until the next clock minute plus up to 10 seconds, and the job is rescheduled for that delay. Timeout, network failure and `5xx` use the queue's normal backoff. The inactive-store `400` sets health `store_inactive` and retries after 5 minutes. `401` and `403` set health `credentials_rejected` and are not retried.

**Queue contract change.** A normalizer may now answer asynchronously and may return `{ skipped: true, reason }`. One that throws `RetryAfterError` (`src/shared/http/bounded-http.ts`) has its job moved to the delayed set for that long, at most 5 minutes and at most 5 times, without spending an attempt; after that it fails and retries like any other error. The Shopify and Standalone normalizers are unchanged.

**Sources that must not send.** A source that is not active is refused at the route and skipped in the worker (`integration_inactive`). One whose onboarding is not complete is accepted and skipped by the hub (`onboarding_incomplete`), like every other source.

**Migration.** `0048_easyorders_ingestion.sql` adds `currency`, `phone_country`, `rejected_deliveries` and `last_rejected_at` to `easyorders_connections` and allows the health value `credentials_rejected`. Additive and re-runnable. Rollback: move any `credentials_rejected` row back to `ok`, restore the two-value check, drop the four columns.

**Logs.** `easyorders-webhook-accept` (outcome, `reason` or `errorCode`), `easyorders-webhook-not-persisted`, `easyorders-order-lookup`, `easyorders-order-normalize`, `easyorders-order-settings-save`, `webhook-job-defer`. None carries the token, a secret, the key or the payload.

**Validate.** `scripts/test-easyorders-ingestion-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/easyorders src/modules/webhook-queue`.

## EasyOrders Outcome Synchronization (US-06-04)

Approved outcomes are written to EasyOrders as an order status, and the local result is kept apart from whether the store has it. It ships dark behind `EASYORDERS_OUTCOME_SYNC_ENABLED`. Behavior comes from the [US-06-01 contract record](Epics/06-easyorders-integration/evidence/US-06-01-contract-record.md), sections 2, 5, 6 and 8.

**Shared part (platform-neutral).** The outcome contract is the one Shopify already uses (`src/shared/commerce/commerce-outcome.ts`, `CommerceOutcomeRegistryService`). This story added what was missing around it:

- An adapter may set `tracksSynchronization`. For such an adapter the registry records every dispatch in `commerce_outcome_syncs` (one row per order and action): `pending` before the adapter runs, then `succeeded`, `failed` or `unsupported`. Shopify and Standalone do not set it and dispatch exactly as before, with no row.
- A caller may pass `retryInBackground`. The hub does, for customer confirmation and cancellation (and the merchant's manual confirmation, which takes the same path). A merchant no-reply cancellation does not: its failure goes back to the merchant, who is the retry.
- `CommerceOutcomeSyncProcessor` (queue `commerce-outcome-sync`) tries a `pending` row again through the same registry. `planOutcomeSync` decides: at most 5 attempts, backing off 30 seconds, 2, 8 and 30 minutes; a wait the provider names (`retryAfterMs`) is honored up to 10 minutes and up to 5 times without spending an attempt. A permanent failure is never retried. If the retry cannot be queued the row becomes `failed` with `retry_not_scheduled` instead of waiting forever.
- A tracking failure is logged and never changes the dispatch result. The verification's status is never changed by any of this.
- `GET /api/verifications` reports `remote_sync` (`state`, `action`, `error_code`, `requires_assistance`, `retryable`, `updated_at`) for the row's current local result, or `null` for a source that does not track. `POST /api/verifications/:id/outcome-sync/retry` (owner or admin) reopens a `failed` background-retryable sync with a fresh set of tries; anything else is `409 OUTCOME_SYNC_NOT_RETRYABLE`.
- `WebhookQueueProcessor` routes `order.update` events to `WEBHOOK_ORDER_UPDATE_HANDLERS`, after the same source checks as an order. A platform without a handler keeps `unhandled_job_type`.

**Mapping (`easyorders-outcome.mapping.ts`).**

| Akeed action | EasyOrders |
| --- | --- |
| `customer_confirmation` | status `confirmed` |
| `customer_cancellation` | status `canceled` |
| `merchant_no_reply_cancellation` | status `canceled`, only on the merchant's own action |
| `automatic_no_reply_tagging`, `merchant_cancellation_tagging` | none: `unsupported` / `capability_not_supported`, no request |

Automatic no-reply is local only. It never becomes a cancellation and never borrows the merchant action's authority.

**Adapter (`EasyOrdersOutcomeAdapter`), per outcome.**

1. Load the connection of the order's own integration (`findByIntegration(integrationId, orgId)`) and decrypt its key. The registry has already refused a command whose organization, integration and order do not belong together (`source_identity_mismatch`).
2. Read the order. It must name the integration's store and carry a status, or nothing is written (`store_unverified`, `store_mismatch`, `remote_state_unreadable`).
3. Already at the target: `applied`, no write. Anything other than `pending`: `permanent_failure` `remote_state_conflict` with the status seen. A terminal or advanced state is never overwritten.
4. `PATCH orders/:id/status`, one attempt. A `2xx` is `applied`.
5. Timeout, network failure or `5xx` on the write is ambiguous: the order is read back. At the target is `applied`; still `pending`, or unreadable, is `retryable_failure` `write_unconfirmed`, and the next attempt starts with a read again, so the write is never repeated blindly.

| Provider answer | Result |
| --- | --- |
| `429`, or the integration's budget is spent | `retryable_failure` with the wait (`Retry-After`, else the next clock minute plus jitter); the integration's other EasyOrders calls pause too |
| Timeout, network failure, `5xx` on the read | `retryable_failure` `source_unavailable` |
| Inactive-store `400` | health `store_inactive`, retried after 5 minutes |
| `401` / `403` | health `credentials_rejected`, `permanent_failure` with `requiresAssistance`; never retried |
| `404` | `permanent_failure` `order_not_found` |
| Any other answer to the write | `permanent_failure` `remote_rejected` |

**Status webhooks (`EasyOrdersStatusUpdateHandler`).** The tenant is the one the URL token resolved to (US-06-03). The handler never writes to EasyOrders and never changes a verification, so a status event cannot start a loop. It records what the event was on `webhook_events.last_error`: `reflected_outcome` when the new status is the one Akeed asked for on that order (matched from a `pending` or `failed` row too, for a write whose answer was lost), `remote_status_observed` for any other change, `order_not_owned` for an order id the integration does not own, `malformed_status_event` otherwise.

**Migration.** `0049_commerce_outcome_syncs.sql` creates the table, API-only (RLS on, grants revoked). Additive and re-runnable. Rollback: drop the table; no other row is touched.

**Logs.** `commerce-outcome-dispatch`, `easyorders-outcome-sync` (`errorCode`, `providerStatus`), `commerce-outcome-sync-schedule`, `commerce-outcome-sync-retry`, `commerce-outcome-sync-settle` / `-begin` / `-schedule` (failures of the tracking itself), `verification-outcome-sync-retry`, `webhook-order-update-handle`. None carries the key or a payload.

**Validate.** `scripts/test-easyorders-outcome-sync-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/easyorders src/modules/commerce-outcomes src/modules/webhook-queue`.

## WooCommerce Webhook Ingestion (US-07-03)

Order deliveries enter the common queue through the WooCommerce spoke (`src/infrastructure/spokes/woocommerce/`). It ships dark behind `WOOCOMMERCE_INGESTION_ENABLED`. Behavior comes from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), sections 2, 3, 4 and 6, and its amendments.

**Route.** `POST /api/woocommerce/webhooks/:token` (`WooCommerceWebhookController`), one URL for both `order.created` and `order.updated`. Public, with a per-address flood cap. `applyWooCommerceWebhookEdge` (`main.ts`) hands the route the body as raw bytes whatever the content type is; the signature is over those bytes.

**Acceptance (`WooCommerceWebhookService`), in this order.**

1. A request whose `X-WC-Webhook-Topic` is not one of the two order topics is the ping: `200` on a token Akeed issued (a connection, or an install still connecting), nothing stored. On an unknown token it is `401`, or `404` while ingestion is off.
2. Switch off: `404 WOOCOMMERCE_INGESTION_UNAVAILABLE` for an order delivery, nothing read or stored.
3. The URL token is looked up by its SHA-256 (`findByWebhookTokenHash`). It alone decides the tenant. An unknown, malformed or rotated token is `401 WOOCOMMERCE_WEBHOOK_UNAUTHORIZED`. The token of an install whose callback is still running is answered `200` with nothing stored.
4. `X-WC-Webhook-Signature` must be the base64 HMAC-SHA256 of the raw body with that install's decrypted secret, compared with `timingSafeEqual` after a length check.
5. `X-WC-Webhook-Source`, canonicalized by the store-URL rules, must equal the connection's canonical store URL.
6. A failure of step 4 or 5 is the same `401` and increments `woocommerce_connections.rejected_deliveries`. The answer never says which part failed; the log line (`woocommerce-webhook-refused`) does.
7. The bytes are parsed as JSON. A body that is not an order with an integer `id` is answered `200` and not stored.
8. `WebhookQueueProducer.ingest` writes the `webhook_events` row and dispatches. The answer is `200` with an empty body only after the row is written. A queue outage still answers `200`. A database failure answers `5xx` and logs `woocommerce-webhook-not-persisted`, which should alert.

An inactive source with a live token is not refused: the event is recorded and the processor marks it `integration_inactive`. A non-`2xx` answer would count toward WooCommerce disabling the webhook.

**Routing and idempotency (`woocommerce-ingestion.policy.ts`).** A delivery starts a verification, on either topic, when `payment_method` is `cod`, `status` is `processing` or `on-hold`, and `date_created_gmt` is not earlier than `woocommerce_connections.connected_at` (compared at second resolution).

| Route | When | Job type | Key |
| --- | --- | --- | --- |
| Create | No create event for the order yet, and the start rule holds | `order.create` | `order.create:<integrationId>:<orderId>` |
| Update | A create event for the order exists | `order.update` | `order.update:<integrationId>:<orderId>:<status>:<date_modified_gmt>` |
| Skipped | Neither | `order.create` | `order.skip:<integrationId>:<orderId>:<status>:<date_modified_gmt>` |

The source identity is `woocommerce:<orgId>`. `X-WC-Webhook-Delivery-ID` is stored for audit and is never a key. A skipped delivery never takes the create key, so a checkout draft followed by the placed order gives one verification. A create event that ended on the order's own data (`incomplete_payload`, `order_currency_unsupported`, `order_phone_country_missing`, `invalid_phone`, `invalid_amount`) has not taken the order: its next delivery that passes the start rule is tried again as a create under `order.retry:<integrationId>:<orderId>:<status>:<date_modified_gmt>`, until Akeed holds the order (US-07-06). Update events go to `WooCommerceOrderUpdateHandler` (US-07-04, below), which records what the update was and changes nothing.

**What an event keeps (`woocommerce-delivery.ts`).** `raw_payload` is `{ topic, webhookId, deliveryId, order }`, where `order` holds only `id`, `number`, `status`, `currency`, the two GMT dates, `total`, `payment_method`, the billing name, phone and country, and `meta_data` entries whose key is `akeed_outcome`. Email, addresses, IP address, line items and other plugins' meta are not stored.

**Normalization (`WooCommerceOrderNormalizer`, in the worker).** Registered in `WEBHOOK_ORDER_NORMALIZERS`. It applies the same start rule, so a skipped delivery is recorded with `order_predates_connection`, `order_not_placed`, `non_cod_payment_method` or `missing_payment_signal`. Currency, total and the billing country a local phone is read in come from the order: `order_currency_unsupported`, `invalid_amount`, `incomplete_payload` (no phone), `order_phone_country_missing`, `invalid_phone`. The first and the fourth are WooCommerce's own codes: `missing_currency` and `missing_phone_country` mean a setting the merchant has not chosen, and WooCommerce has none. No request is sent to the store and there is no rate limiter. `WooCommerceOrderEligibilityStrategy` repeats the `cod` test in `ORDER_ELIGIBILITY_STRATEGIES`.

**Validate.** `scripts/test-woocommerce-ingestion-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/woocommerce`.

## WooCommerce Outcome Synchronization (US-07-04)

Approved outcomes are written to the merchant's WooCommerce store, and the local result is kept apart from whether the store has it. It ships dark behind `WOOCOMMERCE_OUTCOME_SYNC_ENABLED`. Behavior comes from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), sections 5 and 8, and its US-07-04 amendment. Nothing shared was changed: the outcome contract, the registry, `commerce_outcome_syncs`, the retry worker and policy, the retry endpoint and the processor's `order.update` routing are the ones described under [EasyOrders Outcome Synchronization](#easyorders-outcome-synchronization-us-06-04).

**Mapping (`woocommerce-outcome.mapping.ts`).**

| Akeed action | Store effect |
| --- | --- |
| `customer_confirmation` (the customer's reply, or the merchant confirming in Akeed) | The meta entry `akeed_outcome` = `<action>:<verification id>` and one internal order note with a fixed text. No status change. |
| `customer_cancellation`, `merchant_no_reply_cancellation` | `status: cancelled` and the marker, in one update. No note. |
| `automatic_no_reply_tagging`, `merchant_cancellation_tagging` | None: `unsupported` / `capability_not_supported`, and no request. |

It never sends `processing`, `completed`, `refunded` or `set_paid`. With the switch off the adapter has no capability, so every action is `unsupported`.

**Adapter (`WooCommerceOutcomeAdapter`), per outcome.** Every call is built from the stored canonical store URL and decrypted keys of the order's own integration (`findByIntegration(integrationId, orgId)`), and goes through the restricted outbound client.

1. Read `GET /wp-json/wc/v3/orders/<id>`. The answer is taken only when its `id` is the one asked for and its `_links.self[0].href` is exactly that order's address under the canonical store URL; otherwise `store_unverified` and nothing is written.
2. Decide from the read. A cancellation on an order already `cancelled`, or a confirmation whose marker is there, is `applied` with no request. A status other than `processing` or `on-hold` (terminal, custom, unreadable) is `remote_state_conflict` and is not overwritten. A cancellation's marker on an order that is no longer cancelled is a conflict too: the merchant reopened it.
3. Write one `PUT` with the marker and, for a cancellation, the status. Success is what the answer shows, not that there was one.
4. For a confirmation, and only when the read in step 1 showed no marker, add one note (`POST …/notes`, `customer_note: false`). A note that fails is logged (`woocommerce-outcome-note`) and never tried again; a repeat sees the marker and adds none.
5. A timeout, a broken connection, a `5xx`, or a `2xx` that does not show the write is ambiguous: the order is read back. Marker shown: `applied`. Still writable without it: `write_unconfirmed`, retried. Anything else: `remote_state_conflict`.

| Answer | Result |
| --- | --- |
| `401` | `source_credentials_rejected`, needs assistance; `woocommerce_connections.health` = `credentials_rejected` |
| `403` | `source_permission_denied`, needs assistance; health = `permission_denied` |
| `404` on the order | `order_not_found` |
| `400` or another `4xx` on the write | `remote_rejected` |
| `405` or `501` on the write | `store_write_method_refused`, needs assistance |
| `429` | retried, `source_rate_limited`; `Retry-After` becomes `retryAfterMs` |
| `503` | retried, `source_unavailable`; `Retry-After` becomes `retryAfterMs` |
| Another `5xx`, a timeout or a network failure on a read | retried, `source_unavailable` |
| Refused by the restricted client (address not public, redirect, TLS, oversized answer to a read) | `store_unreachable`, needs assistance |

A successful read sets the health back to `ok`. There is no rate limiter.

**Update events (`WooCommerceOrderUpdateHandler`).** An `order.updated` delivery for an order Akeed already has is looked up under the integration the URL token resolved to (`order_not_owned` if this integration has no such order). It is `reflected_outcome` when the delivered `meta_data` carries the marker of an outcome recorded for that order in any state but `unsupported`, **and** the delivered status is one that write could have left (`cancelled` for a cancellation, `processing` or `on-hold` for a confirmation). Anything else is `remote_status_observed`. The marker stays on the order, so without the status test every later change by the merchant would be called a reflection. Neither writes to the store, changes a verification or starts one.

**Logs.** `woocommerce-outcome-sync` (`errorCode`, `providerStatus`), `woocommerce-outcome-note`, and the shared `commerce-outcome-dispatch`, `commerce-outcome-sync-retry` and `webhook-order-update-handle`. None carries a key or a payload.

**Validate.** `scripts/test-woocommerce-outcome-sync-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/woocommerce`.

## WooCommerce Setup, Health and Disconnect (US-07-05)

No switch of its own. Behavior comes from the [US-07-01 contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md), sections 3 and 7, and its US-07-05 amendment. Operations: the [runbook](Epics/07-woocommerce-integration/evidence/US-07-05-disconnect-and-support-runbook.md).

**Setup (`WooCommerceSetupContributor`).** Registered in `SOURCE_SETUP_CONTRIBUTORS` next to the EasyOrders one. `describe` reads the connection row alone and never calls a store: the store, the last credential answer, refused deliveries and the last webhook states. Currency and phone country are reported as null and never block: every order carries its own. Reasons: `source_disconnected`, or `credentials_rejected` (a `401` or a `403`) and `webhook_disabled`.

**Webhook state (`WooCommerceConnectionHealthService`).** There is no background poll. Both webhooks are read from the store (`GET /wp-json/wc/v3/webhooks/<id>`) when `GET /api/settings/source-health` is read (the contributor's `inspectWebhooks`), on a connection check and before a re-enable. States: `active`, `paused`, `disabled`, `missing` (a `404`), `unknown` (the store could not be asked). A definite state is stored on `woocommerce_connections` as the last one read; what the store said of the keys is stored as `health`.

| Route (session auth) | Who | What |
| --- | --- | --- |
| `POST /api/woocommerce/connection/check` | owner, admin | `200` with the codes found: address, TLS, REST, keys, permission, `home_url` mismatch, and each webhook problem |
| `POST /api/woocommerce/connection/webhooks/enable` | owner, admin | Sets each `disabled` webhook to `active` and reads it again. Needs `WOOCOMMERCE_INGESTION_ENABLED` |
| `DELETE /api/woocommerce/connection` | owner, admin | Disconnect. Not gated by the connect switch or the pilot list |

**Disconnect.** One transaction (`WooCommerceConnectionsRepository.disconnect`, in `withSerializableRetry`): retire open installs, lock the organization and the connection, set `integrations.is_active = false`, wipe the three ciphertexts, the token hash, the webhook ids and the verified slot, stamp `disconnected_at`. Then the two webhooks are deleted at the store with the keys that transaction read, best effort, and waiting `commerce_outcome_syncs` rows are closed as `integration_inactive`. The answer carries `webhookCleanup`: `removed`, `failed` or `not_attempted`. Queued events, messages and store updates rely on the existing `is_active` guards; the outcome adapter and the normalizer also refuse a disconnected connection themselves.

**Reconnect.** Through `POST /api/woocommerce/install` and the callback. Allowed only when the organization's one source is its own disconnected WooCommerce source and the canonical store URL is the one that was connected (`409 WOOCOMMERCE_RECONNECT_STORE_MISMATCH` otherwise, before any request leaves). The integration and connection rows are updated in place; the callback deletes every webhook at the store that delivers to Akeed before it creates the two new ones; `connected_at` moves to the reconnect.

**Logs.** `woocommerce-disconnect` (`webhookCleanup`, `closedPendingSyncs`), `woocommerce-disconnect-webhook-cleanup`, `woocommerce-connection-check` (`problems`), `woocommerce-webhook-read`, `woocommerce-webhook-enable`, and `woocommerce-install-callback` (`reconnected`). Each names the store by host only.

**Validate.** `scripts/test-woocommerce-connection-contract.ps1`, `scripts/test-woocommerce-ingestion-contract.ps1`, `scripts/test-woocommerce-outcome-sync-contract.ps1` (disposable Postgres), `npx jest src/infrastructure/spokes/woocommerce`.

## Server API Guide (US-05-05)

The integrator-facing guide for `POST /api/v1/orders` is public: `akeed-frontend/content/docs/en/server-api.md` (`/en/docs/server-api`), with a short Arabic overview at `content/docs/ar/server-api.md`. Settings → API keys links to it and shows the endpoint address.

**One fixture, three readers.** `test/fixtures/order-api/guide-examples.json` holds every example, the field limits, the request limits and the error-code table.

| Reader | What it does with the fixture |
| --- | --- |
| `test/order-api-guide.contract-spec.ts` | Runs each example over real HTTP against PostgreSQL with a key issued for the test, and asserts the status, the body key for key, the message, `Retry-After` and the number of WhatsApp messages the example leads to. It also checks the documented limits against `parseOrderApiConfig({})`, the field lengths and required fields against the real DTO, and the currency list against `CANONICAL_ORDER_CURRENCIES`. |
| `scripts/order-api-guide.js` | Renders the guide's `Field reference`, `Limits`, `Examples` and `Error Codes` sections from the fixture. |
| `scripts/order-api-guide.js --check` | Fails when those sections differ from the fixture, when a code block in the hand-written part is not one of the tested examples, or when the guide names an error code the fixture does not document. |

An error code that a healthy instance cannot produce (`API_INTERNAL_ERROR`, the two 503 codes, the plan and entitlement codes) has no example. Its fixture entry names the suite that proves it in `provenBy`, and the contract suite checks that the file exists and contains the code.

**Changing the API contract.** Change the fixture first, then run `npm run docs:order-api-guide` and the contract suite. `scripts/test-order-api-contract.ps1` runs the check before the tests, so a guide that drifted fails the gate. A change that would break an integrator needs a new API version, not an edited example.

The check reads the sibling frontend repo (`../akeed-frontend`, or `ORDER_API_GUIDE_FRONTEND_ROOT`), like `scripts/check-e045-locale-parity.js`.

## API Reference

### Shopify Webhooks (Inbound)

| Method | Endpoint                                     | Auth               | Purpose                      |
| ------ | -------------------------------------------- | ------------------ | ---------------------------- |
| `POST` | `/webhooks/shopify/orders-create`            | `ShopifyHmacGuard` | New order ingestion.         |
| `POST` | `/webhooks/shopify/app-subscriptions-update` | `ShopifyHmacGuard` | Billing status change.       |
| `POST` | `/webhooks/shopify/uninstalled`              | `ShopifyHmacGuard` | App uninstall cleanup.       |
| `POST` | `/webhooks/shopify/customers/data_request`   | `ShopifyHmacGuard` | GDPR data export request.    |
| `POST` | `/webhooks/shopify/customers/redact`         | `ShopifyHmacGuard` | GDPR customer data deletion. |
| `POST` | `/webhooks/shopify/shop/redact`              | `ShopifyHmacGuard` | GDPR shop data deletion.     |

### WhatsApp Webhooks (Inbound)

| Method | Endpoint             | Auth                    | Purpose                                       |
| ------ | -------------------- | ----------------------- | --------------------------------------------- |
| `GET`  | `/webhooks/whatsapp` | `WA_VERIFY_TOKEN` check | Meta subscription verification challenge.     |
| `POST` | `/webhooks/whatsapp` | `MetaWebhookSignatureGuard` (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body, timing-safe) | Customer replies and delivery status updates. |

### Outbound API Calls

| Target                | Endpoint                                           | Purpose                           |
| --------------------- | -------------------------------------------------- | --------------------------------- |
| Meta Cloud API        | `POST graph.facebook.com/v24.0/{phoneId}/messages` | Send WhatsApp template messages.  |
| Shopify Admin GraphQL | `POST {shop}/admin/api/2026-01/graphql.json`       | Tags, cancel, billing, shop name. |

## Environment Variables

| Variable                       | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `REDIS_URL`                    | BullMQ queue backend (default: `redis://localhost:6379`). |
| `WA_PHONE_NUMBER_ID`           | WhatsApp Cloud API phone number ID.                       |
| `WA_ACCESS_TOKEN`              | WhatsApp Cloud API bearer token.                          |
| `WA_VERIFY_TOKEN`              | Meta webhook subscription verification token.             |
| `SHOPIFY_API_KEY`              | Shopify app API key.                                      |
| `SHOPIFY_API_SECRET`           | Shopify HMAC signing secret.                              |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for access token encryption at rest.      |
| `SHOPIFY_API_VERSION`          | Shopify Admin API version (default: `2026-01`).           |

## Data Model

### Key Tables

| Table                       | Role                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `webhook_events`            | Audit log and deduplication for inbound webhooks.                |
| `orders`                    | Normalized order records from all platforms.                     |
| `verifications`             | Verification lifecycle records (status, timestamps, metadata).   |
| `integrations`              | Platform connections with automation settings and billing state. |
| `integration_monthly_usage` | Billing slot tracking per rolling 30-day period.                 |

### Integration Automation Fields

| Column                     | Type    | Default       | Purpose                               |
| -------------------------- | ------- | ------------- | ------------------------------------- |
| `is_auto_verify_enabled`   | boolean | `true`        | Master switch for COD verification.   |
| `send_delay_minutes`       | int     | `0`           | Delay before initial WhatsApp send.   |
| `follow_up_enabled`        | boolean | `true`        | Enable follow-up reminders.           |
| `follow_up_delay_minutes`  | int     | `120`         | Delay before follow-up (minutes).     |
| `escalation_enabled`       | boolean | `true`        | Enable no-reply escalation.           |
| `escalation_delay_minutes` | int     | `360`         | Delay before escalation (minutes).    |
| `quiet_hours_enabled`      | boolean | `false`       | Suppress sends during off-hours.      |
| `quiet_hours_start`        | text    | —             | Quiet window start (HH:mm).           |
| `quiet_hours_end`          | text    | —             | Quiet window end (HH:mm).             |
| `timezone`                 | text    | `Asia/Riyadh` | Timezone for quiet-hours calculation. |

### Verification Metadata (JSONB)

The `metadata` column on verifications stores operational notes:

| Key                    | When set                                     |
| ---------------------- | -------------------------------------------- |
| `initial_send_skipped` | Auto-verify disabled or eligibility failed.  |
| `follow_up_failed`     | Follow-up WhatsApp send failed.              |
| `follow_up_skipped`    | Follow-up skipped (terminal status reached). |
| `plan_limit_reached`   | Send blocked by billing plan limit.          |

## Reliability And Safety

### Idempotency

- Webhook events are deduplicated by `(platform, idempotency_key)` unique constraint with `ON CONFLICT DO NOTHING`.
- BullMQ jobs use deterministic job IDs (`{platform}-{idempotencyKey}` for webhooks, `verification-{id}-{action}` for automation).
- `handleNewOrder` checks for existing verification before creating a new one.

### Retry Strategy

- Webhook processing: 5 attempts with exponential backoff (3s base → ~48s max).
- After 5 failures, the webhook event is marked as `failed` with the error message.
- Quiet-hours delays use `DelayedError` to reschedule jobs rather than failing them.

### Ordering Guarantees

- Escalation always fires after follow-up: if follow-up hasn't completed yet, escalation reschedules itself +60s.
- Follow-up delay is validated to be less than escalation delay (cross-field validation in settings).
- Initial send delay, follow-up delay, and escalation delay are all adjusted for quiet-hours windows.

### Error Isolation

- Shopify webhook ingestion returns 200 immediately; processing failures don't cause Shopify retries that could lead to duplicate processing.
- Shopify order tagging is best-effort: failures are logged but don't fail the verification action.
- WhatsApp send failures release billing reservations and mark verifications as `failed`.
- Billing reservation is atomic (database-level increment).

### Security

- All Shopify webhooks are HMAC-verified with `crypto.timingSafeEqual`.
- Shopify access tokens are encrypted at rest (AES-256-GCM).
- WhatsApp API tokens are stored as environment variables, never logged.
- GDPR handlers normalize phone numbers for comprehensive data lookup.
- Error logging captures safe context (verification ID, template name) without exposing secrets or tokens.

## Known Business Decisions

- Webhook ingestion is designed as a thin fast path: accept and return 200, process asynchronously. This prevents Shopify from retrying webhooks due to slow processing.
- The `WEBHOOK_ORDER_NORMALIZERS` multi-token pattern was chosen to support future e-commerce platforms (Salla, WooCommerce, Zid) without modifying the queue processor.
- COD detection uses multiple signal sources (payment method, gateway names, transactions) because Shopify stores don't consistently populate a single field.
- Arabic COD patterns are included because many MENA merchants use Arabic gateway names.
- Language auto-detection from phone country code is used as the default because merchants serve mixed-language customer bases.
- WhatsApp template variants (standard, egyptian, gulf, short, friendly, professional, direct) were designed for regional personalization across MENA markets.
- The `DelayedError` pattern for quiet-hours avoids consuming retry attempts and keeps the job in the delayed state until the quiet window ends.
- Billing webhook handling ignores status changes for non-current subscriptions to prevent failed upgrade attempts from disrupting active billing.
- Test orders (`akeed-test-*`) skip all Shopify API calls (tagging, cancellation) to avoid affecting real store data.
- Customer replies are blocked if the merchant has already canceled the order (`merchant_canceled_at` check) to prevent race conditions.

## Validation Commands

Backend:

```bash
npm --prefix akeed-backend run lint
npm --prefix akeed-backend run test
npm --prefix akeed-backend run build
```

## Recommended Test Scenarios

| Scenario                                               | Expected result                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Shopify orders-create webhook with valid HMAC          | 200 OK, webhook event created, job enqueued.                                            |
| Duplicate orders-create webhook (same idempotency key) | 200 OK with `duplicate: true`, no re-enqueue.                                           |
| orders-create webhook with invalid HMAC                | 401 Unauthorized.                                                                       |
| Queue processes COD order                              | Eligibility passes, billing reserved, verification created, WhatsApp sent.              |
| Queue processes non-COD order                          | Eligibility fails, verification skipped.                                                |
| Queue processes order when plan limit reached          | Billing reservation fails, verification marked `failed`.                                |
| Queue processes order with sendDelayMinutes > 0        | Verification created as `pending`, delayed INITIAL_SEND job enqueued.                   |
| Delayed INITIAL_SEND fires during quiet hours          | Job rescheduled to quiet-hours end via `DelayedError`.                                  |
| Follow-up fires after customer already confirmed       | Follow-up skipped (terminal status check).                                              |
| Escalation fires before follow-up completes            | Escalation reschedules itself +60s.                                                     |
| Escalation fires normally                              | Verification marked `no_reply`, Shopify order tagged `Akeed: No Reply`.                 |
| Customer confirms via WhatsApp                         | Verification updated to `confirmed`, Shopify order tagged `Akeed: Verified`.            |
| Customer cancels via WhatsApp                          | Verification updated to `canceled` with `cancellationSource: 'customer'`, order tagged. |
| Customer replies after merchant canceled               | Reply blocked (merchant_canceled_at check).                                             |
| WhatsApp delivery status update (delivered/read)       | Verification timestamps updated.                                                        |
| WhatsApp send failure                                  | Billing reservation released, verification marked `failed`.                             |
| APP_SUBSCRIPTIONS_UPDATE with status active            | Integration billing status updated to `active`.                                         |
| APP_SUBSCRIPTIONS_UPDATE for non-current subscription  | Webhook ignored (smart filtering).                                                      |
| APP_UNINSTALLED webhook                                | Integration disabled, credentials cleared, billing cancelled, lifecycle closed.         |
| GDPR customer data request                             | Orders + verifications exported for the customer.                                       |
| GDPR customer redact                                   | All customer data deleted.                                                              |
| GDPR shop redact                                       | All store data deleted.                                                                 |
| Meta webhook verification challenge                    | Returns `hub.challenge` if token matches.                                               |
| Meta webhook with wrong verify token                   | 403 Forbidden.                                                                          |
| 5 consecutive job failures                             | Webhook event marked `failed` with error message.                                       |
| Test order (akeed-test-\*) escalation                  | Shopify tagging skipped.                                                                |
