# Merchant Operations: Dashboard, Verifications, And Settings

Last updated: 2026-05-28

## Purpose

This document explains the merchant-facing operational screens in Akeed: the Dashboard, the Verifications list, and the Settings page. It covers the KPIs displayed, filtering and pagination, merchant actions (test send, order cancellation), settings tabs, validation rules, and the interaction between the frontend skins and the backend APIs.

The Dashboard is the merchant's primary view after onboarding. It shows verification statistics, a filterable list of verification records, and actions for test sending and no-reply order cancellation. The Settings page allows merchants to configure store details, automation behavior, message templates, and billing plans.

For COD verification lifecycle mechanics (send, follow-up, escalation, customer replies), see `ORDER_CONFIRMATION_WORKFLOW.md`.
For onboarding flow and billing plan activation, see `ONBOARDING_AND_BILLING.md`.

## Scope

In scope:

- Dashboard metrics (KPIs, usage, savings).
- Verification list with status and date filtering, cursor-based pagination.
- Test verification sending from the dashboard.
- Merchant cancellation of no-reply orders.
- Settings page tabs: Store, Confirmation, Message Preview, Billing.
- Settings validation and save behavior.
- Dual-skin architecture (embedded Shopify Polaris and standalone).
- Empty states and onboarding guard behavior.

Out of scope:

- COD verification lifecycle state machine (see `ORDER_CONFIRMATION_WORKFLOW.md`).
- Billing plan activation and callback flows (see `ONBOARDING_AND_BILLING.md`).
- Shopify install and authentication (see future Identity doc).

## Dashboard

### Page Structure

The dashboard supports two runtime skins:

| Mode       | Skin component            | UI framework    |
| ---------- | ------------------------- | --------------- |
| Embedded   | `MainEmbeddedSkin`        | Shopify Polaris |
| Standalone | `DashboardStandaloneSkin` | Custom Tailwind |

Both skins share the same data hook (`useDashboard`) and render the same logical sections.

The embedded skin has two tabs: **Metrics** (stats overview with funnel cards and date range selector) and **Confirmations** (verification list with status filters and actions). Each tab uses its own sub-hook (`useMainMetricsTab`, `useMainConfirmationsTab`).

### Onboarding Guard

The dashboard page is wrapped in `EmbeddedAuthGate` with `onboardingGate="dashboard"`. If the merchant's onboarding status is `pending`, they are redirected to the onboarding page.

### Dashboard KPIs

Stats are loaded from `GET /api/verifications/stats` and scoped to a selected date range.

#### Date Range Filters

| Filter ID       | Label         | Date window           |
| --------------- | ------------- | --------------------- |
| `today`         | Today         | Current UTC day       |
| `last_7_days`   | Last 7 days   | Current day − 6 days  |
| `last_30_days`  | Last 30 days  | Current day − 29 days |
| `last_3_months` | Last 3 months | Current day − 89 days |

Default: `last_30_days`.

#### Metrics Displayed

**Order Outcomes:**

| Metric            | Source field               | Description                            |
| ----------------- | -------------------------- | -------------------------------------- |
| Confirmed orders  | `totals.confirmed`         | Orders confirmed by customer.          |
| Customer canceled | `totals.customer_canceled` | Orders canceled by customer.           |
| Awaiting response | `totals.awaiting_reply`    | Sent/delivered/read but no reply yet.  |
| Pending           | `totals.pending`           | Verification created but not yet sent. |

**Needs Attention:**

| Metric            | Source field               | Description                                      |
| ----------------- | -------------------------- | ------------------------------------------------ |
| Reply rate        | `totals.reply_rate`        | `(confirmed + customer_canceled) / sent × 100`.  |
| Confirmation rate | `totals.confirmation_rate` | `confirmed / sent × 100`.                        |
| Failed            | `totals.failed`            | Sends that failed or were blocked by plan limit. |
| Follow-ups sent   | `totals.follow_ups_sent`   | Follow-up messages sent.                         |

