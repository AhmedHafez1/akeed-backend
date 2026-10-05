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

## Standalone Account Activation

Standalone accounts no longer wait for staff approval. `STANDALONE_CREDIT_APPROVAL_ENABLED` and the `/api/admin/standalone-billing/approvals/*` routes are retired; remove the variable from deployed environments.

- Email verification is the only gate. Supabase issues no session until the address is confirmed, and Standalone provisioning (`POST /api/organizations`) requires that session, so the Supabase project's **Confirm email** setting must stay on. The backend does not re-check confirmation itself.
- Provisioning opens the credit account `active` and posts the one-time `free_grant` of `STANDALONE_FREE_GRANT` credits (default 30) in the same transaction as the organization and source, with the owner as `actor_id` and reason `signup_auto_activation`. This happens in both billing modes, so switching `STANDALONE_CREDIT_BILLING_ENABLED` on later never strands an account without credits.
- `STANDALONE_CREDIT_BILLING_ENABLED` still decides metering. While it is `true`, provisioning writes no Starter/`not_required` entitlement and sends consume credits. While it is `false`, provisioning writes that entitlement and the credit ledger is bookkeeping only.
- The grant is exactly-once at the database boundary: the ledger key is `standalone-free-grant:<orgId>:v1`, and `credit_ledger_free_grant_key` allows one `free_grant` row per organization. Retried or concurrent provisioning never grants twice. Never delete a committed grant or reset merchant history as a rollback.
- Migration `0035_standalone_auto_activation.sql` activates accounts left `pending_approval`, posts their grant (reason `auto_activation_backfill`), then drops `approved_by`/`approved_at`/`approval_reason` and the `pending_approval` status. It aborts, naming the organizations, if any pending account has a native source, native billing history, or other than exactly one owner. Run the preflight in the [US-04.5-09 evidence](US-04.5-09-STANDALONE-AUTO-ACTIVATION-EVIDENCE.md) first and escalate conflicts; never edit data ad hoc to make it pass.
- See [US-03-02 evidence](US-03-02-STANDALONE-PILOT-ENTITLEMENTS-EVIDENCE.md) and the `US-04.5-02` evidence for the pilot and approval history this replaced.

### Standalone source eligibility and support policy

Standalone provisioning is eligible only for a confirmed Supabase user without a membership, or for a staff-approved organization that has no commerce source. A retry may reuse the organization's existing active Standalone source. The operation must preserve the authenticated user's deterministic first-membership selection and may create only an owner membership for a new organization.

An organization is not eligible when it owns any Shopify or other native commerce source, including an inactive historical source. It is also not eligible when it has multiple active sources or other ambiguous ownership. Support must not deactivate, replace, relabel, or convert a source to make provisioning pass. Source switching and implicit legacy repair are outside the Standalone MVP.

Before migration or staff approval, report legacy multiple-active-source conflicts with:

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

Any exceptional intervention requires an approved support or migration ticket, named operator, reason, timestamp, and before/after source snapshots. Use a separately reviewed migration or runbook with explicit rollback. Rollback means disabling credit approval or reverting the application release while retaining organizations, memberships, integrations, entitlements, audit rows, and usage history; it does not mean deleting or converting sources.

## Standalone Paymob Billing

`STANDALONE_CREDIT_BILLING_ENABLED` is the single switch. While it is `false` the deployment is dark: `UsageAccountingRouter.mode()` keeps Standalone sources on the periodic plan they shipped with in E04, no `PAYMOB_*` value is read, and the merchant billing APIs refuse a purchase with `BILLING_DISABLED`. Nothing about the credit tables changes, so a rollback is the same switch in reverse — holds already taken settle through credits, because settlement follows the `accounting_mode` persisted on each dispatch rather than the flag.

