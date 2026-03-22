# Shopify Billing — Implementation Guide

## Overview

Akeed integrates with the **Shopify Billing API** to monetize the app through recurring subscriptions.  
Merchants choose a plan during onboarding; recurring charges and optional usage-based overages are managed entirely through Shopify's infrastructure so Akeed never handles payment details directly.

---

## Plan Definitions

| Plan        | Monthly Price | Included Verifications | Overage Rate | Overage Cap |
| ----------- | ------------- | ---------------------- | ------------ | ----------- |
| **Starter** | $0            | 50                     | —            | —           |
| **Growth**  | $9            | 500                    | $0.03 / ea   | $25         |
| **Pro**     | $15           | 1,000                  | $0.025 / ea  | $45         |
| **Scale**   | $29           | 2,500                  | $0.02 / ea   | $90         |

Plans are defined as compile-time constants in `src/modules/onboarding/onboarding.service.helpers.ts` (`BILLING_PLAN_TEMPLATES`).  
Each plan is resolved at runtime via `BillingConfigService` which injects the configured currency code (`SHOPIFY_BILLING_CURRENCY`) and test mode flag (`SHOPIFY_BILLING_TEST_MODE`).

Paid plans (Growth, Pro, Scale) create a Shopify `AppSubscription` with **two line items**:

1. **Recurring** — fixed monthly charge via `appRecurringPricingDetails` (interval: `EVERY_30_DAYS`).
2. **Usage** — capped overage via `appUsagePricingDetails` with `cappedAmount` and `terms` describing the overage policy.

The Starter plan ($0) bypasses the Shopify Billing API entirely and is activated immediately.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js)                                                     │
│                                                                         │
│  Onboarding Flow              Settings Page                             │
│  ─────────────────            ──────────────                            │
│  BillingStep                  PlanComparison                            │
│    → POST /api/onboarding/billing { planId, host }                      │
│    → receives { confirmationUrl }                                       │
│    → redirects merchant to Shopify approval page                        │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  BACKEND (NestJS)                                                       │
│                                                                         │
│  OnboardingController                                                   │
│    POST  /api/onboarding/billing         → BillingService.initiateBilling()
│    GET   /api/onboarding/billing/plans   → BillingService.getBillingPlans()
│    GET   /api/onboarding/billing/callback → BillingService.handleBillingCallback()
│                                                                         │
│  ShopifyController (webhooks)                                           │
│    POST /webhooks/shopify/app-subscriptions-update                      │
│         → ShopifyBillingWebhookService.handleAppSubscriptionUpdate()    │
│    POST /webhooks/shopify/uninstalled                                   │
│         → ShopifyBillingWebhookService.handleAppUninstalled()           │
│                                                                         │
│  VerificationHub (order processing)                                     │
│    → BillingEntitlementService.reserveVerificationSlot()                 │
│    → IntegrationMonthlyUsageRepository (atomic slot reservation)        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Backend Services

| Service                             | File                                                                               | Responsibility                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `BillingService`                    | `src/modules/onboarding/billing.service.ts`                                        | Subscription lifecycle — initiate, confirm, persist state         |
| `BillingConfigService`              | `src/modules/onboarding/billing-config.service.ts`                                 | Env-driven config — currency, test mode, billing-required flag    |
| `ShopifyBillingWebhookService`      | `src/infrastructure/spokes/shopify/services/shopify-billing-webhook.service.ts`    | Handles `APP_SUBSCRIPTIONS_UPDATE` and `APP_UNINSTALLED` webhooks |
| `BillingEntitlementService`         | `src/modules/verification-core/billing-entitlement.service.ts`                     | Monthly usage metering — reserves/releases verification slots     |
| `ShopifyApiService`                 | `src/infrastructure/spokes/shopify/services/shopify-api.service.ts`                | GraphQL calls to create subscriptions and query status            |
| `IntegrationMonthlyUsageRepository` | `src/infrastructure/database/repositories/integration-monthly-usage.repository.ts` | Atomic DB operations for usage tracking (SELECT FOR UPDATE)       |

---

## Billing Lifecycle

### 1. Plan Selection & Subscription Creation

```
Merchant selects plan in UI
  → Frontend calls POST /api/onboarding/billing { planId: "growth", host: "..." }
    → OnboardingService.initiateBilling()
      → BillingService.initiateBilling()
```

**Three code paths based on plan type:**

| Condition                        | Behavior                                                |
| -------------------------------- | ------------------------------------------------------- |
| `SHOPIFY_BILLING_REQUIRED=false` | Status set to `not_required`, onboarding auto-completes |
| `plan.amount === 0` (Starter)    | Status set to `active`, onboarding auto-completes       |
| `plan.amount > 0` (paid plans)   | Shopify GraphQL `appSubscriptionCreate` mutation called |