**Message Delivery Summary:**

| Metric    | Source field       |
| --------- | ------------------ |
| Sent      | `totals.sent`      |
| Delivered | `totals.delivered` |
| Read      | `totals.read`      |

**Usage:**

| Metric | Source field  | Description                                    |
| ------ | ------------- | ---------------------------------------------- |
| Used   | `usage.used`  | WhatsApp sends consumed in current period.     |
| Limit  | `usage.limit` | Plan's included confirmations for this period. |

Warning banners appear at 80% usage (approaching limit) and 95% (at limit).

**Money Saved:**

| Metric      | Source field                | Description                                  |
| ----------- | --------------------------- | -------------------------------------------- |
| Money saved | `savings.money_saved`       | `canceled_orders × avg_shipping_cost`.       |
| Currency    | `savings.currency`          | Merchant's configured shipping currency.     |
| Avg cost    | `savings.avg_shipping_cost` | Merchant's configured average shipping cost. |

**Automation Flags:**

The stats response includes `automation` context that shows the merchant's current automation settings as informational badges:

- `is_auto_verify_enabled`
- `follow_up_enabled`
- `quiet_hours_enabled`

### Verification List

Loaded from `GET /api/verifications` with cursor-based pagination.

#### Status Filters

| Filter ID           | API `status` param             | Description                        |
| ------------------- | ------------------------------ | ---------------------------------- |
| `all`               | _(omitted)_                    | All verifications.                 |
| `pending`           | `pending`                      | Not yet sent.                      |
| `awaiting_response` | `sent,delivered,read,no_reply` | Sent but no customer reply.        |
| `confirmed`         | `confirmed`                    | Customer confirmed.                |
| `canceled`          | `canceled`                     | Customer or merchant canceled.     |
| `failed`            | `failed`                       | Send failed or plan limit blocked. |
| `no_reply`          | `no_reply`                     | Escalated to no-reply.             |

The API accepts comma-separated status values for composite filters.

#### Verification Row Fields

Each row displays:

| Field              | Source                     |
| ------------------ | -------------------------- |
| Order number       | `order_number`             |
| Customer name      | `customer_name`            |
| Customer phone     | `customer_phone`           |
| Total price        | `total_price` + `currency` |
| Status badge       | `status`                   |
| Created at         | `created_at`               |
| Delivered at       | `delivered_at`             |
| Read at            | `read_at`                  |
| Confirmed at       | `confirmed_at`             |
| Canceled at        | `canceled_at`              |
| No-reply at        | `no_reply_at`              |
| Follow-up attempts | `follow_up_attempts`       |
| Follow-up sent at  | `follow_up_sent_at`        |

#### Pagination

- Default page size: 50 rows.
- Cursor-based: the API returns `next_cursor` when more rows exist.
- Frontend uses "Load More" button (not page numbers).
- Loading more appends to the existing list.

### Merchant Actions

#### Test Verification

Available from the dashboard (empty state or test panel). Calls `POST /api/verifications/test`.

Flow:

1. Merchant enters a phone number.
2. Frontend validates non-empty.
3. Backend normalizes the phone number via `PhoneService`.
4. Backend creates a synthetic test order with `externalOrderId = 'akeed-test-{timestamp}'`.
5. The test order flows through the full `VerificationHubService.handleNewOrder` pipeline.
6. If the send is skipped (e.g., auto-verify disabled, plan limit), the response includes `skipped: true` and a `reason`.
7. On success, the verification list and stats are refetched.

Test orders are distinguished by their `akeed-test-` prefix. Shopify API calls (cancel, tag) are skipped for test orders.

#### No-Reply Order Cancellation

Available for verifications with status `no_reply`. Calls `POST /api/verifications/:id/cancel`.

Flow:

1. Merchant clicks "Cancel Order" on a no-reply verification row.
2. A confirmation dialog appears.
3. On confirm, the backend:
   a. Validates verification is `no_reply` status (rejects other statuses).
   b. Cancels the Shopify order via `OrderAdminPort` (fail-fast on error).
   c. Marks verification as `canceled` with `cancellationSource = 'merchant_no_reply'` and `merchantCanceledAt`.
   d. Tags the Shopify order with `Akeed: Canceled` (best-effort).
