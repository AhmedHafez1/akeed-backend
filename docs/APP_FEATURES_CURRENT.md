# Akeed MVP - Current Implemented Features (As Of 2026-03-14)

## Product Scope
Akeed is a multi-tenant Shopify app for COD order verification using WhatsApp Cloud API.

## Implemented User Flows
- Shopify embedded app install and authentication.
- Embedded onboarding flow with:
  - Welcome step
  - Store configuration (store name, language, auto-verify toggle)
  - Plan selection and billing activation
- Embedded settings page for:
  - Store configuration updates
  - Shipping currency and average shipping cost updates
  - Current plan visibility and plan changes
  - Billing management deep-linking
- Dashboard experience in two skins:
  - Embedded (Shopify Polaris)
  - Standalone (custom UI)
- Marketing landing page and waitlist submission flow.
- Standalone authentication pages (login/signup).

## Backend Features

### Authentication and Identity
- Dual authentication support:
  - Shopify session token path (embedded)
  - Supabase JWT path (standalone)
- Unified user context for protected APIs.
- Current-user endpoints:
  - `GET /auth/me`
  - `GET /auth/status`

### Shopify Integration
- OAuth install flow:
  - `GET /auth/shopify`
  - `GET /auth/shopify/callback`
- Install status check:
  - `GET /auth/shopify/check`
- App Bridge token exchange flow:
  - `POST /auth/shopify/token-exchange`
- Webhook registration at install for:
  - `APP_UNINSTALLED`
  - `APP_SUBSCRIPTIONS_UPDATE`
  - `ORDERS_CREATE`

### Shopify Webhook Handling
- HMAC validation guard using timing-safe compare.
- Webhook endpoints:
  - `POST /webhooks/shopify/orders-create`
  - `POST /webhooks/shopify/uninstalled`
  - `POST /webhooks/shopify/app-subscriptions/update`
  - `POST /webhooks/shopify/app-subscriptions-update`
  - `POST /webhooks/shopify/customers/data_request`
  - `POST /webhooks/shopify/customers/redact`
  - `POST /webhooks/shopify/shop/redact`
- Webhook idempotency support via webhook event persistence and duplicate handling.

### Queue and Processing
- BullMQ queue for webhook processing backed by Redis.
- Async processing with retries and exponential backoff.
- Platform normalizer architecture (Shopify normalizer currently wired).

### Verification Domain
- Eligibility checks before verification trigger (COD-focused logic).
- Order ingest and idempotent order creation.
- Verification lifecycle support:
  - pending
  - sent
  - delivered/read via WhatsApp status callbacks
  - confirmed/canceled via button replies
- Shopify order tagging on final statuses:
  - `Akeed: Verified`
  - `Akeed: Canceled`
- Test verification endpoint:
  - `POST /api/verifications/test`

### Onboarding and Billing
- Onboarding state APIs:
  - `GET /api/onboarding/state`
  - `PATCH /api/onboarding/settings`
- Billing APIs:
  - `GET /api/onboarding/billing/plans`
  - `POST /api/onboarding/billing`
  - `GET /api/onboarding/billing/callback`
- Billing plan model with starter/growth/pro/scale tiers.
- Billing status persistence and activation/cancellation state transitions.
- Billing gating of order processing when integration billing is blocked.

### Analytics and Operations APIs
- Orders listing:
  - `GET /api/orders`
- Verifications listing:
  - `GET /api/verifications`
- Verification stats:
  - `GET /api/verifications/stats`
- Organization management:
  - `POST /api/organizations`
  - `PATCH /api/organizations/current`

### Security and Platform Hardening
- Global exception filter.
- Raw body enabled for secure webhook signature verification.
- Global security middleware:
  - CSP for Shopify embedding
  - CORS controls
  - HSTS in production
  - common security headers

## WhatsApp Integration Features
- WhatsApp webhook verification:
  - `GET /webhooks/whatsapp`
- Incoming webhook processing:
  - `POST /webhooks/whatsapp`
- Outbound template verification messages with language resolution:
  - Arabic/English explicit or auto-detection from phone prefix.
- Quick reply payload parsing for confirm/cancel actions.

## Frontend Features

### Mode-Aware Runtime
- Embedded detection using `shop` and `host` params.
- Runtime branching:
  - Embedded mode uses Shopify App Bridge + Polaris
  - Standalone mode uses Supabase auth + custom shell

### Embedded Guards and Routing
- Embedded auth gate that:
  - Attempts token exchange
  - Falls back to install check
  - Redirects by onboarding status
- Route-level onboarding gating for landing/dashboard/onboarding.

### Dashboard
- Shared dashboard domain hooks.
- Stats + usage presentation.
- Verifications table (embedded and standalone skins).
- Empty state with test verification trigger support.

### Onboarding UX
- Multi-step embedded onboarding with step counter and validation.
- Dynamic billing plans loaded from backend.
- Billing confirmation redirect behavior compatible with iframe context.

### Settings UX
- Persisted integration settings editing.
- Billing status labeling and plan-change flow.
- Usage overview and plan comparison components.

### Marketing and Waitlist
- Multi-section marketing homepage (hero/problem/solution/how-it-works/pricing/ROI/FAQ/social proof).
- Interactive demo chat components.
- Waitlist API route persisting submissions to Google Sheets.
- Basic in-memory rate limiting for waitlist submissions.

## Internationalization
- Locale-prefixed routes.
- Arabic and English message catalogs.
- RTL/LTR support based on locale.

## Data Layer
- Drizzle ORM schema and migrations under backend project.
- Multi-tenant organization/integration/membership model.
- Usage and webhook event persistence.

## Deployment-Relevant Capabilities Already Present
- Backend production build and lint scripts.
- Frontend production build script.
- Environment-driven configuration for API URLs, billing behavior, Shopify, Redis, and WhatsApp.
- Shopify app config files present for CLI workflows.
