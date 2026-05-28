# Onboarding And Billing Lifecycle

Last updated: 2026-05-28

## Purpose

This document explains the Akeed merchant onboarding and billing lifecycle from a business perspective. It covers the onboarding flow, billing plan activation, plan change behavior, usage tracking, billing period accounting, and the interaction between billing state and verification processing.

Onboarding is the process a new Shopify merchant goes through after installing the Akeed app. The merchant configures their store, selects a billing plan, and activates their subscription before verification processing begins. Billing controls whether Akeed can send WhatsApp verification messages by enforcing plan-level usage limits.

## Scope

In scope:

- Embedded onboarding setup flow (configuration and billing steps).
- Onboarding state management and resume logic.
- Billing plan definitions and pricing.
- Free plan (Starter) activation and one-time claim enforcement.
- Paid plan activation through Shopify recurring application charges.
- Billing callback handling and subscription confirmation.
- Plan change and upgrade behavior.
- Billing status lifecycle and subscription webhook sync.
- Usage tracking and billing period accounting.
- Billing entitlement checks that gate verification sends.
- Settings page billing tab for post-onboarding plan management.

Out of scope:

- COD order verification workflow mechanics (see `ORDER_CONFIRMATION_WORKFLOW.md`).
- Shopify OAuth install flow details (see future Identity doc).
- Dashboard KPIs and verification list UI (see future Merchant Operations doc).

## Onboarding States

| Status      | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `pending`   | Integration exists but the merchant has not completed setup.        |
| `completed` | Merchant has finished configuration and billing. Processing begins. |

Transitions:

- `pending` → `completed`: Set when billing activation succeeds and all prerequisites are met (store name, default language, auto-verify toggle).
- `completed` is permanent for the integration lifetime. Revisiting the onboarding page redirects to the dashboard.

## Onboarding Flow

The embedded onboarding flow has two steps:

### Step 1 — Configuration

Fields collected:

| Field               | Required | Default                    | Notes                                             |
| ------------------- | -------- | -------------------------- | ------------------------------------------------- |
| Store name          | Yes      | Prefilled from Shopify API | Validated non-empty.                              |
| App language        | Yes      | Browser locale             | Switches UI locale immediately.                   |
| Default language    | Yes      | `auto`                     | WhatsApp template language (`auto`, `en`, `ar`).  |
| Auto-verify enabled | Yes      | `true`                     | Controls whether COD orders trigger verification. |

Behavior:

- Fields auto-save to the backend with a 1500ms debounce while on step 1.
- If the store name could not be prefilled from the Shopify API, a warning banner is shown.
- Clicking "Continue to Billing" performs an explicit save and advances to step 2.
- Validation: store name must be non-empty.

### Step 2 — Billing

The merchant selects a billing plan and activates it.

Behavior:

- Plans are fetched from `GET /api/onboarding/billing/plans`.
- The default selected plan is `basic`.
- If the Starter free plan has already been claimed for this shop, it is disabled with a tooltip.
- Activating a paid plan creates a Shopify recurring application charge and redirects the merchant to the Shopify billing confirmation page.
- Activating the free Starter plan completes onboarding immediately without a Shopify redirect.
- On billing callback return, the backend verifies the charge status, activates the subscription, marks onboarding as completed, and redirects to the dashboard.

### Resume Logic

When a merchant returns to the onboarding page mid-flow:

- If `onboardingStatus` is `completed`, redirect to dashboard.
- If `billingPlanId` or `billingStatus` is set, resume at step 2 (billing).
- If billing has a non-active status (declined, frozen, expired, canceled, error), show a recovery error banner on step 2.
- Otherwise, start at step 1.

## Billing Plans

Plan definitions are in `akeed-backend/src/modules/onboarding/onboarding.service.helpers.ts`.

| Plan    | Plan ID    | Monthly price | Included confirmations | Billing type             |
| ------- | ---------- | ------------: | ---------------------: | ------------------------ |
| Starter | `starter`  |          `$0` |          `30` one-time | No Shopify charge        |
| Basic   | `basic`    |       `$8.99` |          `300` monthly | Shopify recurring charge |
| Pro     | `pro`      |      `$22.99` |         `1000` monthly | Shopify recurring charge |
| Scale   | `business` |      `$44.99` |         `2500` monthly | Shopify recurring charge |

