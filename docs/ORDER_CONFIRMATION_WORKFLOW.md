# Order Confirmation Workflow And Controls

Last updated: 2026-04-30

## Purpose

This document explains the Akeed cash-on-delivery order confirmation feature from a business perspective. It covers the order lifecycle, merchant controls, backend services, frontend screens, data model, API contracts, and operational behavior.

The feature verifies COD Shopify orders through WhatsApp before the merchant fulfills the order. Customers can confirm or cancel from a WhatsApp template. If they do not reply, Akeed can escalate the order to `no_reply`, tag the Shopify order, and let the merchant cancel it from the Akeed dashboard.

## Scope

In scope:

- Shopify `orders-create` webhook ingestion.
- COD eligibility filtering.
- Auto-verification enable/disable control.
- Initial WhatsApp verification message.
- Optional delayed initial send.
- Optional follow-up message.
- Quiet-hours scheduling.
- No-reply escalation.
- Customer confirm/cancel replies.
- Shopify order tagging.
- Merchant cancellation for `no_reply` orders.
- Dashboard KPIs, filters, actions, and settings controls.
- Billing usage consumption for verification sends.

Out of scope:

- Creating Shopify orders before checkout submission.
- Automatically canceling Shopify orders on a customer cancel reply. The current customer cancel flow marks and tags the order, but does not call Shopify order cancellation.
- Multi-platform order support beyond the currently implemented Shopify strategy.

## Lifecycle States

