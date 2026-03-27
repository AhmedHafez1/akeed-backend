# Akeed MVP - Current Implemented Features (Final Review As Of 2026-03-27)

## Product Scope

Akeed is a multi-tenant Shopify app for COD order verification using WhatsApp Cloud API.

## Review Basis

- This document was refreshed from source code (backend controllers/services, queue processor, billing domain, and frontend route/features).
- Intended as a pre-Shopify-submission feature inventory and readiness snapshot.

## Implemented User Flows

- Shopify embedded app install and authentication.
- Embedded onboarding flow with:
  - Welcome step
  - Store configuration (store name, app language, verification default language, auto-verify toggle)
  - Plan selection and billing activation
- Embedded settings page for:
  - Store configuration updates
  - Shipping currency and average shipping cost updates
  - Current plan visibility and plan changes
  - Billing management deep-linking
  - Usage overview and plan comparison
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
  - `GET /api/auth/me`
  - `GET /api/auth/status`
- OAuth hardening:
  - Signed OAuth state with TTL validation
  - Session token verification (`aud`, `exp`, `nbf`, signature) for App Bridge token exchange

### Shopify Integration

- OAuth install flow:
  - `GET /api/auth/shopify`
  - `GET /api/auth/shopify/callback`
- Install status check:
  - `GET /api/auth/shopify/check`
- App Bridge token exchange flow:
  - `POST /api/auth/shopify/token-exchange`
- Critical webhook registration at install (GraphQL + retry + idempotent handling):
  - `APP_UNINSTALLED`
  - `APP_SUBSCRIPTIONS_UPDATE`
  - `ORDERS_CREATE`
- GDPR topics are handled via webhook endpoints and app config declarations.

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
- GDPR handlers include customer export preparation, customer redaction, and full shop data deletion flow.

### Queue and Processing

- BullMQ queue for webhook processing backed by Redis.
- Async processing with retries and exponential backoff.
- Current queue behavior:
  - processing concurrency: 10
  - retry attempts: 5
  - backoff: exponential (base delay 3s)
- Platform normalizer architecture (Shopify normalizer currently wired).

### Verification Domain

- Eligibility checks before verification trigger (COD-focused logic).
- Order ingest and idempotent order creation.
- Verification lifecycle support:
  - pending
  - sent
  - delivered
  - read
  - confirmed
  - canceled
  - expired
  - failed
- Plan-limit handling:
  - when entitlement is not allowed, verification is created as `failed` with metadata `reason=plan_limit_reached`
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
- Starter plan is claim-limited per store.
- Paid plans create AppSubscription with recurring + usage (capped overage) line items.
- Usage overage reporting to Shopify is implemented; failed usage charge attempts roll back reserved slot.
- Billing callback protections:
  - per-shop/IP rate limiting guard
  - callback HMAC validation guard
- Billing status persistence and transitions support active/pending/not_required/error and blocked states (canceled/cancelled/declined/expired/frozen).
- Billing gating of order processing when integration billing is blocked.
- Billing usage periods:
  - paid plans follow rolling 30-day cycle from billing activation date
  - fallback to UTC calendar month start when activation date is not available

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
- Shopify access token encryption at rest (AES-256-GCM).

## WhatsApp Integration Features

- WhatsApp webhook verification:
  - `GET /webhooks/whatsapp`
- Incoming webhook processing:
  - `POST /webhooks/whatsapp`
- Outbound template verification messages with language resolution:
  - Arabic/English explicit or auto-detection from phone prefix
- Quick reply payload parsing for confirm/cancel actions.
- Status callbacks update verification delivery/read states.

## Frontend Features

### Mode-Aware Runtime

- Embedded detection using `shop` and `host` params.
- Runtime branching:
  - Embedded mode uses Shopify App Bridge + Polaris
  - Standalone mode uses Supabase auth + custom shell
- App Bridge readiness handling with guarded loading state.

### Embedded Guards and Routing

- Embedded auth gate that:
  - attempts token exchange
  - falls back to install check
  - redirects by onboarding status
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
- Locale preference switching from onboarding.

### Settings UX

- Persisted integration settings editing.
- Billing status labeling and plan-change flow.
- Usage overview and plan comparison components.

### Marketing and Waitlist

- Multi-section marketing homepage (hero/problem/solution/how-it-works/pricing/ROI/FAQ/social proof).
- Interactive demo chat components.
- Waitlist API route persisting submissions to Google Sheets.
- Waitlist form server-side validation (Zod + phone normalization) and in-memory IP rate limiting.

## Internationalization

- Locale-prefixed routes.
- Arabic and English message catalogs.
- RTL/LTR support based on locale.

## Data Layer

- Drizzle ORM schema and migrations under backend project.
- Multi-tenant organization/integration/membership model.
- Usage, free-plan-claims, and webhook event persistence.

## Deployment-Relevant Capabilities Already Present

- Backend production build and lint scripts.
- Frontend production build script.
- Environment-driven configuration for API URLs, billing behavior, Shopify, Redis, and WhatsApp.
- Shopify app config files present for CLI workflows.

## Final Review Snapshot (Pre-Submission)

### Strengths

- Core install -> onboarding -> billing -> webhook -> verification lifecycle is implemented end-to-end.
- GDPR webhook endpoints and data redaction flows are present.
- Billing enforcement and usage metering are wired into processing gates.

### Gaps To Address Before Shopify Submission

- Automated test coverage is currently limited (few backend unit tests, minimal e2e, no frontend automated tests).
- In-memory rate limiters are not distributed; behavior should be validated under production deployment topology.
- A full production-mode billing rehearsal (approve/decline/cancel/frozen/expired paths) should be run and evidenced.
