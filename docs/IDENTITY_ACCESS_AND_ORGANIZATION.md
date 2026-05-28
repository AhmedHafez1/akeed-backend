# Identity, Access, And Organization Management

Last updated: 2026-05-28

## Purpose

This document explains how Akeed authenticates users, authorizes API requests, and manages organizations. Akeed supports two runtime modes — Shopify embedded and standalone SaaS — each with its own authentication provider. A unified dual-auth layer normalizes both flows into a single identity shape so all downstream services work identically regardless of the entry point.

For billing plan activation during onboarding, see `ONBOARDING_AND_BILLING.md`.
For merchant-facing dashboard and settings, see `MERCHANT_OPERATIONS.md`.

## Scope

In scope:

- Dual-mode architecture (embedded Shopify vs standalone SaaS).
- Shopify OAuth install flow (legacy code exchange).
- Shopify App Bridge v4 token exchange (seamless install).
- Shopify session token validation (ongoing API auth).
- Supabase email/password signup, login, password reset.
- `DualAuthGuard` — the unified API gate.
- `TokenValidatorService` — JWT detection and validation.
- Organization creation, membership, and WhatsApp config.
- Webhook HMAC verification.
- Billing callback HMAC verification and rate limiting.
- Security middleware (CSP, CORS, headers).
- Token encryption at rest.
- Frontend auth gates, layout routing, and mode detection.

Out of scope:

- Onboarding step flow (see `ONBOARDING_AND_BILLING.md`).
- Order and verification business logic (see `ORDER_CONFIRMATION_WORKFLOW.md`).
- Dashboard screens (see `MERCHANT_OPERATIONS.md`).

## Dual-Mode Architecture

Akeed runs in two modes. The mode is determined at the frontend and carried through to the backend via the `Authorization` header.

| Mode       | Auth provider | Token type              | Frontend entry       | User creation           |
| ---------- | ------------- | ----------------------- | -------------------- | ----------------------- |
| Embedded   | Shopify       | HMAC-SHA256 session JWT | Shopify Admin iframe | Auto-created on install |
| Standalone | Supabase      | Supabase JWT            | `app.akeed.com`      | Email/password signup   |

Both modes resolve to the same `AuthenticatedUser` shape:

```ts
interface AuthenticatedUser {
  userId: string;
  orgId: string;
  source: 'shopify' | 'supabase';
  shop?: string; // only present for Shopify
}
```

All downstream services receive this uniform identity via `@CurrentUser()` and never need to know which auth provider was used.

## Authentication Flows

### Flow 1 — Shopify App Install (Legacy OAuth)

Used when a merchant installs the app from the Shopify App Store or enters their shop domain on the standalone login page.

```
Merchant → GET /api/auth/shopify?shop=X
  → Backend builds OAuth URL (API key, scopes, signed state, redirect URI)
  → Redirect to Shopify OAuth consent screen
  → Shopify redirects to GET /api/auth/shopify/callback?shop=X&code=Y&state=Z&hmac=H
  → Backend verifies HMAC, verifies signed state (HMAC + 10-min TTL)
  → Exchanges code for offline access token
  → Persists org + integration + membership
  → Registers webhooks
  → Redirects to frontend
```

State parameter is HMAC-signed with `SHOPIFY_API_SECRET`, includes a nonce, and has a 10-minute TTL.

### Flow 2 — Shopify App Bridge v4 Token Exchange (Seamless Install)

Used when the merchant opens the app inside Shopify Admin and the app is not yet installed or needs a fresh offline token.

```
EmbeddedAuthGate (frontend)
  → Gets session token from window.shopify.idToken()
  → POST /api/auth/shopify/token-exchange { sessionToken }
  → Backend verifies JWT (HMAC-SHA256, exp, nbf, aud)
  → If already installed → short-circuits with success
  → Exchanges session token for offline access token (token_exchange grant type)
  → Persists org + integration + membership
  → Registers webhooks
  → Returns { installed: true }
```