| Status      | Meaning                                                                            | Main writer                                         |
| ----------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pending`   | Verification record exists, but the first WhatsApp template has not been sent yet. | `VerificationHubService`                            |
| `sent`      | Initial WhatsApp verification template was sent successfully.                      | `VerificationSendService`                           |
| `delivered` | Meta reported delivery for the current WhatsApp message id.                        | `WhatsAppWebhookService`                            |
| `read`      | Meta reported the message was read.                                                | `WhatsAppWebhookService`                            |
| `confirmed` | Customer pressed the confirm button.                                               | `WhatsAppWebhookService`                            |
| `canceled`  | Customer canceled or merchant canceled after no reply.                             | `WhatsAppWebhookService`, `VerificationsService`    |
| `no_reply`  | Customer did not respond before the escalation job fired.                          | `VerificationAutomationProcessor`                   |
| `failed`    | Initial send failed or plan limit blocked the initial send.                        | `VerificationSendService`, `VerificationHubService` |
| `expired`   | Reserved enum value for lifecycle compatibility.                                   | Not actively automated in this workflow             |

Protected behavior:

- Terminal statuses `confirmed` and `canceled` are not overwritten by later status webhooks.
- `no_reply` is protected from late delivery/read/failed webhooks.
- A customer reply can still override `no_reply` if the merchant has not already canceled the order.
- If `merchantCanceledAt` is set, later customer replies are ignored.

## Merchant Controls

Controls are edited from the Settings page and persisted on the `integrations` table through `PATCH /api/onboarding/settings`.

| Control                  |            Default | Validation                                 | Business behavior                                                                                                     |
| ------------------------ | -----------------: | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `isAutoVerifyEnabled`    |             `true` | Boolean                                    | If disabled, new eligible COD orders are not stored or verified by `handleNewOrder`.                                  |
| `sendDelayMinutes`       |                `0` | `0..1440`                                  | Delays the initial WhatsApp send. Billing is not consumed until the delayed send executes.                            |
| `followUpEnabled`        |             `true` | Boolean                                    | Enables one follow-up message when the customer has not replied.                                                      |
| `followUpDelayMinutes`   |              `120` | `0..10080`                                 | Follow-up delay from the initial successful send time. Must be lower than escalation delay when follow-up is enabled. |
| `escalationDelayMinutes` |              `360` | `0..10080`                                 | No-reply escalation delay from the initial successful send time. `0` disables escalation scheduling.                  |
| `quietHoursEnabled`      |            `false` | Boolean                                    | When enabled, delayed automation jobs are moved outside quiet hours.                                                  |
| `quietHoursStart`        | UI default `21:00` | `HH:mm`, required when quiet hours enabled | Start of quiet-hours window in the configured timezone.                                                               |
| `quietHoursEnd`          | UI default `09:00` | `HH:mm`, required when quiet hours enabled | End of quiet-hours window in the configured timezone.                                                                 |
| `timezone`               |      `Asia/Riyadh` | Allowlist in `AUTOMATION_TIMEZONES`        | Timezone used for quiet-hours calculations.                                                                           |
| `defaultLanguage`        |             `auto` | `auto`, `en`, `ar`                         | WhatsApp template language. `auto` resolves Arabic for Arabic-region phone prefixes and English otherwise.            |
| `shippingCurrency`       |              `USD` | Allowlist                                  | Used for dashboard savings display, not verification routing.                                                         |
| `avgShippingCost`        |                `3` | Number `>= 0`, max 2 decimals              | Used for dashboard money-saved KPI.                                                                                   |

Cross-field rules:

- If follow-up is enabled, `followUpDelayMinutes < escalationDelayMinutes`.
- If quiet hours are enabled, both `quietHoursStart` and `quietHoursEnd` are required.
- Frontend validation mirrors backend validation before calling the API.

## Backend Code Map

| Area                          | File                                                                                        | Responsibility                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify webhook controller    | `akeed-backend/src/infrastructure/spokes/shopify/shopify.controller.ts`                     | Receives `POST /webhooks/shopify/orders-create` and verifies Shopify HMAC through `ShopifyHmacGuard`.                                         |
| Shopify webhook ingestion     | `akeed-backend/src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts` | Fast path that persists/enqueues the webhook and returns `200`.                                                                               |
| Webhook queue processor       | `akeed-backend/src/modules/webhook-queue/webhook-queue.processor.ts`                        | Loads integration, normalizes order, and calls core verification logic.                                                                       |
| Shopify order normalizer      | `akeed-backend/src/modules/webhook-queue/normalizers/shopify-order.normalizer.ts`           | Extracts customer phone, order number, total, currency, and payment method from raw Shopify payload.                                          |
| COD eligibility               | `akeed-backend/src/modules/verification-core/order-eligibility.service.ts`                  | Dispatches platform-specific eligibility strategy.                                                                                            |
| Core orchestration            | `akeed-backend/src/modules/verification-core/verification-hub.service.ts`                   | Handles and validates new orders, idempotency, delayed initial sends, immediate sends, follow-up/no-reply scheduling, and final Shopify tags. |
| WhatsApp sending              | `akeed-backend/src/modules/verification-core/verification-send.service.ts`                  | Reserves billing usage, sends the WhatsApp template, marks initial status, and releases usage on send failure.                                |
| Automation producer           | `akeed-backend/src/modules/verification-automation/verification-automation.producer.ts`     | Enqueues deterministic BullMQ jobs for initial, follow-up, and no-reply automation.                                                           |
| Automation worker             | `akeed-backend/src/modules/verification-automation/verification-automation.processor.ts`    | Executes delayed initial sends, follow-ups, quiet-hours rescheduling, and no-reply escalation.                                                |
| WhatsApp adapter              | `akeed-backend/src/infrastructure/spokes/meta/whatsapp.service.ts`                          | Sends the `akeed_cod_verification` Meta template with confirm/cancel quick-reply payloads.                                                    |
| WhatsApp webhook              | `akeed-backend/src/infrastructure/spokes/meta/whatsapp.webhook.service.ts`                  | Handles customer button replies and delivery/read/failed status webhooks.                                                                     |
| Dashboard/verifications API   | `akeed-backend/src/modules/verifications/verifications.controller.ts`                       | Exposes stats, list, test send, and merchant no-reply cancellation endpoint.                                                                  |
| Merchant cancellation service | `akeed-backend/src/modules/verifications/verifications.service.ts`                          | Cancels no-reply Shopify orders and updates local verification state.                                                                         |
| Settings API                  | `akeed-backend/src/modules/onboarding/onboarding.controller.ts`                             | Exposes onboarding/settings state and updates.                                                                                                |
| Settings business rules       | `akeed-backend/src/modules/onboarding/onboarding-state.service.ts`                          | Persists merchant controls and enforces cross-field validation.                                                                               |

## Frontend Code Map

| Area                        | File                                                                                           | Responsibility                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Dashboard hook              | `akeed-frontend/src/features/dashboard/domain/useDashboard.ts`                                 | Loads stats/list data, handles filters, test sends, and cancel-order UI state.                      |
| Dashboard standalone skin   | `akeed-frontend/src/features/dashboard/skins/standalone/DashboardStandaloneSkin.tsx`           | Standalone dashboard page composition.                                                              |
| Dashboard embedded skin     | `akeed-frontend/src/features/dashboard/skins/embedded/DashboardEmbeddedSkin.tsx`               | Shopify embedded dashboard page composition.                                                        |
| Stats cards                 | `akeed-frontend/src/features/dashboard/skins/standalone/components/StandaloneStatsSummary.tsx` | Displays confirmed, canceled, awaiting response, reply rate, confirmation rate, usage, and savings. |
| Verification table          | `akeed-frontend/src/features/dashboard/skins/standalone/VerificationsTableStandalone.tsx`      | Shows verification rows and no-reply cancel action in standalone mode.                              |
| Embedded verification table | `akeed-frontend/src/features/dashboard/skins/embedded/VerificationsTableEmbedded.tsx`          | Shows verification rows and no-reply cancel action in embedded mode.                                |
| Settings hook               | `akeed-frontend/src/features/settings/domain/useSettings.ts`                                   | Loads/saves merchant controls, validates values, and handles billing plan actions.                  |
| Settings standalone skin    | `akeed-frontend/src/features/settings/skins/standalone/SettingsStandaloneSkin.tsx`             | Standalone settings UI and message preview.                                                         |
| Settings embedded skin      | `akeed-frontend/src/features/settings/skins/embedded/SettingsEmbeddedSkin.tsx`                 | Polaris settings UI and message preview.                                                            |
| Message preview             | `akeed-frontend/src/features/message-preview/`                                                 | Shows English/Arabic verification template preview.                                                 |
| API/auth wrapper            | `akeed-frontend/src/shared/lib/auth.ts`                                                        | Sends authenticated backend requests in standalone and embedded modes.                              |

## API Reference

| Method  | Endpoint                          | Auth                 | Purpose                                              |
| ------- | --------------------------------- | -------------------- | ---------------------------------------------------- |
| `POST`  | `/webhooks/shopify/orders-create` | Shopify HMAC         | Ingest Shopify order creation webhook.               |
| `GET`   | `/webhooks/whatsapp`              | Verify token query   | Meta webhook verification challenge.                 |
| `POST`  | `/webhooks/whatsapp`              | Meta webhook payload | Receive WhatsApp replies and message status events.  |
| `GET`   | `/api/onboarding/state`           | `DualAuthGuard`      | Load current integration controls and billing state. |
| `PATCH` | `/api/onboarding/settings`        | `DualAuthGuard`      | Update merchant controls.                            |
| `GET`   | `/api/onboarding/billing/plans`   | `DualAuthGuard`      | Load Shopify billing plan options.                   |
| `POST`  | `/api/onboarding/billing`         | `DualAuthGuard`      | Start Shopify billing flow.                          |
| `GET`   | `/api/verifications`              | `DualAuthGuard`      | List verification rows for the dashboard.            |
| `GET`   | `/api/verifications/stats`        | `DualAuthGuard`      | Load dashboard KPIs.                                 |
| `POST`  | `/api/verifications/test`         | `DualAuthGuard`      | Send a test verification message.                    |
| `POST`  | `/api/verifications/:id/cancel`   | `DualAuthGuard`      | Merchant cancellation for `no_reply` verifications.  |

## Data Model Reference

Primary tables:

| Table            | Important fields                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations`   | `platformType`, `platformStoreUrl`, `accessToken`, `isActive`, `storeName`, `defaultLanguage`, `shippingCurrency`, `avgShippingCost`, `isAutoVerifyEnabled`, `billingPlanId`, `billingStatus`, `followUpEnabled`, `followUpDelayMinutes`, `escalationDelayMinutes`, `quietHoursEnabled`, `quietHoursStart`, `quietHoursEnd`, `timezone`, `sendDelayMinutes` |
| `orders`         | `orgId`, `integrationId`, `externalOrderId`, `orderNumber`, `customerPhone`, `customerName`, `totalPrice`, `currency`, `paymentMethod`, `rawPayload`                                                                                                                                                                                                        |
| `verifications`  | `orgId`, `orderId`, `status`, `waMessageId`, `templateName`, `languageCode`, `attempts`, `lastSentAt`, `confirmedAt`, `canceledAt`, `deliveredAt`, `readAt`, `followUpSentAt`, `noReplyAt`, `followUpAttempts`, `merchantCanceledAt`, `cancellationSource`, `metadata`                                                                                      |
| `webhook_events` | `platform`, `jobType`, `idempotencyKey`, `storeDomain`, `orgId`, `integrationId`, `status`, `rawPayload`, `attempts`, `lastError`, `processedAt`                                                                                                                                                                                                            |