Setting it to `true` makes every variable below required and validated at startup (the one exception is the wallet id in `test` mode, see its row). Validation is deliberately strict: a placeholder value, a hostname that reads as a sandbox in `live` mode, credentials or a query string in a URL, or a key whose embedded `test`/`live` marker disagrees with `PAYMOB_MODE` all abort boot rather than reaching a payment.

| Variable | Notes |
| --- | --- |
| `PAYMOB_MODE` | `test` or `live`. Live requires public HTTPS hostnames throughout. |
| `PAYMOB_BASE_URL` | Paymob API origin. Every outbound call is built from this; there is no hard-coded host. |
| `PAYMOB_CALLBACK_URL` | Processed callback. The pathname **must** be `/api/webhooks/payments/paymob`, which is where the controller is mounted. |
| `PAYMOB_RETURN_URL` | Prefer the locale-less Standalone `/billing/return` URL so `NEXT_LOCALE` restores locale. Akeed appends only `purchaseRef`; the redirect is context only and never grants credits. |
| `PAYMOB_SECRET_KEY` | Server-only. Sent as `Authorization: Token <secret>`. |
| `PAYMOB_HMAC_SECRET` | Server-only. Verifies the processed callback. |
| `PAYMOB_PUBLIC_KEY` | Reaches the browser inside the hosted checkout URL. |
| `PAYMOB_CARD_INTEGRATION_ID` | Online card integration: the numeric id from Developers → Payment Integrations (e.g. `5911539`). Digit-only ids are sent to Paymob as numbers — a string would be looked up as an integration *name* — so leading zeros and values beyond the safe-integer range are rejected at startup. The same rule applies to the wallet id. |
| `PAYMOB_WALLET_INTEGRATION_ID` | Mobile wallet (Vodafone Cash). Must differ from the card integration. Required in `live`. In `test` it may be left empty: Paymob enables wallets per account on request, so a sandbox can run card-only — checkout then offers only the card integration and a callback naming any other integration is quarantined. |
| `PAYMOB_CHECKOUT_EXPIRATION_SECONDS` | Intention lifetime; also the local `checkout_expires_at`. |

Pricing is server-owned and never read from a request: `STANDALONE_CREDIT_PRICE_MINOR` (200 piastres), `STANDALONE_PURCHASE_MIN` (100), `STANDALONE_PURCHASE_MAX` (5000), `STANDALONE_PURCHASE_STEP` (50), `STANDALONE_LOW_BALANCE_THRESHOLD` (10). Startup rejects a min/max that are not ordered multiples of the step, or a maximum total that would overflow the integer money columns.

### Billing integrity reconciliation

The dedicated `billing-reconciliation` BullMQ queue runs one worker at a time. It registers a nightly scheduler for 02:30 Africa/Cairo and also accepts immediate jobs after staff settlement entry or an operator-requested run. These settings are validated at startup:

| Variable | Default | Notes |
| --- | ---: | --- |
| `STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED` | `false` | Enables Paymob inquiries made by scheduled jobs only. The existing staff inquiry remains available. |
| `STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY` | `true` | Persists comparisons and findings without changing purchase or credit state. |
| `STANDALONE_BILLING_RECONCILIATION_CRON` | `30 2 * * *` | Five-field nightly schedule. |
| `STANDALONE_BILLING_RECONCILIATION_TIMEZONE` | `Africa/Cairo` | IANA timezone used by BullMQ. |
| `STANDALONE_BILLING_RECONCILIATION_BATCH_SIZE` | `50` | Keyset page size, capped at 100. |
| `STANDALONE_BILLING_RECONCILIATION_LOOKBACK_DAYS` | `7` | Recent settled/refunded/disputed purchase window. Stale or flagged purchases are checked regardless of age. |
| `STANDALONE_BILLING_STALE_PENDING_MINUTES` | `30` | Grace period after checkout expiry before a pending purchase is flagged. |
| `STANDALONE_BILLING_BACKLOG_ALERT_COUNT` | `25` | Open-finding count threshold. |
| `STANDALONE_BILLING_BACKLOG_ALERT_AGE_MINUTES` | `120` | Oldest-open-finding threshold. |
| `STANDALONE_BILLING_PAYMOB_SLOW_MS` | `5000` | Slow inquiry threshold. |
| `STANDALONE_BILLING_PAYMOB_ERROR_RATE_PERCENT` | `20` | Provider degradation threshold. |
| `STANDALONE_BILLING_PAYMOB_ERROR_RATE_MIN_ATTEMPTS` | `5` | Minimum sample before the error-rate alert applies. |

