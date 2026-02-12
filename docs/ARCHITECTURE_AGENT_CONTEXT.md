# Akeed Backend Architecture Context (for Agents)

## Purpose
This guide gives agents a practical map of the backend so changes can be made quickly without breaking multi-tenant auth, webhook integrity, or verification state transitions.

## What This Service Does
- Exposes authenticated APIs for organizations, orders, and verifications.
- Handles Shopify OAuth and Shopify webhooks.
- Sends and receives WhatsApp verification events.
- Persists all operational state in PostgreSQL via Drizzle ORM.

## High-Level Architecture
- Framework: NestJS (`src/main.ts`, `src/app.module.ts`)
- Data access: Drizzle + Postgres (`src/infrastructure/database`)
- Main modules:
  - `CoreModule` -> domain APIs and services
  - `ShopifyModule` -> install/auth + Shopify webhook adapters
  - `MetaModule` -> WhatsApp webhook + sender

## Core Domain Modules
- `AuthModule`
  - `GET /auth/me`
  - `GET /auth/status`
  - Uses `DualAuthGuard` to unify Shopify and Supabase auth.
- `OrganizationsModule`
  - `POST /api/organizations`
  - `PATCH /api/organizations/current`
  - Creates/updates organization and membership context.
- `OrdersModule`
  - `GET /api/orders`
  - Org-scoped list.
- `VerificationsModule`
  - `GET /api/verifications?status=...`
  - Org-scoped verification list and status filtering.
  - Hosts `VerificationHubService` (order -> verification workflow).

## Authentication Model
- Single guard: `DualAuthGuard`.
- Token validation service auto-detects token type:
  - Shopify session JWT -> validates HMAC signature/audience/expiry.
  - Supabase JWT -> validates via Supabase auth API.
- Both paths return a normalized request user context:
  - `userId`
  - `orgId`
  - `source` (`shopify` or `supabase`)
  - optional `shop`

Important:
- `POST /api/organizations` allows orgless auth via `AllowOrgless` decorator so first-time standalone users can bootstrap an org.

## Main Feature Flows

### 1. Shopify Installation Flow
1. Frontend sends merchant to `GET /auth/shopify?shop=...`.
2. Backend checks if shop is already installed.
3. If not installed, backend generates state and redirects to Shopify OAuth.
4. Callback (`GET /auth/shopify/callback`) validates HMAC + state, exchanges code for access token.
5. Backend upserts integration and owner membership.
6. Backend registers webhooks in background (`orders/create`, `app/uninstalled`).

### 2. Order Verification Pipeline
1. Shopify posts `POST /webhooks/shopify/orders-create`.
2. `ShopifyHmacGuard` verifies webhook signature using raw body.
3. Webhook ID is recorded for idempotency (`shopify_webhook_events`).
4. Order payload is normalized into internal order shape.
5. `VerificationHubService.handleNewOrder`:
   - upserts/finds order
   - creates verification if missing
   - sends WhatsApp template
   - stores WhatsApp message ID and status `sent`

### 3. WhatsApp Status/Reply Processing
1. Meta verifies webhook via `GET /webhooks/whatsapp`.
2. Meta sends events to `POST /webhooks/whatsapp`.
3. Service parses:
   - quick-reply payloads (`confirm_<id>`, `cancel_<id>`)
   - delivery/read/status updates by `wa_message_id`
4. Terminal actions (`confirmed`, `canceled`) call `VerificationHubService.finalizeVerification`.
5. Finalization tags Shopify order via GraphQL mutation (`Akeed: Verified` or `Akeed: Canceled`).

## Database Model (Operational View)
Key tables:
- `organizations`
- `memberships`
- `integrations`
- `orders`
- `verifications`
- `shopify_webhook_events`

Key constraints used by logic:
- Unique integration by `(platform_type, platform_store_url)`.
- Unique order by `(integration_id, external_order_id)`.
- Unique active verification per order (`order_id`).
- Unique Shopify webhook ID for deduping.

## Integrations and External Dependencies
- Shopify Admin OAuth and GraphQL Admin API.
- Meta WhatsApp Cloud API.
- Supabase Auth (JWT validation + user management for Shopify install path).
- PostgreSQL (typically Supabase-hosted).

## Configuration Surfaces
Main backend env vars:
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL`
- `API_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_SCOPES`
- `SHOPIFY_API_VERSION`
- `WA_PHONE_NUMBER_ID`
- `WA_BUSINESS_ACCOUNT_ID`
- `WA_ACCESS_TOKEN`
- `WA_VERIFY_TOKEN`

## Agent Editing Guide
- Add business logic in `src/core/services`, not controllers.
- Keep controllers transport-focused.
- If adding protected APIs, use `DualAuthGuard` and return org-scoped data.
- For webhook changes:
  - preserve HMAC validation
  - preserve idempotency checks
  - keep handlers tolerant (Meta webhook currently always returns 200 pattern)
- For schema changes:
  - edit Drizzle schema first
  - generate/apply migration
  - update repositories and DTOs together

## Known Caveats
- README older references may mention `POST /webhooks/meta`; implemented path is `POST /webhooks/whatsapp`.
- Organization has WhatsApp credential fields, but outbound sender currently reads global env credentials.