Important constraints and indexes:

- `unique_active_verification_per_order` prevents duplicate verification rows per order.
- `idx_verifications_org_created_id` supports dashboard pagination.
- `idx_verifications_org_created_status` supports dashboard status/date filtering.
- `idx_verifications_wa_id` supports Meta status webhook lookup by `waMessageId`.
- `webhook_events` has unique idempotency per platform webhook id.

## Billing And Usage Rules

Plan limits are defined in `akeed-backend/src/modules/onboarding/onboarding.service.helpers.ts`.

| Plan               | Monthly price | Included WhatsApp confirmations | Public positioning                     |
| ------------------ | ------------: | ------------------------------: | -------------------------------------- |
| Starter            |           `0` |                   `30` one-time | Try Akeed before paying                |
| Basic              |        `8.99` |                   `300` monthly | Start confirming COD orders            |
| Pro                |       `22.99` |                  `1000` monthly | For stores confirming COD orders daily |
| Scale (`business`) |       `44.99` |                  `2500` monthly | Higher-volume COD stores               |

Usage principles:

- Usage is consumed when a WhatsApp send is attempted, not when a verification row is created.
- Delayed initial sends consume only when the delayed worker sends the message.
- Failed sends release the usage reservation.
- Follow-up messages consume included monthly confirmations.
- Follow-up failure does not fail the overall verification.
- Dashboard usage shows consumed count and included limit for the current billing period.
- Plans have no usage-based Shopify billing line item; when the included limit is reached, sending stops until renewal or upgrade.