For paid plans, the backend:

1. Persists `billingStatus: 'pending'` and `billingPlanId` to the `integrations` table.
2. Calls the Shopify Admin GraphQL API with the `appSubscriptionCreate` mutation.
3. Returns a `confirmationUrl` that the frontend redirects the merchant to.

**GraphQL mutation** (defined in `shopify-api.service.helpers.ts`):

```graphql
mutation CreateAppSubscription(
  $name: String!
  $lineItems: [AppSubscriptionLineItemInput!]!
  $returnUrl: URL!
  $test: Boolean
) {
  appSubscriptionCreate(
    name: $name
    lineItems: $lineItems
    returnUrl: $returnUrl
    test: $test
  ) {
    confirmationUrl
    userErrors {
      field
      message
    }
  }
}
```

The `returnUrl` points to `{API_URL}/api/onboarding/billing/callback?shop={domain}&host={host}`.

### 2. Merchant Approval & Callback

After the merchant approves (or declines) the charge on Shopify's confirmation page:

```
Shopify redirects to → GET /api/onboarding/billing/callback?shop=...&charge_id=...&hmac=...
```

**Guards applied (in order):**

1. `BillingCallbackRateLimitGuard` — In-memory rate limiter (30 req/60s per shop or IP).
2. `ShopifyBillingCallbackValidationGuard` — Validates `shop` format, verifies HMAC signature using `SHOPIFY_API_SECRET`.

**Callback processing** (`BillingService.handleBillingCallback()`):

1. Looks up the integration by shop domain.
2. Queries Shopify for the subscription status via GraphQL:
   ```graphql
   query GetAppSubscriptionStatus($id: ID!) {
     node(id: $id) {
       ... on AppSubscription {
         id
         status
       }
     }
   }
   ```
3. Persists the resolved status and subscription ID.
4. If `status === 'active'` and all onboarding prerequisites are met, marks `onboardingStatus: 'completed'`.
5. Redirects merchant back to the app (`{APP_URL}?shop=...&host=...`).

### 3. Webhook-Driven Status Updates

Shopify sends `APP_SUBSCRIPTIONS_UPDATE` webhooks when subscription status changes (e.g., renewed, cancelled, frozen).

```
POST /webhooks/shopify/app-subscriptions-update
  Headers: x-shopify-hmac-sha256, x-shopify-shop-domain, x-shopify-webhook-id
  Body: { id, status, admin_graphql_api_id }
```

**Protected by:** `ShopifyHmacGuard` — validates the webhook HMAC using raw request body and `SHOPIFY_API_SECRET` via `crypto.timingSafeEqual`.

**Processing** (`ShopifyBillingWebhookService.handleAppSubscriptionUpdate()`):

1. Deduplicates by `webhookId` (stored in `shopify_webhook_events` table).
2. Normalizes the status string (lowercased, trimmed).
3. Updates the `integrations` table:
   - `billingStatus`, `billingStatusUpdatedAt`, `shopifySubscriptionId`
   - Sets `billingActivatedAt` if status is `active`
   - Sets `billingCanceledAt` and `isActive = false` if status is blocked
4. **Blocked statuses** that deactivate the integration: `cancelled`, `canceled`, `declined`, `expired`, `frozen`.

### 4. App Uninstall

```
POST /webhooks/shopify/uninstalled
  → Deletes the integration and associated org data
```

---

## Usage Metering & Entitlement Enforcement

### Monthly Verification Slots

Each plan includes a monthly verification quota. Enforcement is implemented via the `integration_monthly_usage` table with **atomic database transactions**.

**Table schema** (migration `0005`):

```sql
CREATE TABLE "integration_monthly_usage" (
  id            uuid PRIMARY KEY,
  org_id        uuid REFERENCES organizations,
  integration_id uuid REFERENCES integrations,
  period_start  date,           -- 1st of the month (UTC)
  included_limit integer,
  consumed_count integer DEFAULT 0,
  blocked_count  integer DEFAULT 0,
  UNIQUE(integration_id, period_start)
);
```

**Reservation flow** (`IntegrationMonthlyUsageRepository.reserveMonthlyVerificationSlot()`):

1. **UPSERT** the row for the current month (INSERT ... ON CONFLICT DO NOTHING).
2. **SELECT FOR UPDATE** to lock the row within a transaction.
3. If `consumed_count >= included_limit` → increment `blocked_count`, return `allowed: false`.
4. Otherwise → increment `consumed_count`, return `allowed: true`.