### Flow 3 — Shopify Session Auth (Ongoing API Access)

Used for every API call from the embedded frontend after install.

```
Frontend: fetchWithAuth(url)
  → Calls window.shopify.idToken() (cached with exp-5s TTL, fallback 30s)
  → Sets Authorization: Bearer <session_token>
  → DualAuthGuard extracts token
  → TokenValidatorService detects Shopify (dest contains myshopify.com)
  → Verifies HMAC-SHA256 signature with SHOPIFY_API_SECRET
  → Validates exp, nbf, aud (must equal SHOPIFY_API_KEY)
  → Extracts shop domain from dest claim
  → Looks up integration by platform domain
  → Finds owner membership
  → Returns AuthenticatedUser { userId, orgId, source: 'shopify', shop }
```

On 401, the frontend clears the cached token, fetches a fresh one, and retries once.

### Flow 4 — Supabase Email/Password Auth

Used for standalone SaaS users who sign up with email/password.

**Signup:**

```
Signup page → auth.signUp(email, password, { full_name, company_name })
  → Supabase creates user with metadata
  → Frontend redirects to dashboard
  → First API call: DualAuthGuard → TokenValidatorService detects Supabase
    (aud === 'authenticated' or role === 'authenticated')
  → Calls supabase.auth.getUser(token) server-side (service role key)
  → Looks up membership → if none, AllowOrgless lets user create org
```

**Login:**

```
Login page → auth.signIn(email, password)
  → Supabase returns session (access + refresh tokens)
  → Frontend stores in local storage (Supabase client handles this)
  → Redirects to dashboard
```

**Password Reset:**

```
Forgot Password page → supabase.auth.resetPasswordForEmail(email, { redirectTo })
  → Supabase sends email with recovery link
  → Reset Password page listens for PASSWORD_RECOVERY auth state event
  → supabase.auth.updateUser({ password })
  → Validates: ≥ 8 chars, confirmation match
```

### Flow 5 — Webhook HMAC Auth

Shopify webhooks are authenticated via `ShopifyHmacGuard`:

```
Shopify → POST /webhooks/shopify/{topic}
  → ShopifyHmacGuard reads X-Shopify-Hmac-Sha256 header
  → Reads rawBody (enabled via rawBody: true in NestFactory)
  → Computes HMAC-SHA256 with SHOPIFY_API_SECRET
  → Compares with crypto.timingSafeEqual
  → If mismatch → 401 UnauthorizedException
```

### Flow 6 — Billing Callback Auth

Shopify billing callbacks are validated by two guards:

```
Shopify → GET /api/onboarding/billing/callback?shop=X&charge_id=Y&hmac=H
  → BillingCallbackRateLimitGuard: in-memory rate limit (30 req/60s per shop or IP)
  → ShopifyBillingCallbackValidationGuard:
    → Validates shop domain format
    → If hmac present: verifyShopifyHmac (sorted query string, HMAC-SHA256)
    → If hmac absent: warns but allows (relies on charge status verification downstream)
```

## DualAuthGuard

The unified API authentication gate. Applied to all protected endpoints via `@UseGuards(DualAuthGuard)`.

Execution flow:

1. Extract `Bearer <token>` from `Authorization` header. If missing → 401.
2. Check `@AllowOrgless()` metadata via Reflector.
3. Call `TokenValidatorService.validateToken(token, { allowMissingOrg })`.
4. Attach `AuthenticatedUser` to `request.user`.
5. If validation fails → 401.

The `@AllowOrgless()` decorator is used on endpoints that need to work before the user has an organization (e.g., `POST /api/organizations` during standalone onboarding).

## Token Validator Service

Auto-detects token type and validates accordingly.

### Token Detection (`detectTokenType`)

Decodes the JWT payload without signature verification and checks:

| Check                                                   | Result        |
| ------------------------------------------------------- | ------------- |
| `dest` contains `myshopify.com`                         | `shopify`     |
| `aud === 'authenticated'` or `role === 'authenticated'` | `supabase`    |
| Neither                                                 | Unknown → 401 |