Keep the two safety switches at their defaults for the initial deploy. Local invariants, settlement comparisons, product/finance metrics, health checks, and retention cleanup continue even while scheduled provider inquiry is disabled.

### Handling secrets

- `PAYMOB_SECRET_KEY` and `PAYMOB_HMAC_SECRET` are server-only and never leave the process. The structured logger redacts them by key name, and provider error bodies are reduced to a name and message before they are logged.
- The hosted-checkout URL embeds the intention client secret in its query, so the whole URL is a credential. It is returned once to the merchant who created the purchase, never persisted, never logged, and never present in any list or detail response. An idempotent replay of the same `Idempotency-Key` therefore answers `checkoutUrl: null` with `CHECKOUT_URL_ALREADY_ISSUED`; a fresh attempt needs a fresh key.
- Akeed stores no PAN, CVV, wallet credential or reusable token. Card metadata that arrives on a callback is redacted from logs and only its hash is persisted.

### Callback configuration

Configure the processed callback on **both** the card and the mobile-wallet integration records in the Paymob dashboard, pointing at `PAYMOB_CALLBACK_URL`. The per-intention `notification_url` is sent as well, but Paymob documents it as card-only, so the dashboard setting is what makes wallet callbacks arrive.

Do not enable Vodafone Cash traffic until a wallet callback has been captured in sandbox. Its payload shape is unverified, and the HMAC field order is a provider contract detail — see `src/infrastructure/spokes/paymob/fixtures/README.md` for the capture procedure. The response (browser) callback is never authority for a grant; only the verified processed callback is.

### Recovery

A checkout whose response was lost leaves the purchase `pending` with `reconciliation_required`. Polling `GET /api/billing/purchases/:reference` triggers a rate-limited inquiry against the same reference, and the inquiry result flows through the same ingestion path as a callback with the same fingerprint — so whichever arrives second is a proven replay and cannot grant twice. A purchase is marked `expired` only when an inquiry confirms no success; a missing callback alone never expires one.

## Standalone Billing Operations (staff console)

Staff inspect and reconcile Standalone credit accounts under `/api/admin/standalone-billing` (see the [operations runbook](STANDALONE_BILLING_OPERATIONS_RUNBOOK.md)). Every route already requires `ADMIN_CONTROL_TOWER_ENABLED`, the Supabase `akeed_role = admin` claim and, with `ADMIN_REQUIRE_AAL2`, an MFA session. Writes need two more settings:

| Variable | Notes |
| --- | --- |
| `STANDALONE_BILLING_OPERATIONS_ENABLED` | `true` or `false` (default). While `false`, staff can list, open and preview accounts but every apply, dispatch resolution, inquiry and provider-evidence route answers `403 STANDALONE_BILLING_OPERATIONS_DISABLED`. |
| `STANDALONE_BILLING_OPERATOR_IDS` | Comma-separated Supabase user ids of the staff allowed to write. Required, and each entry must be a UUID, whenever the switch is `true`; startup fails otherwise. Staff not listed get `403 STANDALONE_BILLING_OPERATOR_REQUIRED`. |

Roll out read-only first (switch off), name operators only after a recovery drill, and roll back by turning the switch off. Nothing is deleted on rollback: ledger entries, purchases, provider events and audit rows all stay.

## Standalone Bulk Order Import (E04.6)