Currency is configurable via `SHOPIFY_BILLING_CURRENCY` (default `USD`).
Test mode is enabled in non-production environments via `SHOPIFY_BILLING_TEST_MODE`.

## Billing Statuses

| Status         | Meaning                                                | Allows verification sends |
| -------------- | ------------------------------------------------------ | :-----------------------: |
| `active`       | Shopify subscription is active and paid.               |            Yes            |
| `not_required` | Billing bypassed (dev mode or custom app).             |            Yes            |
| `pending`      | Charge created but merchant has not confirmed.         |            No             |
| `declined`     | Merchant declined the Shopify billing prompt.          |            No             |
| `frozen`       | Shopify froze the subscription (e.g. payment failure). |            No             |
| `expired`      | Subscription expired without renewal.                  |            No             |
| `cancelled`    | Merchant or system canceled the subscription.          |            No             |
| `error`        | Billing initiation failed (e.g. Shopify API error).    |            No             |
| `null`         | No billing activity yet.                               |            No             |

Only `active` and `not_required` allow verification sends. This is enforced by `isBillingStatusActive()` in `shared/utils/billing.util.ts`.

## Billing Activation Flows

### Free Plan (Starter)

1. Frontend calls `POST /api/onboarding/billing` with `planId: 'starter'`.
2. Backend checks `billing_free_plan_claims` for an existing claim for this platform + shop domain.
3. If already claimed, return `400 Bad Request`.
4. Create a claim record in `billing_free_plan_claims`.
5. Cancel any existing Shopify subscription.
6. Set `billingPlanId = 'starter'`, `billingStatus = 'active'`, `shopifySubscriptionId = null`.
7. Reset monthly usage counters.
8. Mark onboarding as `completed`.
9. Return a redirect URL to the dashboard.
10. If any step after claim creation fails, the claim is rolled back.

### Paid Plan (New Activation)

1. Frontend calls `POST /api/onboarding/billing` with a paid `planId` and optional `host`.
2. Backend verifies billing prerequisites are met (store name, language, auto-verify set).
3. Backend creates a Shopify `appSubscriptionCreate` mutation via `StorePlatformPort`.
4. Backend stores `pendingBillingPlanId` but does NOT change `billingPlanId` or `billingStatus` yet.
5. Return `confirmationUrl` for Shopify billing approval page.
6. Merchant approves or declines on Shopify.
7. Shopify redirects to `GET /api/onboarding/billing/callback` with `shop`, `charge_id`, and optional `hmac`.

### Billing Callback

1. `ShopifyBillingCallbackValidationGuard` validates shop format and HMAC (when present).
2. `BillingCallbackRateLimitGuard` enforces rate limiting (30 requests per 60 seconds per shop).
3. Backend fetches the subscription status from Shopify via `getAppSubscriptionStatus`.
4. **If active:**
   - Cancel the previous subscription if one exists.
   - Promote `pendingBillingPlanId` to `billingPlanId`.
   - Set `billingStatus = 'active'`, record `billingActivatedAt`.
   - Reset usage counters for the new plan.
   - Mark onboarding as `completed` (if prerequisites are met).
   - Redirect to the app.
5. **If not active (declined, etc.):**
   - Clear `pendingBillingPlanId`.
   - If the merchant already has an active plan, preserve it.
   - If no active plan exists, write the declined/canceled status.
   - Redirect to the app (onboarding page shows recovery banner).

### Plan Change (Post-Onboarding)

Plan changes from the Settings billing tab follow the same paid-plan flow:

1. Same-plan guard: if the merchant selects their current active plan, return immediately.
2. New subscription is created on Shopify before modifying local state.
3. On callback approval, the old subscription is canceled and the new one is activated.
4. Usage counters are reset for the new billing period.
5. If the merchant declines the new plan, their existing plan stays active.

### Development Bypass

When `SHOPIFY_BILLING_REQUIRED` is `false`:

