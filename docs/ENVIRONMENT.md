# Environment Management

This project uses `dotenv` and NestJS `ConfigModule` to manage environment variables across different stages (development, production, etc.).

## Environment Files

We use a hierarchical approach to environment files:

- **`.env`**: The default fallback configuration. Used if `NODE_ENV` is not set.
- **`.env.development`**: Used when `NODE_ENV=development`.
- **`.env.production`**: Used when `NODE_ENV=production` (create this from `.env.production.example`).

## How to Switch Environments

### Development

To run in development mode (which is the default if you don't set NODE_ENV, but explicit is better):

1. Ensure you have a `.env.development` file (copied from `.env` or created with proper secrets).
2. Set `NODE_ENV=development` in your shell or script.

**PowerShell:**

```powershell
$env:NODE_ENV="development"
npm run start:dev
```

**Bash/Zsh:**

```bash
export NODE_ENV=development
npm run start:dev
```

### Production

1. Create `.env.production` using `.env.production.example`.
2. Populate it with your production secrets.
3. Build and run:

```bash
export NODE_ENV=production
npm run build
npm run start:prod
```

## Database Migrations

Drizzle Kit also respects the environment. To run migrations against a specific environment, ensure the variables are set before running the command, or rely on `drizzle.config.ts` loading logic.

```bash
# Push to development DB
export NODE_ENV=development
npm run db:push
```

## Shopify OAuth

- Configure the following variables for Shopify OAuth:
  - `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`
  - `SHOPIFY_SCOPES` (e.g., `read_orders,write_orders`)
  - `SHOPIFY_API_VERSION` (e.g., `2026-01`)
  - `API_URL` (base URL used for OAuth callback and webhook addresses)
  - `SHOPIFY_REDIRECT_URI` (usually `${API_URL}/auth/shopify/callback`)

## Shopify Billing

- Configure billing behavior explicitly with:
  - `SHOPIFY_BILLING_REQUIRED`:
    - `true`: app must create a Shopify subscription during onboarding.
    - `false`: billing step is skipped and onboarding is marked complete.
  - `SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR`:
    - `true`: if Shopify returns `Custom apps cannot use the Billing API`, onboarding continues without billing.
    - `false`: the same condition returns an API error.
  - `SHOPIFY_BILLING_CURRENCY` (e.g., `USD`)
  - `SHOPIFY_BILLING_TEST_MODE`:
    - `true`: creates test subscriptions (recommended outside production billing tests).
    - `false`: creates real charges (only for production billing validation).
  - `POST /api/onboarding/billing` now requires `planId` and maps to built-in plans:
    - `starter`: free, up to 50 verifications/month (no Shopify charge, onboarding auto-completes).
    - `growth`: `$9`, up to 500 verifications/month.
    - `pro`: `$16`, up to 1000 verifications/month.
    - `scale`: `$29`, up to 2500 verifications/month.
  - Paid plans include an optional usage-cap line item (`cappedAmount`) so successful-verification overages can be billed via usage records.

## WhatsApp (Meta) Configuration

- Use global Meta Cloud API credentials for sending and webhook verification:
  - `WA_PHONE_NUMBER_ID`
  - `WA_BUSINESS_ACCOUNT_ID`
  - `WA_ACCESS_TOKEN`
  - `WA_VERIFY_TOKEN`