`/api/order-imports` lets a Standalone owner or admin upload a CSV or XLSX file of orders. The behavior is documented in `BULK_ORDER_IMPORT.md`. Every route is hidden behind one switch, and the limits bound the cost of a single upload (the file is held in memory and parsed in the request). Each limit can be lowered; startup fails if one is raised past its default.

| Variable | Notes |
| --- | --- |
| `STANDALONE_BULK_IMPORT_ENABLED` | `true` or `false` (default). While `false`, every import route answers `403 IMPORT_DISABLED`. Rollback is turning it off; the import tables stay. |
| `BULK_IMPORT_PILOT_ORG_IDS` | Pilot allow-list, checked together with `STANDALONE_BULK_IMPORT_ENABLED`: a comma-separated list of organization UUIDs (a malformed entry fails startup). While it has entries, every other organization is treated as if the flag were off (`403 IMPORT_DISABLED`, and no "Import from file" action), with stop still allowed. Empty (default) means every Standalone organization, which is general availability. Batches already releasing finish whatever the list says. Rollback for one merchant: remove its UUID. |
| `BULK_IMPORT_MAX_ROWS` | Non-empty data rows per file, 1–100 (default 100). Above it: `422 IMPORT_ROW_LIMIT_EXCEEDED`. A value above 100 fails boot validation. |
| `BULK_IMPORT_MAX_COLUMNS` | Columns per file, 1–100 (default 100). Above it: `422 IMPORT_COLUMN_LIMIT_EXCEEDED`. |
| `BULK_IMPORT_MAX_OPEN_DRAFTS` | Unexpired drafts per organization, 1–20 (default 3). A new upload first deletes the uploader's own drafts, so only other members' drafts count. One more: `409 IMPORT_TOO_MANY_DRAFTS`. |
| `BULK_IMPORT_MAX_FILE_BYTES` | Upload size, 1024–5242880 (default 5 MB). Enforced while the body streams in: `413 IMPORT_FILE_TOO_LARGE`. |
| `BULK_IMPORT_MAX_UNCOMPRESSED_BYTES` | Total inflated size of an XLSX package, 1–50 MB (default 50 MB). Counted while inflating, so a zip bomb is stopped early: `422 IMPORT_FILE_UNREADABLE`. |
| `BULK_IMPORT_PARSE_TIMEOUT_MS` | Budget for reading one file, 1000–20000 (default 20000). Exceeding it answers `422 IMPORT_FILE_UNREADABLE`. |
| `BULK_IMPORT_MAX_ORDER_AGE_DAYS` | Oldest order date an import confirms, in days before today in the store timezone, 1–90 (default 7). Older rows are `excluded` with `ORDER_TOO_OLD`. Pilot default; revisit against pilot data. |
| `BULK_IMPORT_RELEASE_PER_MINUTE` | First messages an organization's releasing imports send per minute, shared by all of them, 1–120 (default 20). The release job ticks every 30 s and releases `ceil(rate × 0.5)` held orders per tick. Pilot default, not a Meta threshold; revisit after the quality-rating review (US-04.6-10). Manual and Shopify orders never pass through it. |
| `BULK_IMPORT_QUOTE_SECRET` | HMAC secret that signs the start quote (`GET /:id/start-quote`), so `POST /:id/start` can prove the count and balance the merchant saw. At least 32 characters; required while `STANDALONE_BULK_IMPORT_ENABLED=true`, otherwise startup fails. Rotating it only invalidates quotes younger than 10 minutes (`409 IMPORT_QUOTE_STALE`, the dialog re-quotes). |

## Server Order API (E05)

`POST /api/v1/orders` accepts orders from a merchant's own server, authenticated by an integration API key. These variables bound what the route can cost; none is required, and startup fails on a value outside its range.