### Shopify Validation

1. Verify JWT signature: HMAC-SHA256 with `SHOPIFY_API_SECRET`, constant-time comparison via `crypto.timingSafeEqual`.
2. Validate `exp` (not expired), `nbf` (not before), `aud` (equals `SHOPIFY_API_KEY`).
3. Extract shop domain from `dest` claim.
4. Look up integration via `IntegrationsRepository.findByPlatformDomain()`.
5. Find owner membership via `MembershipsRepository.findByOrg()`.
6. Return `AuthenticatedUser` with `userId`, `orgId`, `source: 'shopify'`, `shop`.

### Supabase Validation

1. Call `supabase.auth.getUser(token)` using server-side Supabase client (service role key).
2. Look up user's organization via `MembershipsRepository.findByUser()`.
3. If no membership found:
   - If `allowMissingOrg` → return `AuthenticatedUser` with empty `orgId`.
   - Otherwise → 401.

## Organization Management

### Data Model

**Organizations table:**

| Column                     | Type      | Notes                            |
| -------------------------- | --------- | -------------------------------- |
| `id`                       | UUID      | Primary key.                     |
| `name`                     | string    | Display name (max 120 chars).    |
| `slug`                     | string    | Unique, kebab-case identifier.   |
| `plan_type`                | enum      | `free`, `pro`, `enterprise`.     |
| `wa_phone_number_id`       | string    | WhatsApp Cloud API phone ID.     |
| `wa_business_account_id`   | string    | WhatsApp Business Account ID.    |
| `wa_access_token`          | string    | Encrypted at rest (AES-256-GCM). |
| `created_at`, `updated_at` | timestamp | Auto-managed.                    |

RLS policies: owners can update, authenticated users can select.

**Memberships table:**

| Column    | Type | Notes                                |
| --------- | ---- | ------------------------------------ |
| `id`      | UUID | Primary key.                         |
| `org_id`  | UUID | FK → organizations (cascade delete). |
| `user_id` | UUID | FK → auth.users (cascade delete).    |
| `role`    | enum | `owner`, `admin`, `viewer`.          |

Unique constraint on `(org_id, user_id)`. RLS policies: owners have all operations, users can select their own.

**Integrations table (auth-relevant columns):**

| Column               | Type    | Notes                                        |
| -------------------- | ------- | -------------------------------------------- |
| `id`                 | UUID    | Primary key.                                 |
| `org_id`             | UUID    | FK → organizations.                          |
| `platform_type`      | enum    | `shopify`, `salla`, `zid`, `woocommerce`.    |
| `platform_store_url` | string  | Shop domain (e.g., `mystore.myshopify.com`). |
| `access_token`       | string  | Encrypted at rest (AES-256-GCM).             |
| `is_active`          | boolean | Deactivated on app uninstall.                |

### Organization Creation

**Shopify flow (automatic):**

During Shopify install (OAuth callback or token exchange), `ShopifyAuthService.handlePersistence()`:

1. Creates/updates org by slug (slug = shop domain, name = shop name without `.myshopify.com`).
2. Upserts integration with encrypted access token.
3. For new orgs: creates a Supabase user with email `{shop}@akeed-shopify.internal` and a random 32-char password.
4. Creates owner membership linking the Supabase user to the org.

**Standalone flow (manual):**

After signup, the user has no org. During onboarding:

1. Frontend calls `POST /api/organizations` with `{ name, slug }`.
2. Endpoint is decorated with `@AllowOrgless()` so `DualAuthGuard` passes without an org.
3. Backend upserts org by slug, creates owner membership.

### Organization Update

`PATCH /api/organizations/current` updates WhatsApp configuration:

- `wa_phone_number_id`
- `wa_business_account_id`
- `wa_access_token` (encrypted before storage)

## Token Encryption

Shopify access tokens and WhatsApp access tokens are encrypted at rest using AES-256-GCM.

Format: `v1:<iv>:<authTag>:<ciphertext>` (all base64url encoded).

