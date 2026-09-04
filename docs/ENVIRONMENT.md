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
  - `SHOPIFY_REDIRECT_URI` (usually `${API_URL}/api/auth/shopify/callback`)
  - `SHOPIFY_TOKEN_ENCRYPTION_KEY` (required, AES-256-GCM key used to encrypt `integrations.access_token` at rest; supported formats: 32-byte UTF-8, 64-char hex, or base64-encoded 32-byte key)

## Supabase Email Confirmation

- Add each deployed localized dashboard URL (for example, `https://app.example.com/en/dashboard` and `https://app.example.com/ar/dashboard`) to the Supabase Auth redirect allow list.
- Standalone signup passes the localized dashboard as `emailRedirectTo`. Confirmed users receive a Supabase session there, and the standalone auth gate provisions their organization before protected APIs run.
- Accounts that have not confirmed their email do not receive an organization record.

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
  - `POST /api/onboarding/billing` requires `planId` and maps to built-in plans:
    - `starter`: free, 30 WhatsApp confirmations (no Shopify charge, onboarding auto-completes; one-time claim per store).
    - `basic`: `$9.99`/month, 300 WhatsApp confirmations/month.
    - `pro`: `$22.99`/month, 1,000 WhatsApp confirmations/month.
    - `business`: public-facing Scale plan, `$49.99`/month, 2,500 WhatsApp confirmations/month.
  - Plans do not include usage-based Shopify billing line items. When the included limit is reached, sending stops until renewal or upgrade.

## Standalone Pilot Activation

- Keep `STANDALONE_PILOT_ACTIVATION_ENABLED=false` during ordinary deployments. Staff can still list accounts and create read-only previews.
- Set it to `true` only for a reviewed activation batch after migration `0027_standalone_pilot_permissions.sql` and the deployed database-grant checks pass.
- The existing `ADMIN_CONTROL_TOWER_ENABLED` and `ADMIN_REQUIRE_AAL2` controls also apply. Enabling pilot activation does not bypass the staff role or MFA requirements.
- Return the flag to `false` after the approved batch. See [US-03-02 evidence](US-03-02-STANDALONE-PILOT-ENTITLEMENTS-EVIDENCE.md) for preflight, reconciliation, and rollback steps.

### Standalone source eligibility and support policy

Standalone provisioning is eligible only for a confirmed Supabase user without a membership, or for an approved pilot organization that has no commerce source. A retry may reuse the organization's existing active Standalone source. The operation must preserve the authenticated user's deterministic first-membership selection and may create only an owner membership for a new organization.

An organization is not eligible when it owns any Shopify or other native commerce source, including an inactive historical source. It is also not eligible when it has multiple active sources or other ambiguous ownership. Support must not deactivate, replace, relabel, or convert a source to make provisioning pass. Source switching and implicit legacy repair are outside the Standalone MVP.

Before migration or pilot activation, report legacy multiple-active-source conflicts with:

```sql
SELECT
  org_id,
  COUNT(*) FILTER (WHERE is_active) AS active_source_count,
  ARRAY_AGG(id ORDER BY created_at) FILTER (WHERE is_active) AS active_source_ids,
  ARRAY_AGG(platform_type ORDER BY created_at) FILTER (WHERE is_active) AS active_platforms
FROM integrations
GROUP BY org_id
HAVING COUNT(*) FILTER (WHERE is_active) > 1
ORDER BY org_id;
```

Migration `0026_standalone_source_provisioning.sql` deliberately aborts while these conflicts exist. Record the reported organization and source identifiers; never continue by editing application data ad hoc.

Any exceptional intervention requires an approved support or migration ticket, named operator, reason, timestamp, and before/after source snapshots. Use a separately reviewed migration or runbook with explicit rollback. Rollback means disabling pilot activation or reverting the application release while retaining organizations, memberships, integrations, entitlements, audit rows, and usage history; it does not mean deleting or converting sources.

## WhatsApp (Meta) Configuration

- Use global Meta Cloud API credentials for sending and webhook verification:
  - `WA_PHONE_NUMBER_ID`
  - `WA_BUSINESS_ACCOUNT_ID`
  - `WA_ACCESS_TOKEN`
  - `WA_VERIFY_TOKEN`

## Redis (Job Queue)

The webhook processing job queue uses BullMQ backed by Redis.

- `REDIS_URL`: Redis connection string to use for the job queue.
  - Production: Railway's Redis service
  - Local: `redis://localhost:6379`
