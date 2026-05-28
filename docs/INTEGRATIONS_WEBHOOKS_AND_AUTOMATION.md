# Integrations, Webhooks, And Automation Platform

Last updated: 2026-05-28

## Purpose

This document explains how Akeed integrates with external platforms (Shopify, Meta/WhatsApp), processes inbound webhooks, manages asynchronous job queues, and runs the verification automation pipeline. It covers the ingestion path from Shopify order webhook to WhatsApp send, the customer reply flow, follow-up and escalation scheduling, quiet-hours handling, billing entitlement checks, and GDPR compliance webhooks.

For the verification lifecycle state machine and merchant controls, see `ORDER_CONFIRMATION_WORKFLOW.md`.
For dashboard and settings screens, see `MERCHANT_OPERATIONS.md`.
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

Akeed uses a ports-and-adapters architecture to abstract external platform interactions. Core verification logic depends on port interfaces; concrete implementations live in spoke modules.

```
                     ┌──────────────────────────────┐
                     │    Verification Core Module   │
                     │  (Hub, Send, Billing, Eligib) │
                     └──────┬───────┬───────┬───────┘
                            │       │       │
                  ┌─────────┘       │       └──────────┐
                  ▼                 ▼                   ▼
           MessagingPort     OrderAdminPort       OrderTaggingPort
                  │          OrderTaggingPort      StorePlatformPort
                  │                 │
                  ▼                 ▼
           ┌────────────┐   ┌──────────────┐
           │ Meta Spoke  │   │ Shopify Spoke │
           │ (WhatsApp)  │   │ (Admin API)   │
           └────────────┘   └──────────────┘
```

Port binding (configured in `AppModule`):

| Port                  | Provider token      | Implementation      |
| --------------------- | ------------------- | ------------------- |
| `MESSAGING_PORT`      | `WhatsAppService`   | Meta WhatsApp API   |
| `ORDER_ADMIN_PORT`    | `ShopifyApiService` | Shopify GraphQL API |
| `ORDER_TAGGING_PORT`  | `ShopifyApiService` | Shopify GraphQL API |
| `STORE_PLATFORM_PORT` | `ShopifyApiService` | Shopify GraphQL API |

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

Smart filtering: ignores blocked-status webhooks for non-current subscriptions. This prevents a failed upgrade attempt from disabling the active billing on the current plan.

### Uninstall Webhook

`APP_UNINSTALLED` deletes the integration record from the database, effectively deactivating the store.

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

Order normalizers are registered via the `WEBHOOK_ORDER_NORMALIZERS` multi-token, allowing future platforms (Salla, WooCommerce, Zid) to plug in without modifying the processor.

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
2. Parse action: `confirm_{id}` → `confirmed`, `cancel_{id}` → `canceled`.
3. Check if merchant already canceled (`merchant_canceled_at` is set) → skip to prevent customer from overriding merchant action.
4. Update verification status in database.
5. Set `cancellationSource: 'customer'` for customer-initiated cancellations.
6. Call `VerificationHubService.finalizeVerification()` → tags Shopify order.

**Status updates:**

Delivery statuses from Meta (`delivered`, `read`, `failed`) are matched by `waMessageId` and update the verification record.

## Verification Core Pipeline

### Order Eligibility

`OrderEligibilityService` routes to a platform-specific strategy. Currently only `ShopifyOrderEligibilityStrategy` is implemented.

**COD detection:**

The strategy collects payment signals from multiple locations in the order payload:

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

1. Load verification + order + integration.
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
| Basic    | 300                    | $8.99         |
| Pro      | 1,000                  | $22.99        |
| Business | 2,500                  | $44.99        |

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
4. Tag Shopify order with `Akeed: No Reply` (skipped for test orders with `akeed-test-` prefix).

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
- Returns `jobId` if Shopify processes the cancellation asynchronously.

**Billing operations:**

- `createRecurringApplicationCharge()` — GraphQL `appSubscriptionCreate` with usage pricing line items.
- `getAppSubscriptionStatus()` — queries subscription status (`active`, `pending`, etc.).
- `cancelAppSubscription()` — GraphQL `appSubscriptionCancel` with proration.
- `reportUsageCharge()` — GraphQL `appUsageRecordCreate` for overage reporting.

**Shop metadata:**

- `getShopName()` — GraphQL `shop { name }`.

### Error Handling

- GraphQL errors and user validation errors are logged with request IDs from response headers.
- Access tokens are decrypted per-request using `SHOPIFY_TOKEN_ENCRYPTION_KEY`.

## Backend Code Map

| Area                           | File                                                                         | Responsibility                                                              |
| ------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Shopify webhook controller     | `infrastructure/spokes/shopify/shopify.controller.ts`                        | Routes 6 webhook topics to handler services.                                |
| Order webhook service          | `infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts`    | Thin ingestion: dedup + enqueue, returns immediately.                       |
| Billing webhook service        | `infrastructure/spokes/shopify/services/shopify-billing-webhook.service.ts`  | Billing status updates, uninstall handling.                                 |
| GDPR webhook service           | `infrastructure/spokes/shopify/services/shopify-gdpr-webhook.service.ts`     | Data export, customer redact, shop redact.                                  |
| Shopify API service            | `infrastructure/spokes/shopify/services/shopify-api.service.ts`              | GraphQL operations: tags, cancel, billing, shop metadata.                   |
| Shopify order normalizer       | `infrastructure/spokes/shopify/services/shopify-order.normalizer.ts`         | Converts Shopify order JSON to `NormalizedOrder`.                           |
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
| Shopify eligibility strategy   | `modules/verification-core/strategies/shopify-order-eligibility.strategy.ts` | Multi-signal COD payment detection with Arabic support.                     |
| Messaging port                 | `shared/ports/messaging.port.ts`                                             | Interface for template-based messaging.                                     |
| Order admin port               | `shared/ports/order-admin.port.ts`                                           | Interface for order cancellation.                                           |
| Order tagging port             | `shared/ports/order-tagging.port.ts`                                         | Interface for order tag management.                                         |
| Store platform port            | `shared/ports/store-platform.port.ts`                                        | Interface for billing and shop metadata.                                    |
| Phone service                  | `shared/services/phone.service.ts`                                           | Phone number normalization and validation.                                  |

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
| `POST` | `/webhooks/whatsapp` | None (Meta-initiated)   | Customer replies and delivery status updates. |

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
| APP_UNINSTALLED webhook                                | Integration record deleted.                                                             |
| GDPR customer data request                             | Orders + verifications exported for the customer.                                       |
| GDPR customer redact                                   | All customer data deleted.                                                              |
| GDPR shop redact                                       | All store data deleted.                                                                 |
| Meta webhook verification challenge                    | Returns `hub.challenge` if token matches.                                               |
| Meta webhook with wrong verify token                   | 403 Forbidden.                                                                          |
| 5 consecutive job failures                             | Webhook event marked `failed` with error message.                                       |
| Test order (akeed-test-\*) escalation                  | Shopify tagging skipped.                                                                |
