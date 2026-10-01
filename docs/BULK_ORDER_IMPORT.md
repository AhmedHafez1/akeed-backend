# Standalone bulk order import

Last updated: 2026-10-01

## Purpose

This document describes how a Standalone merchant imports COD orders from a CSV or XLSX file, how the file becomes **held** orders, and how the merchant starts WhatsApp confirmation. It is the engineering reference for the merchant guide in `akeed-frontend/content/docs/{en,ar}/bulk-order-import.md`. For single orders see `MANUAL_ORDER_CREATION.md`. For the confirmation lifecycle after release see `ORDER_CONFIRMATION_WORKFLOW.md`. For credits and Paymob see `ENVIRONMENT.md` and `STANDALONE_BILLING_OPERATIONS_RUNBOOK.md`. The backlog and decision history live in `Epics/04.6-standalone-bulk-order-import/README.md`.

Flow: **CSV/XLSX → map columns → preview → import (held orders) → start confirmation**. The wizard shows it as three screens (File, Check, Send). The Send screen's single action commits the ready rows and then starts release.

## Scope

In scope:

- Upload, parsing, column mapping, saved mapping profiles, row validation and deduplication.
- Idempotent commit into held orders, and the start, pause, resume and stop controls.
- Retention, abuse controls and the logs the feature emits.

Out of scope (not implemented):

- Downloadable error or results files, and a full import history list. `GET /api/order-imports` only lists open drafts and recent active imports.
- Starting a subset of an import. A start releases every held order of the batch.
- Email and line-item columns, `.xls`, and managing saved mapping profiles.
- A merchant-facing stop control in the UI (the API route exists).

## Access

- Standalone organizations only. A Shopify (embedded) organization receives `IMPORT_SOURCE_UNSUPPORTED`.
- Write routes need an owner or admin (`IMPORT_ROLE_REQUIRED`), exactly one active Standalone source, and completed onboarding (`IMPORT_SETUP_INCOMPLETE`). Read routes are open to any member, including viewers.
- `STANDALONE_BULK_IMPORT_ENABLED` is the master switch. `BULK_IMPORT_PILOT_ORG_IDS` restricts access to listed organizations while it is non-empty; empty means every Standalone organization. When access fails, routes return `IMPORT_DISABLED`. `POST /:id/stop` keeps working when the feature is off, so a kill switch never traps held orders.
- Batches are scoped by `org_id` and by the caller's current source. Another organization's batch reads as `IMPORT_BATCH_NOT_FOUND`.

## Routes

| Method and path | Purpose | Role |
| --- | --- | --- |
| `GET /api/order-imports/template?format=csv\|xlsx&locale=ar\|en` | Sample file with two example rows. | Any member |
| `POST /api/order-imports` (multipart `file`) | Upload, parse and auto-map. Returns the batch as `draft`. | Owner/admin |
| `GET /api/order-imports?status=draft\|active` | Open drafts, or imports releasing, paused or finished in the last 24 hours. | Any member |
| `GET /api/order-imports/:id` | Batch detail: mapping, counts, release progress, lifecycle counts. | Any member |
| `GET /api/order-imports/:id/rows?outcome=&cursor=&limit=` | Paged rows (default 50, max 100) with issues. | Any member |
| `PUT /api/order-imports/:id/mapping` | Save mapping and options, then re-validate. | Owner/admin |
| `PATCH /api/order-imports/:id/rows/:rowNumber` | Include or exclude a possible duplicate. | Owner/admin |
| `PATCH /api/order-imports/:id/rows/:rowNumber/phone` | Replace the phone of a row that has a phone issue. | Owner/admin |
| `POST /api/order-imports/:id/commit` (`Idempotency-Key`) | Create held orders from ready rows. | Owner/admin |
| `GET /api/order-imports/:id/start-quote` | Count, pace, credit estimate, blockers, signed `quoteToken`. | Owner/admin |
| `POST /api/order-imports/:id/start` (`Idempotency-Key`, `{ quoteToken }`) | Begin paced release. | Owner/admin |
| `POST /api/order-imports/:id/stop` / `resume` | Withdraw remaining held orders / resume after a pause. | Owner/admin |
| `DELETE /api/order-imports/:id` | Discard a draft. | Owner/admin |

## File intake