Key source: `SHOPIFY_TOKEN_ENCRYPTION_KEY` environment variable. Accepts 64-char hex, base64, or 32-byte UTF-8.

On read, `decryptToken()` detects the `v1:` prefix. If the token is not in encrypted format, it is returned as-is (backward compatibility with tokens stored before encryption was added).

## Security Middleware

Applied to all routes via `AppModule.configure()`.

### Content Security Policy

```
frame-ancestors 'self' https://admin.shopify.com https://*.myshopify.com
```

Required for Shopify Admin iframe embedding. Without this, the browser blocks the app inside the Admin panel.

### CORS

- Dynamic origin checking from `CORS_ALLOWED_ORIGINS` environment variable.
- Falls back to `*` in development.
- Restrictive in production (only listed origins).
- Allowed headers include `Authorization`, `ngrok-skip-browser-warning`, `x-shopify-access-token`.
- Handles OPTIONS preflight.

### Additional Headers

- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (restrictive defaults)

## Frontend Auth Architecture

### Mode Detection

`useAkeedMode()` hook determines the runtime mode:

1. Checks URL params for `shop` + `host` (Shopify embeds these when opening the app).
2. If found, persists to `sessionStorage` for subsequent navigations within the iframe.
3. Polls for `window.shopify` global (App Bridge v4 CDN script) with 3-second timeout and 50ms interval.
4. Returns `{ mode, isEmbedded, isStandalone, shopDomain, hostParam, shopify, isLoading }`.

### Embedded Context Persistence

`embedded-context.ts` handles session-level persistence of the Shopify embedded context:

- On first load: reads `shop` + `host` from URL params → stores in `sessionStorage`.
- On subsequent navigations: reads from `sessionStorage` (URL params may be stripped by client-side routing).
- `appendEmbeddedParamsToPath()` re-appends `shop` + `host` to navigation URLs so the context is preserved across page transitions.

### Token Caching (Embedded)

Shopify session tokens from `window.shopify.idToken()` are cached in a module-level variable:

- TTL: derived from the JWT `exp` claim minus 5 seconds safety margin.
- Fallback TTL: 30 seconds if `exp` cannot be parsed.
- On 401 response: cache is cleared, a fresh token is fetched, and the request is retried once.

### Auth Gates

**`EmbeddedAuthGate`** (embedded mode):

1. Checks module-level install cache → if warm, skips API call.
2. Primary path: token exchange via `POST /api/auth/shopify/token-exchange` with the session token.
3. Fallback path: legacy install check via `GET /api/auth/shopify/check?shop=...`.
4. If not installed → redirects to OAuth (opens in `_top` frame to break out of the iframe).
5. Optional onboarding gate: fetches onboarding status and redirects to onboarding or dashboard as needed.
6. Install status cached for 5 minutes. Completed onboarding status cached for 5 minutes.
7. Onboarding status fetch uses retry logic: up to 3 retries with 350ms backoff (handles token timing races after install).

**`AuthGuard`** (standalone mode):

1. Skips auth check for public and auth routes (login, signup, forgot-password, etc.).
2. Checks `supabase.auth.getSession()`.
3. If no session → redirects to login page.
4. Listens for `onAuthStateChange` to handle sign-outs reactively.

### Layout Routing

`AppLayout` → `useAkeedMode()`:

| Mode       | Layout             | Auth gate                          |
| ---------- | ------------------ | ---------------------------------- |
| Embedded   | `EmbeddedLayout`   | `EmbeddedAuthGate` per page        |
| Standalone | `StandaloneLayout` | `AuthGuard` wraps protected routes |

`StandaloneLayout` has three branches:

| Route type | Rendering                                     |
| ---------- | --------------------------------------------- |
| Auth       | `AuthLayout` (minimal header + centered form) |
| Public     | Marketing `Header` + `Footer`, no auth check  |
| Protected  | `AuthGuard` + `AppHeader`                     |

`EmbeddedLayout` wraps content in Shopify Polaris `AppProvider` + `Frame` and loads the App Bridge CDN script.