| Variable | Notes |
| --- | --- |
| `ORDER_API_RATE_LIMIT_PER_INTEGRATION` | Requests a minute for one integration, 1–6000 (default 60). Counted by integration, not by key, so rotating or adding keys does not raise it. Above it: `429 API_RATE_LIMITED` with `Retry-After` (seconds). |
| `ORDER_API_RATE_LIMIT_GLOBAL` | Authenticated requests a minute across all integrations, 1–60000 (default 300). Counted only for requests the integration limit let through. Above it: `429 API_RATE_LIMITED`. |
| `ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP` | Requests a minute from one client address, counted before the key is checked, 1–120000 (default 600). It bounds traffic with a bad or missing key. The app does not set `trust proxy`, so behind a proxy every client shares one address and this is a ceiling for the whole route; keep it at or above the global limit. |
| `ORDER_API_MAX_BODY_BYTES` | Largest request body under `/api/v1`, 1024–102400 (default 32768). Checked while the body is read, before authentication, validation or ingestion: `413 API_PAYLOAD_TOO_LARGE`. |

The limits must satisfy per-integration ≤ global ≤ pre-auth, otherwise startup fails. All three count requests in a 60-second window; a blocked bucket stays blocked for 60 seconds. They are separate from verification usage, which the readiness gates own. The route skips the app-wide 60-a-minute IP throttler.

The counters live in memory, which is correct for one backend instance. Do not run a second API instance before moving the throttler to Redis-backed storage.

Every `/api/v1/orders` error answers `{code, message, correlationId}` (validation failures add `fieldErrors`), and every response carries `X-Correlation-Id`. A client may send its own `X-Correlation-Id` (8–64 letters, digits, `.`, `_` or `-`); any other value is replaced. Support triage starts from that ID: ask the integrator for it, then filter the backend log for `"action":"order-api-request"` and the ID. The line holds the integration, the key prefix, the outcome code, the HTTP status, the duration and the order ID, and never the key, the body or customer data.

## EasyOrders Connection (E06)

The authorized connection of an EasyOrders store (US-06-02), its order-webhook ingestion (US-06-03) and its remote status writes (US-06-04). All three ship dark, each behind its own switch. Setup, health, disconnect and reconnect (US-06-05) add no variable: connect and reconnect follow the connect switch and the pilot list, while disconnect and the health read work with everything off, so turning the feature off never traps a merchant in a connection.