- Paid plans activate immediately with `billingStatus = 'not_required'` and no Shopify charge.
- Custom app billing errors are silently skipped when `SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR` is `true`.

## Usage Tracking

### Billing Period

Billing periods are 30-day rolling cycles starting from `billingActivatedAt`:

- Period start = `billingActivatedAt + (completedCycles × 30 days)`
- Period end = period start + 30 days
- If `billingActivatedAt` is not set (e.g. Starter plan), falls back to the 1st of the current UTC month.

### Usage Accounting

Usage is tracked in the `integration_monthly_usage` table:

| Field           | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `consumedCount` | Number of WhatsApp sends attempted this period. |
| `includedLimit` | Plan's included confirmations for this period.  |
| `blockedCount`  | Sends blocked because the limit was reached.    |

Rules:

- Usage is consumed when a WhatsApp send is attempted, not when a verification row is created.
- Delayed initial sends consume only when the automation worker sends the message.
- Failed sends release the usage reservation.
- Follow-up messages consume from included monthly confirmations.
- When the limit is reached, new sends are blocked until the period renews or the merchant upgrades.
- Plan changes reset usage counters to start a fresh period.

### Entitlement Enforcement

`BillingEntitlementService` gates every WhatsApp send:

1. Resolve the plan and its included limit.
2. Compute the current billing period start.
3. Attempt to reserve a slot via `reserveMonthlyVerificationSlot`.
4. If the reservation succeeds, the send proceeds.
5. If the limit is reached, the send is blocked with status `plan_limit_reached`.
6. If the send fails after reservation, the slot is released.

## Subscription Webhook Sync

Shopify sends `app_subscriptions/update` webhooks when subscription status changes. Handled by `ShopifyBillingWebhookService`:

- Webhooks are HMAC-verified and deduplicated via `webhook_events`.
- Active status updates `billingStatus`, `billingActivatedAt`, and `isActive = true`.
- Blocked statuses (`cancelled`, `declined`, `expired`, `frozen`) set `isActive = false` and `billingCanceledAt`.
- Non-current subscription webhooks with blocked status are ignored to prevent a declined upgrade from disabling the merchant's existing active plan.

## Backend Code Map

| Area                        | File                                                                        | Responsibility                                                                                |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Onboarding controller       | `modules/onboarding/onboarding.controller.ts`                               | Exposes state, settings update, billing initiation, and billing plans endpoints.              |
| Billing callback controller | `modules/onboarding/onboarding-billing-callback.controller.ts`              | Handles Shopify billing callback redirect with validation and rate limit guards.              |
| Settings controller         | `modules/onboarding/settings.controller.ts`                                 | Exposes settings GET/PATCH for the post-onboarding settings page.                             |
| Onboarding orchestrator     | `modules/onboarding/onboarding.service.ts`                                  | Coordinates state, billing, usage, and template settings retrieval.                           |
| State service               | `modules/onboarding/onboarding-state.service.ts`                            | Manages onboarding state, settings updates, cross-field validation, store name prefill.       |
| Billing service             | `modules/onboarding/billing.service.ts`                                     | Handles free/paid plan activation, callback processing, plan changes, subscription lifecycle. |
| Billing config              | `modules/onboarding/billing-config.service.ts`                              | Resolves plan definitions, environment-based billing settings.                                |
| Billing helpers             | `modules/onboarding/onboarding.service.helpers.ts`                          | Plan templates, billing period calculations, redirect URL builders.                           |
| Billing entitlement         | `modules/verification-core/billing-entitlement.service.ts`                  | Usage reservation and release for verification sends.                                         |
| Billing webhook handler     | `infrastructure/spokes/shopify/services/shopify-billing-webhook.service.ts` | Processes Shopify subscription status webhooks.                                               |
| Billing utility             | `shared/utils/billing.util.ts`                                              | `isBillingStatusActive()` — central check for active billing.                                 |
| Callback validation guard   | `shared/guards/shopify-billing-callback-validation.guard.ts`                | HMAC verification and parameter validation for billing callbacks.                             |
| Callback rate limit guard   | `shared/guards/billing-callback-rate-limit.guard.ts`                        | Per-shop rate limiting for billing callback requests.                                         |