### Route Classification

Defined in `shared/lib/locale.ts`:

| Category      | Routes                                                                    |
| ------------- | ------------------------------------------------------------------------- |
| Auth routes   | `/login`, `/signup`, `/onboarding`, `/forgot-password`, `/reset-password` |
| Public routes | `/`, `/terms`, `/privacy`, `/support`                                     |
| Protected     | Everything else (dashboard, settings, etc.)                               |

### Frontend Auth API

The `auth` object in `shared/lib/auth.ts` provides:

| Method                    | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `signUp(email, pw, meta)` | Supabase signup with full_name, company_name metadata. |
| `signIn(email, pw)`       | Supabase login, returns session.                       |
| `signOut()`               | Supabase sign-out.                                     |
| `getCurrentUser()`        | Returns current Supabase user.                         |
| `isAuthenticated()`       | Boolean session check.                                 |
| `getLoginPath()`          | Locale-aware login URL.                                |
| `getSignupPath()`         | Locale-aware signup URL.                               |
| `getDashboardPath()`      | Locale-aware dashboard URL.                            |
| `redirectToLogin()`       | Navigate to login.                                     |
| `redirectToSignup()`      | Navigate to signup.                                    |
| `redirectToDashboard()`   | Navigate to dashboard.                                 |

The `api` object provides authenticated HTTP helpers:

| Method                   | Purpose                |
| ------------------------ | ---------------------- |
| `api.get<T>(url)`        | GET with auth header.  |
| `api.post<T>(url, body)` | POST with auth header. |

Both use `fetchWithAuth()` which auto-injects the appropriate token (Shopify session token or Supabase JWT) based on the detected mode.

## Backend Code Map

| Area                     | File                                                               | Responsibility                                                                    |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Auth module              | `modules/auth/auth.module.ts`                                      | Exports `DualAuthGuard`, `TokenValidatorService`, `AuthService`.                  |
| Auth controller          | `modules/auth/auth.controller.ts`                                  | `GET /api/auth/me`, `GET /api/auth/status`.                                       |
| Auth service             | `modules/auth/auth.service.ts`                                     | Resolves current user with org context.                                           |
| Auth DTOs                | `modules/auth/dto/auth.dto.ts`                                     | `MeResponseDto`, `AuthStatusResponseDto`, `AuthOrganizationDto`.                  |
| Dual auth guard          | `modules/auth/guards/dual-auth.guard.ts`                           | Unified `CanActivate` guard for all protected endpoints.                          |
| Current user decorator   | `modules/auth/guards/current-user.decorator.ts`                    | `@CurrentUser()` parameter decorator.                                             |
| Orgless decorator        | `modules/auth/guards/orgless.decorator.ts`                         | `@AllowOrgless()` metadata decorator.                                             |
| Token validator          | `modules/auth/services/token-validator.service.ts`                 | JWT detection (Shopify vs Supabase), signature verification, identity resolution. |
| Organizations module     | `modules/organizations/organizations.module.ts`                    | Imports `DatabaseModule`, `AuthModule`. Exports `OrganizationsService`.           |
| Organizations controller | `modules/organizations/organizations.controller.ts`                | `POST /api/organizations`, `PATCH /api/organizations/current`.                    |
| Organizations service    | `modules/organizations/organizations.service.ts`                   | Org upsert, WhatsApp config update, token decryption on read.                     |
| Organizations DTOs       | `modules/organizations/dto/organizations.dto.ts`                   | `CreateOrganizationDto`, `UpdateOrganizationDto`, `OrganizationResponseDto`.      |
| Shopify auth controller  | `infrastructure/spokes/shopify/shopify-auth.controller.ts`         | `GET /api/auth/shopify`, `GET /callback`, `POST /token-exchange`, `GET /check`.   |
| Shopify auth service     | `infrastructure/spokes/shopify/services/shopify-auth.service.ts`   | OAuth flow, token exchange, persistence, webhook registration.                    |
| Shopify auth DTOs        | `infrastructure/spokes/shopify/dto/shopify-auth.dto.ts`            | `ShopifyLoginQueryDto`, `ShopifyCallbackQueryDto`, `ShopifyTokenExchangeDto`.     |
| Shopify utils            | `infrastructure/spokes/shopify/shopify.utils.ts`                   | `validateShop()`, `generateNonce()`, `verifyShopifyHmac()`.                       |
| Shopify HMAC guard       | `shared/guards/shopify-hmac.guard.ts`                              | Webhook body HMAC verification.                                                   |
| Billing callback guard   | `shared/guards/shopify-billing-callback-validation.guard.ts`       | Billing callback query string HMAC verification.                                  |
| Rate limit guard         | `shared/guards/billing-callback-rate-limit.guard.ts`               | In-memory rate limiter for billing callbacks (30 req/60s).                        |
| Security middleware      | `shared/middleware/security.middleware.ts`                         | CSP, CORS, security headers for all routes.                                       |
| Token encryption         | `shared/utils/token-encryption.util.ts`                            | AES-256-GCM encrypt/decrypt for access tokens at rest.                            |
| Organizations repository | `infrastructure/database/repositories/organizations.repository.ts` | CRUD with slug-based upsert.                                                      |
| Memberships repository   | `infrastructure/database/repositories/memberships.repository.ts`   | CRUD with `(org_id, user_id)` upsert.                                             |
| Integrations repository  | `infrastructure/database/repositories/integrations.repository.ts`  | Platform domain lookup, upsert with token encryption.                             |