**Release flow** (`releaseMonthlyVerificationSlot()`):

- Decrements `consumed_count` (with `GREATEST(count - 1, 0)` to prevent negative values).
- Called when a verification is cancelled before completion.

### Order Processing Gate

The `WebhookQueueProcessor` checks billing status before processing any incoming order webhook:

```typescript
private isIntegrationBillingBlocked(integration): boolean {
  if (integration.isActive === false) return true;
  const status = integration.billingStatus?.trim().toLowerCase();
  if (!status) return false;
  return ['cancelled', 'canceled', 'declined', 'expired', 'frozen'].includes(status);
}
```

If blocked, the order is logged and skipped (marked as `billing_blocked:{status}` in the webhook events table).

### Verification Hub Gate

When an order passes the billing-blocked check:

1. `BillingEntitlementService.reserveVerificationSlot()` is called.
2. If `allowed: false` (quota exceeded), the verification is created with `status: 'failed'` and metadata `reason: 'plan_limit_reached'`.
3. If `allowed: true`, the verification proceeds to WhatsApp sending.

---

## Security Controls

| Control                     | Implementation                                            | File                                                         |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| **Webhook HMAC**            | `crypto.timingSafeEqual` with SHA-256 HMAC of raw body    | `shared/guards/shopify-hmac.guard.ts`                        |
| **Callback HMAC**           | Query-string HMAC verification using `SHOPIFY_API_SECRET` | `shared/guards/shopify-billing-callback-validation.guard.ts` |
| **Shop validation**         | Regex validation of `.myshopify.com` domain format        | `shopify.utils.ts` → `validateShop()`                        |
| **Rate limiting**           | In-memory per-shop/IP rate limiter (30 req/60s)           | `shared/guards/billing-callback-rate-limit.guard.ts`         |
| **Webhook deduplication**   | `webhookId` stored in `shopify_webhook_events` table      | `shopify-billing-webhook.service.ts`                         |
| **Auth guard**              | `DualAuthGuard` on all onboarding API endpoints           | `onboarding.controller.ts`                                   |
| **Input validation**        | `class-validator` DTOs with `whitelist: true`             | `dto/onboarding.dto.ts`                                      |
| **Access token encryption** | AES-256-GCM at rest (`SHOPIFY_TOKEN_ENCRYPTION_KEY`)      | Infrastructure layer                                         |

---

## Database Schema

### `integrations` table — billing columns (migration `0004`)

| Column                      | Type                                     | Description                                       |
| --------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `billing_plan_id`           | `ENUM('starter','growth','pro','scale')` | Selected plan                                     |
| `shopify_subscription_id`   | `text`                                   | Shopify GraphQL subscription GID                  |
| `billing_status`            | `text`                                   | Current status (active, pending, cancelled, etc.) |
| `billing_initiated_at`      | `timestamp`                              | When billing was first initiated                  |
| `billing_activated_at`      | `timestamp`                              | When subscription became active                   |
| `billing_canceled_at`       | `timestamp`                              | When subscription was cancelled/declined          |
| `billing_status_updated_at` | `timestamp`                              | Last status change timestamp                      |

**Indexes:** `idx_integrations_billing_status`, `idx_integrations_shopify_subscription_id`

### `integration_monthly_usage` table (migration `0005`)