4. The verification list and stats are refetched.
5. If the verification was already merchant-canceled, returns success with `alreadyCanceled: true` (idempotent).

### Empty States

When no verifications exist:

- The dashboard shows an empty state with a test verification panel.
- The test panel allows the merchant to send a test WhatsApp message to validate their setup.

## Settings Page

### Page Structure

The settings page supports two runtime skins:

| Mode       | Skin component               | UI framework    |
| ---------- | ---------------------------- | --------------- |
| Embedded   | `SettingsEmbeddedTabbedSkin` | Shopify Polaris |
| Standalone | `SettingsStandaloneSkin`     | Custom Tailwind |

Both skins share the same data hook (`useSettings`).

The embedded skin uses Polaris `Tabs` with four tabs. The standalone skin renders sections vertically.

### Onboarding Guard

If `onboardingStatus` is `pending` when the settings page loads, the user is redirected to the onboarding page.

### Settings Tabs

#### Tab 1 — Store

| Field             | Type   | Validation                                                        |
| ----------------- | ------ | ----------------------------------------------------------------- |
| Store name        | text   | Required, max 255 chars.                                          |
| Default language  | select | `auto`, `en`, `ar`.                                               |
| Shipping currency | select | Allowlist: USD, EUR, EGP, SAR, AED, QAR, KWD, BHD, OMR, JOD, MAD. |
| Avg shipping cost | number | `>= 0`, max 2 decimal places.                                     |
| Auto-verify       | toggle | Boolean.                                                          |

#### Tab 2 — Confirmation

Automation settings that control the verification send pipeline.

| Field               | Type   | UI unit | API unit | Validation                           |
| ------------------- | ------ | ------- | -------- | ------------------------------------ |
| Initial send delay  | number | hours   | minutes  | `0..720` hours (`0..43200` minutes). |
| Follow-up enabled   | toggle | —       | boolean  | —                                    |
| Follow-up delay     | number | hours   | minutes  | `0..720` hours when enabled.         |
| Escalation enabled  | toggle | —       | boolean  | —                                    |
| Escalation delay    | number | hours   | minutes  | `0..720` hours when enabled.         |
| Quiet hours enabled | toggle | —       | boolean  | —                                    |
| Quiet hours start   | time   | HH:mm   | HH:mm    | Required when quiet hours enabled.   |
| Quiet hours end     | time   | HH:mm   | HH:mm    | Required when quiet hours enabled.   |
| Timezone            | select | —       | string   | Allowlist of 10 timezones.           |

**Important:** The UI displays delay values in hours, but the API accepts and stores them in minutes. The frontend converts between units on load and save.

Cross-field validation (mirrors backend):

- If follow-up and escalation are both enabled, `followUpDelayMinutes < escalationDelayMinutes`.
- If quiet hours are enabled, both start and end times are required.

#### Tab 3 — Message Preview

Displays a live preview of the WhatsApp confirmation template in both Arabic and English. The merchant can select branded template variants:

| Language | Variants                                      | Default    |
| -------- | --------------------------------------------- | ---------- |
| Arabic   | `standard`, `egyptian`, `gulf`, `short`       | `standard` |
| English  | `friendly`, `professional`, `direct`, `short` | `friendly` |

The preview updates immediately when a variant is selected. Template variant selections are persisted on save.

#### Tab 4 — Billing

Displays current plan, billing status, usage progress, and plan options.

| Element              | Source                                           |
| -------------------- | ------------------------------------------------ |
| Active plan name     | `billingPlanId` resolved via `billingPlansById`. |
| Billing status label | Resolved from `billingStatus` to localized key.  |
| Usage bar            | `used / limit` with percentage.                  |
| Usage period         | `periodStart` — `periodEnd`.                     |
| Upgrade prompt       | Shown at 80% usage, stronger at 100%.            |
| Plan cards           | All four plans with price and volume labels.     |
| Change plan button   | Enabled when selected plan differs from current. |