## Frontend Code Map

| Area                  | File                                           | Responsibility                                                                      |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Auth library          | `shared/lib/auth.ts`                           | Supabase client, token retrieval, `fetchWithAuth`, `api` helpers, `auth` methods.   |
| Mode detection hook   | `shared/hooks/useAkeedMode.ts`                 | Runtime embedded/standalone detection with App Bridge polling.                      |
| Embedded context      | `shared/lib/embedded-context.ts`               | Session-level persistence of `shop` + `host` params.                                |
| Embedded auth gate    | `shared/auth/EmbeddedAuthGate.tsx`             | Install check, token exchange, onboarding gate with caching.                        |
| Standalone auth guard | `shared/auth/AuthGuard.tsx`                    | Session check, sign-out listener, redirect to login.                                |
| Embedded auth helpers | `features/onboarding/lib/embeddedAuth.ts`      | `performTokenExchange`, `checkEmbeddedInstall`, onboarding status fetch with retry. |
| App layout            | `shared/layout/AppLayout.tsx`                  | Mode-aware layout switching (embedded vs standalone).                               |
| Standalone layout     | `shared/layout/StandaloneLayout.tsx`           | Three-branch routing: auth, public, protected.                                      |
| Embedded layout       | `shared/layout/EmbeddedLayout.tsx`             | Polaris `AppProvider` + `Frame` + `EmbeddedNavigation`.                             |
| Auth layout           | `shared/layout/AuthLayout.tsx`                 | Minimal shell for login/signup/reset pages.                                         |
| App Bridge script     | `shared/layout/ShopifyAppBridgeScript.tsx`     | Conditional CDN script load for embedded mode.                                      |
| Login page            | `app/[locale]/(auth)/login/page.tsx`           | Email/password form + Shopify OAuth entry.                                          |
| Signup page           | `app/[locale]/(auth)/signup/page.tsx`          | Email/password signup with metadata.                                                |
| Forgot password page  | `app/[locale]/(auth)/forgot-password/page.tsx` | Supabase password reset email.                                                      |
| Reset password page   | `app/[locale]/(auth)/reset-password/page.tsx`  | Password update with recovery token.                                                |
| HTTP utilities        | `shared/lib/http.ts`                           | `parseJsonResponse`, `getErrorMessage`.                                             |
| Route classification  | `shared/lib/locale.ts`                         | Auth/public/protected route lists, `isAuthRoute()`, `isPublicRoute()`.              |
| Window types          | `shared/types/window.model.ts`                 | TypeScript types for `window.shopify` (App Bridge v4).                              |