## Frontend Code Map

| Area                  | File                                                              | Responsibility                                                            |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Onboarding page       | `app/[locale]/(embedded)/onboarding/page.tsx`                     | Renders the two-step onboarding wizard for embedded mode.                 |
| Coordinator hook      | `features/onboarding/hooks/useEmbeddedOnboarding.ts`              | Orchestrates init, settings, and billing sub-hooks.                       |
| Init hook             | `features/onboarding/hooks/useOnboardingInit.ts`                  | Fetches state and plans, resolves resume step, handles billing recovery.  |
| Settings hook         | `features/onboarding/hooks/useOnboardingSettings.ts`              | Step 1 form state, debounced auto-save, continue-to-billing transition.   |
| Billing hook          | `features/onboarding/hooks/useOnboardingBilling.ts`               | Plan selection, activation call, redirect handling.                       |
| Onboarding API        | `features/onboarding/api/onboardingApi.ts`                        | API wrappers for state, settings, billing, and plans endpoints.           |
| Embedded auth helpers | `features/onboarding/lib/embeddedAuth.ts`                         | Install check, token exchange, onboarding status caching, redirect logic. |
| Plan definitions      | `features/onboarding/model/onboarding.config.ts`                  | Plan display names and language option definitions.                       |
| Settings billing tab  | `features/settings/skins/embedded/SettingsEmbeddedTabbedSkin.tsx` | Post-onboarding plan management, usage display, plan change UI.           |
| Settings hook         | `features/settings/domain/useSettings.ts`                         | Loads billing state, plans, usage; handles plan change initiation.        |

## API Reference

| Method  | Endpoint                           | Auth                     | Purpose                                                    |
| ------- | ---------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `GET`   | `/api/onboarding/state`            | `DualAuthGuard`          | Load onboarding state and settings.                        |
| `PATCH` | `/api/onboarding/settings`         | `DualAuthGuard`          | Update onboarding/merchant settings.                       |
| `GET`   | `/api/onboarding/billing/plans`    | `DualAuthGuard`          | Load available billing plans and free-plan claim status.   |
| `POST`  | `/api/onboarding/billing`          | `DualAuthGuard`          | Initiate billing activation for a selected plan.           |
| `GET`   | `/api/onboarding/billing/callback` | HMAC + rate limit guards | Handle Shopify billing callback redirect.                  |
| `GET`   | `/api/settings`                    | `DualAuthGuard`          | Load full settings response (state + billing + templates). |
| `PATCH` | `/api/settings`                    | `DualAuthGuard`          | Update settings (same payload as onboarding settings).     |

## Data Model Reference

### `integrations` (billing-related columns)

| Column                      | Type                                 | Purpose                                                              |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `onboarding_status`         | enum `pending\|completed`            | Tracks whether onboarding is finished.                               |
| `billing_plan_id`           | enum `starter\|basic\|pro\|business` | Currently active billing plan.                                       |
| `pending_billing_plan_id`   | enum (same)                          | Plan awaiting Shopify approval during plan change.                   |
| `shopify_subscription_id`   | text                                 | Shopify GraphQL subscription ID for the active charge.               |
| `billing_status`            | text                                 | Current billing status (`active`, `declined`, etc.).                 |
| `billing_initiated_at`      | timestamptz                          | When billing was last initiated.                                     |
| `billing_activated_at`      | timestamptz                          | When the current subscription was activated. Anchors billing period. |
| `billing_canceled_at`       | timestamptz                          | When the subscription was canceled/declined.                         |
| `billing_status_updated_at` | timestamptz                          | Last time billing status changed.                                    |

### `integration_monthly_usage`

| Column           | Type    | Purpose                                        |
| ---------------- | ------- | ---------------------------------------------- |
| `org_id`         | uuid    | Organization ID.                               |
| `integration_id` | uuid    | Integration ID (FK to `integrations`).         |
| `period_start`   | date    | Start date of the 30-day billing period.       |
| `included_limit` | integer | Plan's included confirmations for this period. |
| `consumed_count` | integer | Number of sends consumed.                      |
| `blocked_count`  | integer | Number of sends blocked by limit.              |