| Rule | Value |
| --- | --- |
| Formats | `.csv` and `.xlsx`. The format is detected from the bytes, not the file name or MIME type. |
| Refused | `.xls`, `.xlsm` and any workbook with macros, `.xlsb`, password-protected files, PDFs and other binaries, empty files. |
| Size and shape | 5 MB, **100 data rows**, 100 columns, 1,000 characters per cell (longer cells are truncated and flagged), 50 MB uncompressed XLSX, 20 s parse timeout. |
| CSV | UTF-8 with or without BOM, UTF-16 with BOM, Windows-1256 fallback. Delimiter `,` `;` or tab. RFC 4180 quoting. |
| XLSX | First visible sheet only; other sheets are reported as ignored. Formulas are never evaluated (cached values). |
| Header row | First non-empty row. Blank headers become `Column N`; repeated headers get ` (2)`, ` (3)`. |
| Drafts | Expire after 24 hours. At most 3 open per organization. A new upload replaces that user's earlier drafts. |
| Upload rate | 10 per user per minute (`IMPORT_RATE_LIMITED`, with `Retry-After`). |

The file is parsed once, in a worker thread, and each row is stored as `order_import_rows.raw`. The original bytes are never stored, only the SHA-256, name, size and format. The same hash within 24 hours sets `duplicateFileOf` on the upload response as a warning.

## Column mapping

Headers are matched by a normalized key (case, punctuation and whitespace removed, Arabic diacritics, tatweel and alef/taa-marbuta variants folded). Matching is exact first, then partial (the header contains an alias of at least 3 characters). A column maps to one field. Aliases carry a rank, so when several columns match the same field the lower rank wins (for example `Shipping Phone` beats `Phone` beats `Billing Phone`). The dictionary is in `src/modules/order-imports/mapping/alias-dictionary.ts`.

| Field | Required | Examples |
| --- | --- | --- |
| `phone` | Yes | `Shipping Phone`, `Phone`, `Mobile`, `WhatsApp`, `Billing Phone`, `رقم الهاتف` |
| `customerName` | Yes | `Customer Name`, `Full Name`, `Shipping Name`, `الاسم`. First and last name columns are joined. |
| `amount` | Yes | `COD Amount`, `Amount`, `Total`, `Price`, `المبلغ` |
| `orderReference` | No | `Order ID`, `Order Number`, `Reference`, `رقم الطلب`. A bare `Name` becomes the reference when its sample values look like `#1001`. |
| `currency`, `paymentMethod`, `orderDate`, `city`, `address`, `notes` | No | `Currency`, `Payment Method`/`Financial Status`, `Order Date`/`Created at`, `City`, `Shipping Street`, `Notes` |

The merchant can override any column, set the import country, default currency and date format, and classify each distinct payment value as COD or not COD. Mapping failures return `IMPORT_MAPPING_INCOMPLETE` with `fieldErrors`.

**Saved profiles.** Each `PUT /mapping` upserts one `order_import_mapping_profiles` row per organization and header signature (SHA-256 of the sorted header keys, so column order does not matter). It stores the columns, country, default currency, date format and payment-value map. On the next upload with the same signature it is laid over the auto-detected mapping and stays reviewable. Payment classifications are also remembered per organization across files. There is no endpoint to list, rename or delete profiles.

## Row normalization