## API Reference

| Method  | Endpoint                           | Auth                                | Purpose                                            |
| ------- | ---------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `GET`   | `/api/auth/me`                     | `DualAuthGuard`                     | Current user context (userId, orgId, org details). |
| `GET`   | `/api/auth/status`                 | `DualAuthGuard`                     | Auth health check: `{ authenticated, source }`.    |
| `GET`   | `/api/auth/shopify`                | None (public)                       | Shopify OAuth install redirect.                    |
| `GET`   | `/api/auth/shopify/callback`       | Shopify HMAC (query string)         | OAuth code exchange callback.                      |
| `POST`  | `/api/auth/shopify/token-exchange` | None (session token in body)        | App Bridge v4 seamless install.                    |
| `GET`   | `/api/auth/shopify/check`          | None (public)                       | Check if shop is installed: `{ installed }`.       |
| `POST`  | `/api/organizations`               | `DualAuthGuard` + `@AllowOrgless()` | Create organization (standalone onboarding).       |
| `PATCH` | `/api/organizations/current`       | `DualAuthGuard`                     | Update WhatsApp config for current org.            |

### Request / Response Examples

**`GET /api/auth/me` response:**

```json
{
  "user_id": "uuid",
  "org_id": "uuid",
  "source": "shopify",
  "shop": "mystore.myshopify.com",
  "organization": {
    "id": "uuid",
    "name": "My Store",
    "slug": "mystore.myshopify.com",
    "plan_type": "free"
  }
}
```

**`POST /api/organizations` request:**

```json
{
  "name": "My Company",
  "slug": "my-company"
}
```

Slug validation: max 120 chars, kebab-case regex.

**`PATCH /api/organizations/current` request:**

```json
{
  "wa_phone_number_id": "1234567890",
  "wa_business_account_id": "0987654321",
  "wa_access_token": "EAAxxxxxxx"
}
```

All fields optional. Access token is encrypted before storage.

## Environment Variables