Plan change follows the flow described in `ONBOARDING_AND_BILLING.md`.

### Save Behavior

- All saveable tabs (Store, Confirmation, Message Preview) share a single Save action.
- Frontend validates all fields before calling `PATCH /api/settings`.
- On success, all state is re-synced from the response (including billing and template data).
- On failure, all fields are rolled back to their pre-save values.
- In embedded mode, a Shopify toast notification confirms save success.
- Error and success banners are shown in both modes.

### URL Tab Navigation

The embedded skin supports `?tab=` query parameter for direct tab access:

| Parameter value       | Tab               |
| --------------------- | ----------------- |
| `store`               | Store             |
| `confirmation`        | Confirmation      |
| `message-preview`     | Message Preview   |
| `billing`             | Billing           |
| `confirmation-config` | → Confirmation    |
| `message-template`    | → Message Preview |

Legacy routes `/message-preview` and `/automation-settings` redirect to the corresponding settings tab.

## Backend Code Map

| Area                      | File                                                 | Responsibility                                                                   |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Verifications controller  | `modules/verifications/verifications.controller.ts`  | Exposes stats, list, test send, and cancel endpoints.                            |
| Verifications service     | `modules/verifications/verifications.service.ts`     | Stats aggregation, list query, no-reply cancellation, date range resolution.     |
| Test verification service | `modules/verifications/test-verification.service.ts` | Creates synthetic test orders and routes through the full verification pipeline. |
| Orders controller         | `modules/orders/orders.controller.ts`                | Exposes paginated order list.                                                    |
| Orders service            | `modules/orders/orders.service.ts`                   | Paginated order list query with verification status join.                        |
| Settings controller       | `modules/onboarding/settings.controller.ts`          | GET/PATCH for post-onboarding settings.                                          |
| Onboarding service        | `modules/onboarding/onboarding.service.ts`           | Orchestrates settings response (state + billing + templates).                    |
| Onboarding state service  | `modules/onboarding/onboarding-state.service.ts`     | Settings updates, cross-field validation, store name prefill.                    |
| Dashboard DTO             | `modules/orders/dto/dashboard.dto.ts`                | Query/response DTOs for stats, verifications list, and orders list.              |
| Pagination helpers        | `modules/orders/services/pagination.helpers.ts`      | Cursor encode/decode for keyset pagination.                                      |

## Frontend Code Map