- **Phone.** One phone column per import. Normalized to E.164 through `PhoneService`. `+` or `00` keeps its own country; otherwise the import country applies (store country, else `EG`). Egyptian numbers that lost the leading zero are repaired. A mobile or fixed-line-or-mobile number is required. Issues: `PHONE_MISSING`, `PHONE_INVALID`, `PHONE_NOT_MOBILE`, `PHONE_MULTIPLE`, `PHONE_SCIENTIFIC_NOTATION`.
- **Currency.** Row currency column, else a code or symbol in the amount cell, else the import default (store `shippingCurrency`, or the import country's currency). Supported: `USD EUR EGP SAR AED QAR KWD BHD OMR JOD MAD`.
- **Amount.** Greater than 0, at most 2 decimals and 10 integer digits. Arabic digits and separators are understood. A lone comma that could be thousands or decimals is `AMOUNT_AMBIGUOUS`.
- **Date.** ISO, `d/m/y` or an Excel serial. More than 1 day in the future is invalid. Older than `BULK_IMPORT_MAX_ORDER_AGE_DAYS` (default 7) is excluded.
- **Payment.** Each distinct value is classified COD, not COD or unknown, and the merchant overrides it. A blank cell uses the merchant's blank-payment choice, else the store's `assumeCodWhenPaymentMissing`.

### Row outcomes

`ready`, `invalid` (fix the file), `duplicate`, `excluded`, and `imported` after commit. Precedence is invalid, then duplicate, then excluded.

| Outcome | Codes |
| --- | --- |
| `duplicate` | `DUPLICATE_IN_FILE`, `ALREADY_IMPORTED` |
| `excluded` | `PAYMENT_NOT_COD`, `PAYMENT_UNKNOWN_EXCLUDED`, `ORDER_TOO_OLD`, `POSSIBLE_DUPLICATE` |
| `invalid` | Phone, name, amount, currency, reference and date codes above, plus `ORDER_REF_CONFLICT_IN_FILE`, `FIELD_TOO_LONG`, `CSV_MALFORMED_QUOTE` |

Deduplication: rows with the same reference and consistent phone and amount collapse into one order (line-item exports); the same reference with a different phone or amount makes every row `ORDER_REF_CONFLICT_IN_FILE`. A reference already imported into the source is `ALREADY_IMPORTED`. `POSSIBLE_DUPLICATE` fires for the same phone and amount within 7 days, or the same order number within 30 days; only these rows can be included by the merchant. The windows are pilot defaults.

## Commit: held orders

`POST /commit` requires an `Idempotency-Key`. The key is stored on the batch (`commit_idempotency_key`, unique per organization). A replay returns the current batch; a different key on a batch that has moved on returns `IMPORT_BATCH_STATE_CONFLICT`; the same key on another batch returns `IMPORT_IDEMPOTENCY_CONFLICT`.

A background job commits `ready` rows in chunks of 200, in row order, through the shared `StandaloneOrderIngestionService`. Each order is created with `hold: { groupId: batchId }` and a per-row event key `import:<batchId>:<rowNumber>`. With a reference the external id is `ref:<normalized reference>`, so a repeated reference never creates a second order. Without one it is `imp:<batchId>:<rowNumber>` and the order number is `IMP-<batch code>-<row>`. The job is resumable. A chunk is its own transaction, so a failed commit leaves imported rows held and startable and marks the batch `failed`.

The hold lives on the source-neutral `webhook_events` row (`hold_state = held`, `dispatch_required = false`), so dispatch and the reconciler skip it. **Nothing is sent before a start.**

## Start and release

- `GET /start-quote` returns the order count, accounting mode, credit or plan figures (`estimatedCreditsMin = N`, `estimatedCreditsMax = N` or `2N` with follow-ups), pace, estimated duration, quiet hours, `startDeadlineAt`, `blockers[]` and an HMAC `quoteToken` valid for 10 minutes. A confirmed draft can be quoted before the commit. A changed count or balance makes `POST /start` return `IMPORT_QUOTE_STALE` with a fresh quote.
- `POST /start` releases **all** held orders. It is blocked, with no partial start, by: `IMPORT_SETUP_INCOMPLETE`, `IMPORT_AUTO_VERIFY_DISABLED`, `INSUFFICIENT_CREDITS` (with `shortfall` and `suggestedPurchaseCredits`), `CREDIT_ACCOUNT_NOT_PROVISIONED`, `CREDIT_ACCOUNT_SUSPENDED`, `CREDIT_DEBT_OUTSTANDING`, `PAYMENT_PENDING_RECONCILIATION`, `IMPORT_PLAN_LIMIT_REACHED` and `IMPORT_START_WINDOW_EXPIRED`. Readiness uses the same `StandaloneSendReadinessService` as manual orders. The start does not ask for a consent attestation; the starting user and time are recorded.
- **Start window.** Held orders must be started within 24 hours of the commit. An hourly job withdraws expired holds and sets the batch to `not_started` at no cost.
- **Pacing.** A tick every 30 seconds releases `ceil(rate × 0.5)` orders for the organization, shared across its releasing batches (earliest batch first, then row order). `BULK_IMPORT_RELEASE_PER_MINUTE` defaults to 20. Nothing is released inside the store's quiet hours.
- **Auto-pause.** If readiness fails mid-release (credits, plan, auto-verify, onboarding), the organization's releasing batches pause with the blocker code. `resume` re-checks the blockers and the deadline.
- **Stop.** `POST /stop` withdraws every still-held order. Released orders continue normally.
- **Batch statuses:** `draft`, `committing`, `awaiting_start`, `releasing`, `paused`, `completed`, `stopped`, `not_started`, `expired`, `failed`.

After release the order is a normal verification. The Verifications list takes `importBatchId` as a filter, and shows `awaiting_start`, `queued` and `sending` before the first message.

## Retention and security

- Expired drafts and their rows are removed by a daily purge job. Reads treat an expired draft as `IMPORT_BATCH_EXPIRED` immediately.
- `raw` and `normalized` row data of committed (and failed) batches are cleared after 90 days. Row number, outcome, issues and the order link remain. The file bytes are never stored.
- Logs carry codes, field names and counts only, never cell values, headers or phone numbers. Action names are prefixed `order-import-` (upload, mapping-save, validate, commit, start, stop, resume, release-tick, release-pause, purge and others). There is no metrics or analytics layer, and no staff view of imports.
- The three import tables have row-level security and every query is scoped by `org_id`.
- Generated CSV files (the template) start with a UTF-8 BOM and prefix cells that begin with `= + - @`, tab or carriage return with `'`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STANDALONE_BULK_IMPORT_ENABLED` | off | Master switch. |
| `BULK_IMPORT_PILOT_ORG_IDS` | empty | Optional allow-list of organization UUIDs. |
| `BULK_IMPORT_QUOTE_SECRET` | none | HMAC secret for start-quote tokens (at least 32 characters). |
| `BULK_IMPORT_MAX_ROWS` | 100 | Rows per file (1 to 100). |
| `BULK_IMPORT_MAX_COLUMNS` | 100 | Columns per file. |
| `BULK_IMPORT_MAX_OPEN_DRAFTS` | 3 | Open drafts per organization. |
| `BULK_IMPORT_MAX_FILE_BYTES` | 5 MB | Upload size. |
| `BULK_IMPORT_MAX_UNCOMPRESSED_BYTES` | 50 MB | XLSX zip-bomb cap. |
| `BULK_IMPORT_PARSE_TIMEOUT_MS` | 20000 | Parse time budget. |
| `BULK_IMPORT_MAX_ORDER_AGE_DAYS` | 7 | Older orders are excluded. |
| `BULK_IMPORT_RELEASE_PER_MINUTE` | 20 | First messages released per minute per organization. |

The 24-hour start window, 24-hour draft lifetime, 10-per-minute upload limit and 90-day retention are code constants.

## Known business decisions

- Import never contacts a customer by itself. Only `POST /start` releases a held order, and a release is at-most-once per order.
- Imported orders use the manual-order path after release. `ingestionType` is envelope metadata only, and the confirmation engine never branches on it.
- The 100-row limit is a product decision. It was lowered from 5,000, and the epic README had not yet caught up when this document was written.
- The 7-day and 30-day duplicate windows and the 20-per-minute pace are pilot defaults, not Meta-published limits.

## Recommended test scenarios

| Scenario | Expected result |
| --- | --- |
| Upload a valid CSV | Draft with auto-mapped columns and row counts. |
| Upload `.xlsm`, `.xls`, a password-protected workbook, a renamed PDF | `IMPORT_FILE_TYPE_UNSUPPORTED`, `IMPORT_FILE_PROTECTED` or `IMPORT_FILE_UNREADABLE`; no batch is created. |
| 101 rows | `IMPORT_ROW_LIMIT_EXCEEDED`. |
| Shopify-style export with Shipping/Billing phone and repeated order names | Shipping phone wins; line-item rows collapse into one order. |
| Phone as `2.01E+11`, a landline, two numbers in one cell | Row `invalid` with the matching phone code; the phone can be replaced via the row phone route. |
| Commit twice with the same key; commit with a different key | Same batch; `IMPORT_BATCH_STATE_CONFLICT`. |
| Re-import a file whose orders have references | Rows are `ALREADY_IMPORTED`; no second order. |
| Start with fewer credits than orders | `INSUFFICIENT_CREDITS` with `shortfall`; no order is released. |
| Credits run out mid-release | Batch pauses; `resume` after a purchase continues. |
| Start after 24 hours | `IMPORT_START_WINDOW_EXPIRED`; orders show `not_started`. |
| Viewer calls a write route | `IMPORT_ROLE_REQUIRED`. |
| Shopify organization calls any route | `IMPORT_SOURCE_UNSUPPORTED`. |