| Variable                        | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `SHOPIFY_API_KEY`               | Shopify app API key (used as JWT `aud` for validation).    |
| `SHOPIFY_API_SECRET`            | Shopify app secret (HMAC-SHA256 signing key).              |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY`  | AES-256-GCM key for encrypting tokens at rest.             |
| `SHOPIFY_SCOPES`                | OAuth permission scopes requested during install.          |
| `APP_URL`                       | Application base URL (used for OAuth redirect URI).        |
| `SUPABASE_URL`                  | Supabase project URL.                                      |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase service role key (server-side user verification). |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase URL (frontend).                                   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (frontend).                         |
| `CORS_ALLOWED_ORIGINS`          | Comma-separated allowed CORS origins.                      |

## Reliability And Safety

### Cryptographic Security

- All HMAC comparisons use `crypto.timingSafeEqual` to prevent timing attacks.
- Shopify session tokens are verified with HMAC-SHA256 using `SHOPIFY_API_SECRET`.
- OAuth state parameters are HMAC-signed with 10-minute TTL and nonce.
- Access tokens are encrypted at rest with AES-256-GCM (`v1:<iv>:<authTag>:<ciphertext>`).
- Backward compatibility: `decryptToken()` returns plaintext tokens that predate encryption.

### Defense In Depth

- Webhook HMAC verification requires `rawBody` (enabled at app bootstrap).
- Billing callback guard validates shop domain format before HMAC check.
- Rate limiter on billing callbacks (30 requests per 60 seconds per shop/IP).
- Rate limiter auto-cleans when map exceeds 5000 entries.
- CSP `frame-ancestors` restricts iframe embedding to Shopify Admin domains.
- CORS is restrictive in production, permissive only in development.

### Token Lifecycle

- Shopify session tokens are short-lived JWTs (typically ~1 minute).
- Frontend caches tokens with `exp - 5s` TTL, fallback 30s.
- On 401, cache is cleared, fresh token fetched, request retried once.
- Supabase handles token refresh automatically via its client library.

### Idempotency

- Organization creation uses slug-based upsert: re-calling with the same slug updates rather than duplicates.
- Membership creation uses `(org_id, user_id)` upsert.
- Integration upsert keyed on `(org_id, platform_store_url)`.
- Token exchange short-circuits if shop is already installed.

### Graceful Degradation

- `EmbeddedAuthGate` tries token exchange first, falls back to legacy install check.
- Onboarding status fetch retries up to 3 times with 350ms backoff for token timing races.
- Install and onboarding status are cached for 5 minutes to avoid redundant API calls.
- If org lookup fails in `AuthService.getCurrentUser()`, the response omits org details but does not fail.

## Known Business Decisions

- Shopify merchants get a Supabase user auto-created with an internal email (`{shop}@akeed-shopify.internal`). This enables a unified user model across both auth modes.
- The `AllowOrgless` decorator exists solely for the standalone onboarding flow where a user signs up before creating an org.
- Billing callback HMAC is optional: if Shopify omits it, the guard warns but allows the request through, relying on downstream charge status verification.
- The standalone login page includes a Shopify OAuth section where merchants can enter their shop domain to start the install flow.
- The embedded layout is dynamically imported with SSR disabled to avoid App Bridge issues during server rendering.
- `rawBody: true` is enabled globally at the NestJS app level (not per-route) to support webhook HMAC verification.
- Webhook registration happens automatically after every install (both OAuth and token exchange paths).

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

| Scenario                                                 | Expected result                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Shopify OAuth install from App Store                     | OAuth flow completes, org + integration + membership created, webhooks registered.        |
| Token exchange from App Bridge v4 (first install)        | Offline token obtained, org persisted, `{ installed: true }` returned.                    |
| Token exchange for already-installed shop                | Short-circuits: returns `{ installed: true }` without re-exchanging.                      |
| API call with valid Shopify session token                | `DualAuthGuard` passes, `AuthenticatedUser` attached with `source: 'shopify'`.            |
| API call with expired Shopify session token              | Frontend retries once with fresh token from `window.shopify.idToken()`.                   |
| API call with valid Supabase JWT                         | `DualAuthGuard` passes, `AuthenticatedUser` attached with `source: 'supabase'`.           |
| Standalone signup with email/password                    | Supabase user created, redirect to dashboard, org creation via `POST /api/organizations`. |
| Standalone login with valid credentials                  | Session returned, redirect to dashboard.                                                  |
| Password reset flow                                      | Email sent, recovery link works, password updated (≥ 8 chars).                            |
| `GET /api/auth/me` returns org context                   | Response includes `organization` with name, slug, plan_type.                              |
| Webhook with valid HMAC                                  | `ShopifyHmacGuard` passes, webhook processed.                                             |
| Webhook with invalid HMAC                                | 401 UnauthorizedException.                                                                |
| Webhook with missing `rawBody`                           | 401 UnauthorizedException (guard checks for rawBody).                                     |
| Billing callback with valid HMAC                         | Guard passes, charge verified downstream.                                                 |
| Billing callback without HMAC                            | Guard warns but allows, relying on charge status verification.                            |
| Billing callback rate limit exceeded                     | 429 Too Many Requests.                                                                    |
| `POST /api/organizations` without org (AllowOrgless)     | Org created, membership established.                                                      |
| `POST /api/organizations` with duplicate slug            | Upsert: existing org updated, no error.                                                   |
| `PATCH /api/organizations/current` with WA config        | Token encrypted and stored, decrypted on read.                                            |
| Embedded auth gate with cached install status            | No API call, immediate render.                                                            |
| Embedded auth gate with not-installed shop               | Redirects to OAuth in `_top` frame.                                                       |
| Standalone auth guard on protected route without session | Redirects to login page.                                                                  |
| Standalone auth guard on public route without session    | No redirect, content renders normally.                                                    |