| Area                           | File                                                                        | Responsibility                                                                   |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Dashboard page                 | `app/[locale]/dashboard/page.tsx`                                           | Mode-aware dashboard entry point with onboarding guard.                          |
| Dashboard hook (standalone)    | `features/dashboard/domain/useDashboard.ts`                                 | Standalone dashboard: stats, verifications, filters, test send, cancel order.    |
| Metrics tab hook (embedded)    | `features/dashboard/domain/useMainMetricsTab.ts`                            | Embedded metrics tab: stats loading and automation flags.                        |
| Confirmations tab hook         | `features/dashboard/domain/useMainConfirmationsTab.ts`                      | Embedded confirmations tab: verification list, filters, test send, cancel order. |
| Dashboard data hook            | `features/dashboard/hooks/useDashboardData.ts`                              | Fetches verification list with status/date filters, pagination, and refetch.     |
| Dashboard stats hook           | `features/dashboard/hooks/useDashboardStats.ts`                             | Fetches verification stats with date range filter and refetch.                   |
| Dashboard model                | `features/dashboard/model/dashboard.model.ts`                               | TypeScript types for stats, verifications, filters, and API responses.           |
| Dashboard formatters           | `features/dashboard/lib/dashboardFormatters.ts`                             | Number and money formatting helpers.                                             |
| Standalone stats               | `features/dashboard/skins/standalone/components/StandaloneStatsSummary.tsx` | Stats cards, usage bar, money saved section.                                     |
| Standalone verifications table | `features/dashboard/skins/standalone/VerificationsTableStandalone.tsx`      | Verification rows with cancel action.                                            |
| Embedded verifications table   | `features/dashboard/skins/embedded/VerificationsTableEmbedded.tsx`          | Polaris verification rows with cancel action.                                    |
| Status badge                   | `features/dashboard/ui/shared/StatusBadge.tsx`                              | Color-coded status badge component.                                              |
| Settings page                  | `app/[locale]/(embedded)/settings/page.tsx`                                 | Mode-aware settings entry point with onboarding guard.                           |
| Settings hook                  | `features/settings/domain/useSettings.ts`                                   | All settings state, validation, save, plan change, template management.          |
| Settings API                   | `features/settings/api/settingsApi.ts`                                      | GET/PATCH wrappers for `/api/settings`.                                          |
| Settings embedded skin         | `features/settings/skins/embedded/SettingsEmbeddedTabbedSkin.tsx`           | Polaris tabbed settings UI with Store, Confirmation, Message Preview, Billing.   |
| Settings standalone skin       | `features/settings/skins/standalone/SettingsStandaloneSkin.tsx`             | Standalone settings layout with sections.                                        |
| Settings types                 | `features/settings/domain/settings.types.ts`                                | TypeScript types for settings skin props.                                        |
| Message preview feature        | `features/message-preview/ui/VerificationTemplatePreview.tsx`               | WhatsApp message template preview component.                                     |

## API Reference

| Method  | Endpoint                        | Auth            | Purpose                                               |
| ------- | ------------------------------- | --------------- | ----------------------------------------------------- |
| `GET`   | `/api/verifications/stats`      | `DualAuthGuard` | Dashboard KPIs scoped to date range.                  |
| `GET`   | `/api/verifications`            | `DualAuthGuard` | Paginated verification list with status/date filters. |
| `POST`  | `/api/verifications/test`       | `DualAuthGuard` | Send a test verification to a phone number.           |
| `POST`  | `/api/verifications/:id/cancel` | `DualAuthGuard` | Merchant cancellation for no-reply verifications.     |
| `GET`   | `/api/orders`                   | `DualAuthGuard` | Paginated order list with verification status.        |
| `GET`   | `/api/settings`                 | `DualAuthGuard` | Load full settings (state + billing + templates).     |
| `PATCH` | `/api/settings`                 | `DualAuthGuard` | Update merchant settings.                             |

### Query Parameters

**`GET /api/verifications`:**

| Param        | Type   | Default        | Description                                                      |
| ------------ | ------ | -------------- | ---------------------------------------------------------------- |
| `status`     | string | _(all)_        | Comma-separated status filter.                                   |
| `date_range` | string | `last_30_days` | One of: `today`, `last_7_days`, `last_30_days`, `last_3_months`. |
| `cursor`     | string | _(none)_       | Pagination cursor from previous response.                        |
| `limit`      | number | `50`           | Page size, 1–100.                                                |

**`GET /api/verifications/stats`:**

| Param        | Type   | Default        | Description          |
| ------------ | ------ | -------------- | -------------------- |
| `date_range` | string | `last_30_days` | Date range for KPIs. |

**`GET /api/orders`:**

| Param    | Type   | Default  | Description                               |
| -------- | ------ | -------- | ----------------------------------------- |
| `cursor` | string | _(none)_ | Pagination cursor from previous response. |
| `limit`  | number | `50`     | Page size, 1–100.                         |

### Request Bodies

**`POST /api/verifications/test`:**

```json
{
  "customerPhone": "+201234567890"
}
```

**`POST /api/verifications/:id/cancel`:**

_(empty body)_

**`PATCH /api/settings`:**

All fields from `UpdateOnboardingSettingsDto`. See `ONBOARDING_AND_BILLING.md` for the full DTO definition.

## Data Dependencies

The dashboard and settings pages read from and affect the following tables:

