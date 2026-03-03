<!-- @format -->

# Akeed FE/BE Codebase Review (MVP Readiness)

Date: 2026-03-03  
Scope: `akeed-frontend` + `akeed-backend`

---

## App Description & Implemented Features

### What the app does

Akeed is a multi-tenant COD verification platform for merchants. It ingests Shopify orders, sends WhatsApp verification prompts to customers, tracks responses, and reflects outcomes back to Shopify (e.g., order tagging for confirmed/canceled decisions).

### Backend (`akeed-backend`) features

- **Dual authentication model**
  - Shopify session-token auth (embedded mode)
  - Supabase JWT auth (standalone mode)
- **Shopify install/auth flows**
  - Legacy OAuth callback flow (`/auth/shopify/callback`)
  - App Bridge token exchange flow (`/auth/shopify/token-exchange`)
- **Webhook handling**
  - Shopify: orders create, app uninstalled, app subscriptions update, GDPR webhooks
  - WhatsApp webhook verification + status/reply processing
- **Verification orchestration**
  - COD eligibility checks before sending
  - Idempotent order/verification creation
  - WhatsApp template dispatch + status lifecycle updates
  - Shopify order tagging on terminal outcomes
- **Onboarding + billing APIs**
  - Integration settings, onboarding state, billing plan bootstrap/callback
- **Usage/analytics APIs**
  - Verification list + filter
  - Verification stats (date range, usage, savings)
- **Data model (Drizzle/Postgres)**
  - Organizations, memberships, integrations, orders, verifications, webhook event dedupe, monthly usage

### Frontend (`akeed-frontend`) features

- **Dual runtime UX**
  - Embedded Shopify app mode (Polaris + App Bridge v4 script + `ui-nav-menu`)
  - Standalone SaaS mode (custom app shell)
- **Internationalization**
  - Arabic/English locale routing and RTL support
- **Marketing/public site**
  - Hero, problem/solution, how-it-works, ROI calculator, pricing, FAQ
- **Auth/onboarding**
  - Standalone login/signup (Supabase)
  - Embedded install gating + onboarding wizard + billing activation
- **Dashboard and settings**
  - Verification table with status filters
  - Stats and usage view
  - Embedded settings with plan comparison and billing management
- **Waitlist ingestion endpoint**
  - Writes submissions to Google Sheets