See [Usage Metering](#monthly-verification-slots) above.

---

## Environment Variables

| Variable                                        | Required | Default           | Description                                                  |
| ----------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------ |
| `SHOPIFY_BILLING_REQUIRED`                      | No       | `true`            | Enable/disable Shopify subscription creation                 |
| `SHOPIFY_BILLING_TEST_MODE`                     | No       | `true` (non-prod) | Create test vs. real charges                                 |
| `SHOPIFY_BILLING_CURRENCY`                      | No       | `USD`             | Currency for all plan prices                                 |
| `SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR`         | No       | `true`            | Auto-skip billing for custom apps that can't use Billing API |
| `SHOPIFY_API_KEY`                               | Yes      | —                 | App API key (used for billing management URL)                |
| `SHOPIFY_API_SECRET`                            | Yes      | —                 | App secret (HMAC verification)                               |
| `API_URL`                                       | Yes      | —                 | Backend URL (used for billing callback return URL)           |
| `APP_URL`                                       | Yes      | —                 | Frontend URL (post-billing redirect)                         |
| `SHOPIFY_BILLING_CALLBACK_RATE_LIMIT_WINDOW_MS` | No       | `60000`           | Rate limit window for callback endpoint                      |
| `SHOPIFY_BILLING_CALLBACK_RATE_LIMIT_MAX`       | No       | `30`              | Max requests per window for callback endpoint                |

---

## Frontend Integration

### Onboarding Flow (embedded app)

1. **Plan list** — fetched via `GET /api/onboarding/billing/plans` on page load.
2. **Plan selection** — merchant taps a plan card; `selectedPlanId` state is updated.
3. **Activation** — `POST /api/onboarding/billing` with `{ planId, host }`.
   - For Starter ($0): the response `confirmationUrl` points back to the app (no Shopify approval needed).
   - For paid plans: the response `confirmationUrl` is a Shopify approval page.
4. **Redirect** — the frontend uses `window.open(confirmationUrl, '_top')` to navigate outside the iframe.
5. **Return** — Shopify redirects to the callback endpoint, which redirects back to the app.

### Settings Page (plan change)

1. `PlanComparison` component shows all 4 plans with the current plan badged.
2. Selecting a different plan and clicking "Change Plan" calls `POST /api/onboarding/billing` with the new `planId`.
3. Same redirect flow as onboarding.

### Billing Management

The settings page includes a "Manage Billing" button that links to `https://{shop}.myshopify.com/admin/apps/{apiKey}` — Shopify's native subscription management page.

---

## Custom App Handling

Custom Shopify apps (development stores, private apps) cannot use the Billing API.  
When `SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR=true` (default), the system:

1. Catches the Shopify error `Custom apps cannot use the Billing API`.
2. Sets `billingStatus: 'not_required'`.
3. Marks onboarding as complete.
4. Logs a warning.

This allows development stores and custom installs to bypass billing gracefully.

---

## Production Readiness Checklist

### Ready ✅

- [x] **HMAC verification** on all webhook and callback endpoints (timing-safe comparison)
- [x] **Webhook deduplication** via `shopify_webhook_events` table prevents double-processing
- [x] **Rate limiting** on billing callback endpoint (configurable window/max)
- [x] **Input validation** — class-validator DTOs with `whitelist: true`, plan IDs constrained to enum
- [x] **Atomic usage metering** — `SELECT FOR UPDATE` in transaction prevents double-reservation
- [x] **Billing-blocked gate** — orders are skipped when subscription status is cancelled/declined/expired/frozen
- [x] **Plan quota enforcement** — `consumed_count >= included_limit` checked per-month
- [x] **Custom app fallback** — graceful skip when Billing API is unavailable
- [x] **Billing status audit trail** — `billingInitiatedAt`, `billingActivatedAt`, `billingCanceledAt`, `billingStatusUpdatedAt` timestamps
- [x] **Access token encryption** at rest (AES-256-GCM)
- [x] **Shop domain validation** — regex check before any domain-based lookup
- [x] **Configurable test mode** — auto-enabled outside production, env-overridable
- [x] **GraphQL error handling** — both top-level `errors` and `userErrors` are checked and surfaced
- [x] **Subscription GID normalization** — handles both raw IDs and `gid://` format from webhooks

### Recommendations for Hardening

- [ ] **Persistent rate limiting** — the current `BillingCallbackRateLimitGuard` uses an in-memory `Map`. In a multi-instance deployment this provides per-instance limits only. Consider backing it with Redis for coordinated rate limiting across pods.
- [x] **Usage record creation** — `appUsageRecordCreate` is called via `StorePlatformPort.reportUsageCharge()` when `consumed_count > included_limit` for plans with overage config. Shopify enforces the `cappedAmount` ceiling; if the cap is exceeded the verification is blocked.
- [ ] **Plan upgrade/downgrade proration** — changing plans creates a new subscription but does not cancel the old one programmatically. Shopify handles this at the platform level, but consider explicitly calling `appSubscriptionCancel` on the old subscription for a cleaner audit trail.
- [ ] **Billing status polling** — if a webhook is missed (network issue, Shopify outage), stale `pending` statuses could persist indefinitely. Consider a periodic reconciliation job that queries Shopify for the latest subscription status.
- [ ] **Usage reset at period boundary** — the monthly usage table is keyed by `period_start` (1st of month UTC). Verify that UTC-based period boundaries align with Shopify's billing cycle (which is 30-day rolling from activation, not calendar-month). A mismatch could cause merchants to see limits reset at a different time than their Shopify billing cycle.
- [ ] **Webhook registration** — ensure the `APP_SUBSCRIPTIONS_UPDATE` webhook topic is registered in the Shopify app configuration (shopify.app.toml or via API). If this webhook is not registered, status changes will not propagate.