| Table                       | Read by              | Written by        |
| --------------------------- | -------------------- | ----------------- |
| `verifications`             | Dashboard list/stats | Test send, cancel |
| `orders`                    | Dashboard list       | Test send         |
| `integrations`              | Stats, settings      | Settings save     |
| `integration_monthly_usage` | Stats, settings      | Test send         |

## Reliability And Safety

Idempotency:

- Merchant cancellation is idempotent: re-canceling an already merchant-canceled verification returns `alreadyCanceled: true`.
- Test verifications create unique order IDs with `akeed-test-{timestamp}`.

Error handling:

- Shopify order cancellation is fail-fast: if the Shopify API rejects the cancel, local state is not modified.
- Shopify order tagging after cancellation is best-effort: failures are logged but do not fail the cancel action.
- Frontend rolls back all settings fields on save failure.
- Frontend shows separate error states for stats loading and verification list loading.

Security:

- All endpoints require `DualAuthGuard` authentication.
- Verification list and stats are scoped to the authenticated user's organization.
- The cancel endpoint validates org ownership before proceeding.
- Phone numbers for test sends are normalized and validated server-side.

## Known Business Decisions

- The `awaiting_response` filter maps to four statuses: `sent`, `delivered`, `read`, `no_reply`.
- Reply rate formula: `(confirmed + customer_canceled) / sent × 100`. Merchant no-reply cancellations are excluded from the numerator.
- Confirmation rate formula: `confirmed / sent × 100`.
- Money saved formula: `total_canceled × avg_shipping_cost` (uses the merchant's configured values).
- Date range filters use inclusive UTC day boundaries (start of selected range through end of current day).
- Settings delay fields display in hours on the UI but transmit in minutes to the API.
- Test orders skip Shopify API calls (cancel, tag) based on the `akeed-test-` prefix.
- Only `no_reply` status verifications can be merchant-canceled; other statuses are rejected.
- The settings page re-syncs all state from the save response, not just the fields that were changed.

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

| Scenario                                      | Expected result                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dashboard loads with default date range       | Stats and verification list load for last 30 days.                                 |
| Change date range to "Today"                  | Stats and list re-fetch for current UTC day.                                       |
| Filter by "Confirmed" status                  | Only confirmed verifications appear in the list.                                   |
| Filter by "Awaiting response"                 | Verifications with sent, delivered, read, and no_reply statuses appear.            |
| Load more verifications                       | Next page appends to the existing list.                                            |
| Send test verification with valid phone       | Test order created, verification sent, list/stats refresh.                         |
| Send test verification with empty phone       | Client-side error: phone required.                                                 |
| Send test verification with invalid phone     | Server-side error: invalid phone number.                                           |
| Test verification when plan limit reached     | Returns `skipped: true` with reason.                                               |
| Cancel no-reply order                         | Shopify order canceled, verification marked merchant-canceled, list/stats refresh. |
| Cancel already-canceled no-reply order        | Returns success with `alreadyCanceled: true`.                                      |
| Cancel order with non-no_reply status         | Returns 400: only no_reply verifications can be canceled.                          |
| Settings: save valid settings                 | All fields saved, success banner shown, state re-synced from response.             |
| Settings: save with empty store name          | Client-side validation error, save blocked.                                        |
| Settings: follow-up delay >= escalation delay | Cross-field validation error on both delay fields.                                 |
| Settings: quiet hours enabled without times   | Validation error: start and end required.                                          |
| Settings: change template variant             | Preview updates immediately, variant persisted on save.                            |
| Settings: change billing plan                 | Redirects to Shopify billing confirmation.                                         |
| Dashboard with no verifications               | Empty state shown with test verification panel.                                    |
| Embedded mode tab navigation via URL          | `?tab=confirmation` opens Confirmation tab directly.                               |
| Legacy route `/message-preview`               | Redirects to `/settings?tab=message-preview`.                                      |
| Legacy route `/automation-settings`           | Redirects to `/settings?tab=confirmation`.                                         |