Constraints:

- Unique on `(integration_id, period_start)` — one row per integration per billing period.
- `included_limit > 0`, `consumed_count >= 0`, `blocked_count >= 0`.

### `billing_free_plan_claims`

| Column          | Type        | Purpose                                  |
| --------------- | ----------- | ---------------------------------------- |
| `org_id`        | uuid        | Organization that claimed the free plan. |
| `platform_type` | text        | E-commerce platform (`shopify`, etc.).   |
| `shop_domain`   | text        | Store domain that claimed the plan.      |
| `claimed_at`    | timestamptz | When the free plan was claimed.          |

Constraints:

- Unique on `(platform_type, shop_domain)` — one free plan claim per shop per platform, ever.

## Reliability And Safety

Idempotency:

- Free plan claims are enforced by a unique constraint; duplicate claims return `400`.
- Billing callbacks verify charge status from Shopify before activating.
- Subscription webhook deduplication uses `webhook_events` idempotency keys.
- Non-current subscription blocked-status webhooks are ignored to protect active plans.

Security:

- Billing callback HMAC is verified when present via `ShopifyBillingCallbackValidationGuard`.
- Billing callbacks are rate-limited (30 per 60 seconds per shop) via `BillingCallbackRateLimitGuard`.
- All onboarding/settings APIs require `DualAuthGuard` authentication.
- Shopify access tokens are never logged.

Error handling:

- Free plan claim creation failures trigger a rollback of the claim record.
- Failed subscription cancellation during plan change is logged but does not block the new plan activation.
- Custom app billing errors are silently bypassed when configured.
- Usage counter reset failures are logged but do not block plan activation.

## Known Business Decisions

- The Starter free plan can only be claimed once per shop domain, ever. Reinstalling the app does not reset the claim.
- Plan changes create a new Shopify subscription before canceling the old one, ensuring no gap in service.
- Declining a plan upgrade preserves the existing active plan.
- Usage counters reset on plan change so the merchant starts fresh on the new plan.
- Billing periods are 30-day rolling cycles from activation, not calendar months.
- When billing is not required (dev mode), plans activate with status `not_required`.
- The `pendingBillingPlanId` pattern prevents local state corruption if the merchant declines a plan change.
- Onboarding completion requires all three prerequisites: store name, default language, and auto-verify toggle.

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

## Recommended Test Scenarios

| Scenario                                          | Expected result                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| First-time onboarding with Starter plan           | Onboarding completes, `billingStatus = 'active'`, free plan claim created, usage counters initialized.            |
| Second Starter claim for same shop                | Returns `400 Bad Request` — Starter can only be claimed once.                                                     |
| Paid plan activation (merchant approves)          | Shopify charge confirmed, `billingPlanId` updated, `billingStatus = 'active'`, usage reset, onboarding completed. |
| Paid plan activation (merchant declines)          | `billingStatus = 'declined'`, `pendingBillingPlanId` cleared, onboarding stays pending.                           |
| Plan upgrade from Basic to Pro (approved)         | Old subscription canceled, new plan activated, usage counters reset.                                              |
| Plan upgrade declined                             | Existing Basic plan stays active and unmodified.                                                                  |
| Merchant returns to onboarding after decline      | Step 2 loads with declined recovery banner, merchant can retry.                                                   |
| Completed onboarding merchant visits onboarding   | Redirected to dashboard immediately.                                                                              |
| Shopify subscription webhook with `frozen` status | `isActive = false`, `billingCanceledAt` set, verification sends blocked.                                          |
| Shopify webhook for non-current subscription      | Ignored if status is blocked; does not affect current active plan.                                                |
| Usage limit reached                               | Next verification send returns `plan_limit_reached`, `blockedCount` increments.                                   |
| Plan change resets usage                          | `consumedCount` and `blockedCount` reset, new `includedLimit` applied.                                            |
| Settings page billing tab shows usage             | Displays `used / limit`, period dates, and warning banner at 80% and 95%.                                         |
| Missing store name during billing initiation      | Returns `400 Bad Request` with prerequisite error.                                                                |