| Variable | Notes |
| --- | --- |
| `EASYORDERS_CONNECT_ENABLED` | `true` or `false` (default). While `false`, `POST /api/easyorders/install` and the install callback answer `404 EASYORDERS_CONNECT_UNAVAILABLE`, the status endpoint reports `unavailable`, and signup cannot create a source-less organization (`409 SOURCE_CONNECT_UNAVAILABLE`) unless another connectable source (`WOOCOMMERCE_CONNECT_ENABLED`) is on. Rollback is turning it off; connected integrations and both EasyOrders tables stay. |
| `EASYORDERS_PILOT_ORG_IDS` | Optional pilot allow-list: a comma-separated list of organization UUIDs (a malformed entry fails startup). Empty (default) means any organization may start an install or have a callback honoured; a populated list restricts access to listed organizations. Removing a UUID stops new installs for that organization; an existing connection is not removed. |
| `EASYORDERS_PUBLIC_API_BASE_URL` | Required when enabled. Public base of this API, used to build the install callback URL and the two webhook URLs. Must be `https` outside development (the API key travels through the seller's browser to it). No trailing slash, query or fragment. |
| `EASYORDERS_APP_BASE_URL` | Required when enabled. Public base of the web app: the post-install redirect (`/<locale>/onboarding`) and the app icon. Same rules as above. |
| `EASYORDERS_INGESTION_ENABLED` | `true` or `false` (default). While `false`, `POST /webhooks/easyorders/orders/:token` and `.../status/:token` answer `404` and store nothing, which is what they answered before US-06-03. Independent of the connect switch, so a store can be connected and checked before its orders are accepted. Rollback is turning it off; events already queued are still processed. Keep it off for real merchants until the US-06-01 go-live verification has observed a real delivery. |
| `EASYORDERS_OUTCOME_SYNC_ENABLED` | `true` or `false` (default). While `false` the EasyOrders outcome adapter has no capability: no order status is ever read from or written to EasyOrders, every outcome is recorded as `unsupported` in `commerce_outcome_syncs`, and the merchant's cancel action is not offered. Rollback is turning it off; a retry already queued then records `unsupported` and stops. Keep it off for real merchants until the US-06-01 go-live verification has observed the side effects of `confirmed` and `canceled` and the product owner has accepted them. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Already required for Shopify. It also encrypts the EasyOrders API key and webhook secrets, so startup fails when EasyOrders connect, ingestion or outcome sync is enabled without it. |

The frontend shows the source picker on signup only when `NEXT_PUBLIC_EASYORDERS_CONNECT_ENABLED=true`. Turn the backend switch on first: an account that picked EasyOrders while the backend switch is off gets a normal Standalone organization.

EasyOrders requests are limited to 30 a minute per integration (at most 20 of them order lookups, so outcome writes keep headroom), counted in memory: correct for one backend instance, like the other throttlers. An outcome costs two requests, three when a lost answer forces a read-back. Outcome retries run on the `commerce-outcome-sync` BullMQ queue, which needs Redis like the other queues. An order that fails while the queue is down is recovered by the webhook reconciler, which is off unless `WEBHOOK_RECONCILIATION_ENABLED=true`.

The install callback is called by the seller's browser from `https://app.easy-orders.net`. Its CORS answer is fixed to that origin in `src/shared/config/route-scoped-cors.config.ts` and ignores `CORS_ALLOWED_ORIGINS`.

## WooCommerce Connection (E07)

The application-authentication connection of a WooCommerce store (US-07-02) and signed order-webhook ingestion (US-07-03) and outcome writes to the store (US-07-04). All three ship dark, each behind its own switch.

| Variable | Notes |
| --- | --- |
| `WOOCOMMERCE_CONNECT_ENABLED` | `true` or `false` (default). While `false`, `POST /api/woocommerce/install` and the install callback answer `404 WOOCOMMERCE_CONNECT_UNAVAILABLE` and the status endpoint reports `unavailable`. Signup can create a source-less organization while this switch or `EASYORDERS_CONNECT_ENABLED` is on. Rollback is turning it off; connected integrations and both WooCommerce tables stay. |
| `WOOCOMMERCE_PILOT_ORG_IDS` | Optional pilot allow-list: a comma-separated list of organization UUIDs (a malformed entry fails startup). Empty (default) means any organization may start an install or have a callback honoured; a populated list restricts access to listed organizations. |
| `WOOCOMMERCE_PUBLIC_API_BASE_URL` | Required when enabled. Public base of this API, used to build the install callback URL and the webhook delivery URL Akeed registers in the store. Must be `https` outside development (the store posts the new API keys to it). No trailing slash, query or fragment. |
| `WOOCOMMERCE_APP_BASE_URL` | Required when enabled. Public base of the web app: the `return_url` the store sends the merchant back to (`/<locale>/onboarding`). Same rules as above. |
| `WOOCOMMERCE_INGESTION_ENABLED` | `true` or `false` (default). While `false`, `POST /api/woocommerce/webhooks/:token` answers `404 WOOCOMMERCE_INGESTION_UNAVAILABLE` to every order delivery and stores nothing; the ping on a known token is still answered `200`. Independent of the connect switch. Rollback is turning it off; events already queued are still processed. |
| `WOOCOMMERCE_OUTCOME_SYNC_ENABLED` | `true` or `false` (default). While `false` the WooCommerce outcome adapter has no capability: no order is ever read from or written to a store, every outcome is recorded as `unsupported` in `commerce_outcome_syncs`, and the merchant's cancel action is not offered. Independent of the other two switches. Rollback is turning it off; a retry already queued then records `unsupported` and stops. Keep it off for every merchant until the US-07-06 live run has shown the real effect of the note, the marker and `cancelled` on a store and the product owner has accepted it. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Already required for Shopify. It also encrypts the WooCommerce consumer key, consumer secret and webhook secret, so startup fails when WooCommerce connect, ingestion or outcome sync is enabled without it. |

The frontend offers WooCommerce on signup only when `NEXT_PUBLIC_WOOCOMMERCE_CONNECT_ENABLED=true`. Turn the backend switch on first.

Every request Akeed sends to a store goes through the restricted outbound client (`src/shared/http/restricted-http.ts`): HTTPS on port 443, public addresses only, no redirects, 10 seconds and a capped response. It has no setting. The install callback is expected from the store's server and has no route-scoped CORS entry.

WooCommerce has no request budget: no rate limit is documented, and Akeed sends two or three requests per outcome (a read, a write, and a note for a confirmation; one more read when an answer is lost). A `429` or `503` from the store's host is retried, and its `Retry-After` is honored through the outcome retry policy. Outcome retries run on the `commerce-outcome-sync` BullMQ queue, which needs Redis like the other queues.

WooCommerce disables a webhook after five consecutive answers that are not `2xx`. While `WOOCOMMERCE_INGESTION_ENABLED` is `false` every order delivery is such an answer, so turn ingestion on before a pilot organization connects. A store connected earlier needs its webhooks re-enabled (US-07-05) once ingestion is on. Orders placed in between are not imported later.

## WhatsApp (Meta) Configuration

- Use global Meta Cloud API credentials for sending and webhook verification:
  - `WA_PHONE_NUMBER_ID`
  - `WA_ACCESS_TOKEN`
  - `WA_VERIFY_TOKEN`
  - `META_APP_SECRET`
- `WA_BUSINESS_ACCOUNT_ID` (the WhatsApp Business Account ID, numeric) is
  required only when `WHATSAPP_TEMPLATE_SYNC_ENABLED=true`; startup fails
  without it then. Sending and message webhooks never read it. See
  [WhatsApp templates](#whatsapp-templates-e08) below.

`META_APP_SECRET` is the App Secret from the Meta app dashboard (App settings >
Basic). It signs every inbound webhook. **If it does not match, the signature
guard rejects every delivery, read and reply callback**, and the symptom is not
an error the merchant can see — verifications simply sit at `sent` forever with
`confirmed_at` null. `validateEnv` (`src/shared/config/env-validation.ts`)
therefore refuses to boot when any of these are missing, or when
`META_APP_SECRET` is still the `.env.example` placeholder outside development.

The Meta app must also have the **`messages`** webhook field subscribed —
delivery/read statuses and inbound customer replies both arrive on that one
field. To tell the failure modes apart, grep the backend log for:

- `meta-webhook-request-received` — Meta reached this host at all.
- `meta-signature-verify` with `outcome: failure` — reached us and was rejected
  (wrong `META_APP_SECRET`).
- `whatsapp-webhook-receive` with `messageCount` / `statusCount` — accepted, and
  how much of each kind arrived.

### WhatsApp templates (E08)

Template sync, template webhooks and the send guardrail (US-08-04). Every
switch is off by default. With all of them off, sending is exactly what
US-08-03 shipped: any template active in Akeed is sent.

| Variable | Notes |
| --- | --- |
| `WHATSAPP_TEMPLATE_SYNC_ENABLED` | `true` or `false` (default). Turns on the 6-hourly sync from Meta (BullMQ queue `whatsapp-template-sync`), the on-demand sync and the template webhooks. Needs `WA_BUSINESS_ACCOUNT_ID`, and a `WA_ACCESS_TOKEN` with the `whatsapp_business_management` permission. While `false`, template webhooks are acknowledged and ignored, and the schedule is removed. Turning it off keeps the last snapshot. |
| `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` | `true` or `false` (default). A send uses only a template that is active in Akeed **and** approved at Meta; otherwise the language default, otherwise the send is skipped as `template_unavailable` (nothing is sent and no usage is taken). It acts only once this environment has synced at least once: before the first successful sync, sends behave as with the switch off (US-08-04 open decision 3). Rollback is turning it off. |
| `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED` | `true` or `false` (default). While `false`, every template write under `/api/admin/templates`, the on-demand sync included, answers `403 WHATSAPP_TEMPLATE_OPERATIONS_DISABLED`. |
| `WHATSAPP_TEMPLATE_OPERATOR_IDS` | Comma-separated Supabase user ids of the staff allowed to write templates. Required, each a UUID, whenever operations are on; startup fails otherwise. Staff not listed get `403 WHATSAPP_TEMPLATE_OPERATOR_REQUIRED`. |

Rollout, per environment, dev first:

1. Subscribe the Meta app's webhook to `message_template_status_update`,
   `message_template_quality_update` and `template_category_update`, next to
   `messages` (see below).
2. Set `WA_BUSINESS_ACCOUNT_ID`, turn on `WHATSAPP_TEMPLATE_SYNC_ENABLED`, and
   run one sync (`POST /api/admin/templates/sync` as an operator). Compare the
   result with the US-08-01 contract record: every registry template should be
   `approved`, with nothing `missing`.
3. Turn on `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` last.

Rollback: turn off the guardrail to restore today's sending; turn off sync to
stop reading Meta (the last snapshot stays). Nothing is deleted.

Logs to grep:

- `whatsapp-template-sync` — each run, with counts or a neutral `errorCode`
  (`rate_limited`, `auth_failed`, `permission_denied`, `provider_error`,
  `network`, `not_configured`, `too_many_pages`, `persistence_failed`).
  `GET /api/admin/templates/sync/runs` lists the last 20 runs.
- `whatsapp-template-alert` — staff alerts, with `alertCode`
  `template_unavailable` (critical: a template in use can no longer be sent),
  `template_recategorized` (critical: Meta moved, or will move, a template in
  use out of `utility`; it keeps being sent), `template_text_changed`
  (attention: the text at Meta differs from the last snapshot) or
  `template_sync_failed` (attention). A line names the template key, its
  state and how many active stores send it; never template text or customer
  data.
- `meta-template-webhook` — a template delivery that was skipped, with
  `reason` `wrong_account`, `malformed` or `template_sync_disabled`.

The admin store list shows `template_unavailable` per store: critical when no
template can be sent for a language the store sends in, attention when a
template it sends is not approved or was re-categorized and the default stands
in.

### Meta app webhook fields

Subscribe these fields in **App Dashboard > WhatsApp > Configuration**, in both
the dev and the prod app:

| Field | Needed for |
| --- | --- |
| `messages` | Delivery and read statuses, button taps and replies (since before E08). |
| `message_template_status_update` | Template review status: approved, paused, disabled, rejected and the rest (US-08-04). |
| `message_template_quality_update` | Template quality score (US-08-04). |
| `template_category_update` | Scheduled and completed re-categorizations (US-08-04). |

The three template fields need the `whatsapp_business_management` permission,
and the app must be subscribed to the WhatsApp Business Account
(`POST /{WABA_ID}/subscribed_apps`). They arrive on the same callback URL and
are signed with the same `META_APP_SECRET`. `message_template_components_update`
is not read: a sync detects changed text. If it is subscribed, it is
acknowledged and ignored.

## Redis (Job Queue)

The webhook processing job queue uses BullMQ backed by Redis.

- `REDIS_URL`: Redis connection string to use for the job queue.
  - Production: Railway's Redis service
  - Local: `redis://localhost:6379`