## Reliability And Safety

Idempotency:

- Shopify webhook id is persisted through `webhook_events`.
- Order creation is deduped by external order id and organization.
- Verification creation is constrained to one row per order.
- Automation jobs use deterministic job ids.
- Merchant cancellation is idempotent for already merchant-canceled rows.

Security:

- Shopify webhooks are protected by `ShopifyHmacGuard`.
- Authenticated app APIs use `DualAuthGuard` for embedded Shopify and standalone modes.
- Shopify access tokens are decrypted only inside the Shopify adapter.
- Logs must not include secrets or access tokens.

Operational behavior:

- Shopify order webhooks return quickly and defer business processing to BullMQ.
- BullMQ retries webhook and automation jobs with exponential backoff.
- Quiet hours are checked both when scheduling and when the worker executes.
- If BullMQ cannot move a job to delayed due to a missing token, the worker logs and processes immediately for quiet-hours cases.

## Known Business Decisions

- Only COD orders are verified.
- Disabling auto verification skips new verification creation entirely.
- Customer cancel does not automatically cancel the Shopify order; it marks and tags the order for merchant awareness.
- Merchant order cancellation is available only after `no_reply` escalation.
- Shopify cancellation is called before local state is changed.
- `no_reply` is excluded from customer reply rate numerator unless the customer later replies before merchant cancellation.
- Tagging failures after irreversible actions are logged but do not fail the completed action.

## Validation Commands

Backend:

```bash
npm --prefix akeed-backend run lint
npm --prefix akeed-backend run test
npm --prefix akeed-backend run build
```

Frontend:

```bash
npm --prefix akeed-frontend run lint
npm --prefix akeed-frontend exec tsc --noEmit
npm --prefix akeed-frontend run build
```

Note: frontend production build can fail in restricted environments if Google Fonts cannot be fetched. In that case, lint and typecheck are still useful code validation signals.

## Recommended Test Scenarios

Manual end-to-end scenarios:

| Scenario                                                      | Expected result                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Non-COD Shopify order                                         | Webhook is accepted, order is skipped, no verification is created.                                                                       |
| COD order with auto verify disabled                           | Webhook is accepted, verification is skipped with reason `auto_verify_disabled`.                                                         |
| COD order with immediate send                                 | Verification becomes `sent`, WhatsApp message is delivered to customer, follow-up/no-reply jobs are scheduled.                           |
| Customer confirms                                             | Verification becomes `confirmed`, Shopify order is tagged `Akeed: Verified`.                                                             |
| Customer cancels                                              | Verification becomes `canceled`, `cancellationSource = customer`, Shopify order is tagged `Akeed: Canceled`.                             |
| Follow-up enabled and no reply                                | One follow-up is sent, `followUpAttempts` increments.                                                                                    |
| No reply after escalation delay                               | Verification becomes `no_reply`, Shopify order is tagged `Akeed: No Reply`.                                                              |
| Merchant cancels no-reply order                               | Shopify order is canceled, verification becomes `canceled`, `cancellationSource = merchant_no_reply`, order is tagged `Akeed: Canceled`. |
| Late delivery/read after no-reply                             | Status stays `no_reply`.                                                                                                                 |
| Late customer reply after no-reply but before merchant cancel | Status can become `confirmed` or customer `canceled`.                                                                                    |
| Late customer reply after merchant cancel                     | Reply is ignored.                                                                                                                        |
