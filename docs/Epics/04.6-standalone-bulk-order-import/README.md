# E04.6 — Standalone Bulk Order Import (CSV / XLSX)

- **Horizon:** NEXT — execute after E04.5 and before E05
- **Status:** Backlog
- **Stories:** 10
- **Prerequisite epics:** [E04 — Standalone Manual Order MVP](../04-standalone-manual-order-mvp/README.md), [E04.5 — Standalone Paymob Usage-Based Billing MVP](../04.5-standalone-paymob-usage-billing/README.md)
- **Next epic:** [E05 — Standalone Order Ingestion API](../05-standalone-order-ingestion-api/README.md)
- **Roadmap:** [Expansion backlog](../README.md)
- **Authored:** 2026-09-19
- **Implementation prompts:** [one prompt per story](IMPLEMENTATION-PROMPTS.md)

## Business objective

Let a Standalone merchant who runs their COD business from a spreadsheet, marketplace export or storefront without an Akeed integration bring a batch of orders into Akeed in minutes. Akeed must confirm those orders over WhatsApp with the same lifecycle as manual orders, and give the merchant a results file they can act on. The merchant must never message customers by accident, never pay twice for the same order, and never damage the shared WhatsApp sender's quality rating with a bulk blast.

CSV/XLSX import is the first **multi-order ingestion adapter**, not a separate product. Once a row becomes an Akeed order, everything downstream (eligibility, quiet hours, follow-up, no-reply, billing, dashboard, retry) is exactly the manual-order path. `source` is data on the envelope. It is never a branch in the confirmation engine.

## Measurable outcome

- An owner/admin can upload a `.csv` or `.xlsx` file of up to 5,000 orders and reach a validated preview in under 10 seconds (p95, 5,000 rows), with every row classified as ready or as not imported with a reason.
- Uploading the same file, or a file overlapping an earlier import, cannot create a second order for any order reference already imported into the source.
- Importing sends nothing. Customers are contacted only after the merchant explicitly starts confirmation, attests consent and passes a credit check covering every initial message.
- Released orders go out at no more than the configured per-organization rate (default 20 initial sends per minute). Nothing is released during the store's quiet hours.
- Imported orders produce verifications, credit consumption, follow-ups and dashboard lifecycles identical to manual orders with the same data. This is asserted by an automated equivalence test.
- The merchant can download at any time an error report they can fix and re-upload, and a results file with each order's confirmation outcome.
- Shopify embedded merchants and the manual order path behave unchanged.

## Approved product decisions

| Decision | Approved value |
| --- | --- |
| Audience | Standalone organizations with a completed onboarding. Hidden in Shopify embedded mode; the API returns `IMPORT_SOURCE_UNSUPPORTED`. |
| Roles | Owner/admin: upload, map, commit, start, stop, resume, discard. Viewer: read history and download reports. |
| Accepted formats | `.csv` and `.xlsx` (first **visible** worksheet; other sheets are ignored with a notice). `.xls`, `.xlsm`, `.ods`, `.numbers`, password-protected and unreadable files are rejected with guidance. |
| Limits (env-configurable) | 5 MB file; 5,000 data rows; 100 columns; 1,000 characters per cell; 50 MB uncompressed XLSX; 3 open (uncommitted) drafts per organization; 10 uploads per user per minute. |
| CSV dialect | UTF-8 with or without BOM, UTF-16 LE/BE with BOM, Windows-1256 fallback when bytes are not valid UTF-8. Delimiter auto-detected among `,`, `;` and tab. RFC 4180 quoting, including embedded delimiters, quotes and line breaks. |
| Header row | The first non-empty row is the header. Blank headers become `Column N`; duplicate headers get ` (2)`, ` (3)` suffixes. |
| Parse model | Parse **once** at upload and persist every row as `order_import_rows.raw`. Mapping changes re-validate from stored rows; commit is a state promotion. The original file is never stored, only its SHA-256, name, size and format. |
| Canonical fields | Required: **customer phone**, **customer name**, **amount**. Optional: order reference, currency, payment method, order date, city, address, notes. |
| Missing currency | Falls back to the import's default currency (the store's `shippingCurrency`, editable in mapping). Must be in `ONBOARDING_SHIPPING_CURRENCIES`. |
| Payment method | Optional. When mapped, each **distinct value** is auto-classified COD / not COD with the shared `payment-signals` rules, and the merchant can override per value. A COD value becomes the canonical `cash_on_delivery` (the manual form's constant). The row's eligibility is then decided by the existing `OrderEligibilityService`, which already applies `assumeCodWhenPaymentMissing`. Ineligible rows are **excluded**. |
| Phone | Normalized to E.164 through `PhoneService` using the import country (default: the store country if known, otherwise `EG`). A number with a leading `+` or `00` keeps its own country. It must be a mobile or fixed-line-or-mobile number. |
| Row outcomes | One split, no warning tier: **ready**, or not imported as **invalid** (fix the file), **duplicate** (already imported or repeated in this file) or **excluded** (policy: too old, not COD, possible duplicate). Only *possible duplicate* rows can be individually included. |
| Old orders | When an order date is mapped, rows older than **7 days** in the store timezone are excluded (`ORDER_TOO_OLD`). Dates more than 1 day in the future are invalid. With no date column, rows are allowed and the review screen states that no order date was provided. |
| Order identity | With a reference: `externalOrderId = ref:<normalized reference>`, and `orderNumber` = the reference as written. Without a reference: `externalOrderId = imp:<batchId>:<rowNumber>`, and `orderNumber = IMP-<batch short code>-<rowNumber>`. |
| Duplicate protection | L0 file hash (same org and bytes within 24 h: warning, continue allowed). L1 reference already imported into the source (duplicate). L2 repeated reference inside the file (identical line-item rows collapse into one order; conflicting rows are all invalid). L3 possible duplicate (same phone and amount on the source within 7 days, or the same order number within 30 days; excluded by default, includable). L4 commit `Idempotency-Key` plus the per-row event key `import:<batchId>:<rowNumber>`. |
| Default after import | **Import only.** Orders are created in a source-neutral hold (`awaiting_start`). Nothing is sent until the merchant starts confirmation. |
| Start checkpoint | Requires a consent attestation (versioned text, actor and timestamp stored), shows the order count, estimated duration and a credit estimate (N initial messages, up to 2N if follow-up is enabled). |
| Credit gap | Start is **blocked** unless available credits ≥ N (prepaid mode) or remaining included verifications ≥ N (periodic mode). The screen shows the shortfall and a **Buy credits** action. No partial starts. |
| Auto-verify off | Import is allowed. Start is blocked with a link to settings. |
| Start window | Held orders can be started within **72 hours** of commit. After that they are withdrawn (`not_started`) at no cost. |
| Pacing | Per-organization release rate of 20 initial sends per minute (env), shared across all releasing batches. Release pauses in store quiet hours and resumes after them. Existing `sendDelayMinutes`, quiet-hours and follow-up rules still apply downstream. |
| Mid-release control | **Stop remaining** withdraws every unreleased order in the batch. The batch **auto-pauses** if credits, entitlement, auto-verify or onboarding stop allowing sends, and the merchant can **resume** once resolved. |
| Error report | CSV of the original columns for every not-imported row plus `akeed_row`, `akeed_status` and `akeed_reason` (localized). Fix, then re-upload: already-imported rows are detected as duplicates. |
| Results export | CSV per batch at any time: row, reference, name, E.164 phone, amount, currency, import outcome, reason, confirmation status, last status time, messages sent. |
| Spreadsheet safety | Every generated CSV starts with a UTF-8 BOM, and any cell beginning with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with `'`. |
| Saved mapping | Per organization, keyed by a header signature, and auto-applied (still reviewable) on the next upload with the same headers. |
| Templates | Downloadable sample CSV and XLSX, bilingual headers, with two example rows. |
| Retention | Uncommitted drafts expire after 24 h and their rows are purged. Committed batches keep row data for 90 days, then keep only counts and order links. Logs never include full phone numbers or names. |
| Feature flag | `STANDALONE_BULK_IMPORT_ENABLED`, default off, plus the pilot allow-list `BULK_IMPORT_PILOT_ORG_IDS` until general availability. Turning the flag off blocks new uploads, commits, starts and resumes; in-flight releases finish, and stop, history and exports keep working. |

## Confirmed current-state baseline

Verified from code on 2026-09-19. These constrain every story:

- **Orders have no status column.** The merchant lifecycle is projected by the `retryGuardStatus` SQL CASE in [`orders.repository.ts`](../../../src/infrastructure/database/repositories/orders.repository.ts). An order with a pending `webhook_events` row and no verification currently renders as `accepted`.
- **Manual orders are created and dispatched in one request.** [`OrdersService.createManualOrder`](../../../src/modules/orders/orders.service.ts) applies the role, single-active-standalone-source, onboarding, entitlement, auto-verify, credit and slot gates. It then calls [`ManualOrderIngestionRepository.accept`](../../../src/infrastructure/database/repositories/manual-order-ingestion.repository.ts) (webhook event and order in one transaction, idempotent on `(platform, store_domain, idempotency_key)`, then an `assertPersisted` read-back) and immediately calls `WebhookDispatchService.dispatchById`. **There is no way to create an order without starting confirmation.**
- **The dispatch/recovery predicate is the natural hold point.** [`WebhookEventsRepository.recoverablePredicate`](../../../src/infrastructure/database/repositories/webhook-events.repository.ts) only claims events with `dispatch_required = true` and `next_dispatch_at <= NOW()`. Both the dispatcher and the [reconciler](../../../src/modules/webhook-queue/webhook-dispatch-reconciler.service.ts) share it.
- **The normalizer rejects anything but manual envelopes.** [`StandaloneManualOrderNormalizer`](../../../src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts) requires `ingestionType === 'manual'`, `schemaVersion === 1` and non-empty `externalOrderId`, `orderNumber`, `customerName`, `customerPhone`, `totalPrice` and `currency`.
- **Phone normalization ignores country for Standalone.** [`PhoneService.standardize(phone, countryCode?)`](../../../src/shared/services/phone.service.ts) supports a region, but the manual path passes none, and Standalone `integrations.country_code` is never populated.
- **COD classification is narrow.** [`payment-signals.ts`](../../../src/shared/commerce/payment-signals.ts) recognizes `cod`, `cash on delivery`, `الدفع عند الاستلام` and `كاش عند الاستلام`, but not `cash`, `كاش` or `عند الاستلام` alone. This is why the import classifies payment values per distinct value, with merchant override.
- **No per-organization send pacing exists.** Queue worker concurrency is the only cap. Quiet hours ([`quiet-hours.util.ts`](../../../src/shared/utils/quiet-hours.util.ts)) and `sendDelayMinutes` are applied per verification in [`VerificationHubService`](../../../src/modules/verification-core/verification-hub.service.ts).
- **Billing.** One credit is consumed per Meta-accepted message, and a follow-up costs one more (E04.5). Advisory gates are [`CreditEligibilityService`](../../../src/modules/verification-core/credit-eligibility.service.ts) and [`BillingEntitlementService.hasAvailableSlot`](../../../src/modules/verification-core/billing-entitlement.service.ts); the dispatch claim is the transactional truth.
- **Nothing to reuse for files.** There is no upload/multer usage, no CSV/XLSX library, no object storage and no merchant audit table. Feature flags are environment variables.
- **Frontend.** There is no orders page; [`verifications/page.tsx`](../../../../akeed-frontend/src/app/[locale]/verifications/page.tsx) is the order list. There is no upload UI. `fetchWithAuth` in [`auth.ts`](../../../../akeed-frontend/src/shared/lib/auth.ts) always sends `Content-Type: application/json`. Reusable parts: onboarding step rail/progress, shared `Table`, `Pagination`, `Badge`, `Dialog`, `notify`, `queryKeys` and `domainEvents`.

## Architecture — adapters in, one core out

The existing hub-and-spoke design is kept and extended, not bypassed. Adapters exist at two levels, and each translates its input into a canonical form. Nothing after the canonical form knows where an order came from.

```text
 PLATFORM SPOKES (one per PlatformType)          STANDALONE CHANNEL ADAPTERS (one per input channel)
 ┌──────────────────────────────┐                ┌───────────────────────────────────────────────┐
 │ Shopify webhook              │                │ Manual form   → ManualOrderChannelAdapter      │
 │ (future) EasyOrders / Woo    │                │ CSV / XLSX    → FileImportChannelAdapter  (E04.6)│
 └──────────────┬───────────────┘                │ Public API    → ApiOrderChannelAdapter    (E05) │
                │                                 └──────────────────────┬────────────────────────┘
                │                                       CanonicalOrderInput[] + {channel, hold}
                │                                                        ▼
                │                                 StandaloneOrderIngestionService   ◀── the ONE ingestion command
                │                                 (source resolution, readiness, envelope, fingerprint,
                │                                  idempotent order + event acceptance, optional hold)
                ▼                                                        ▼
        webhook_events (durable intent, hold_state) ──── dispatchById / reconciler (skips held events)
                                   ▼
        WebhookQueueProcessor → WebhookOrderNormalizer[platform]  (shopify | standalone)
                                   ▼
        NormalizedOrder → OrderEligibilityService → strategy[platform]
                                   ▼
        VerificationHubService → send / follow-up / no-reply / billing / dashboard   ◀── CORE, source-agnostic
```

Rules:

1. **Channel adapters only translate.** A channel adapter turns its input (a form DTO, a spreadsheet row, and later an API body) into `CanonicalOrderInput`, plus channel-specific metadata that is stored but never read by the core. Adapters never write orders or events, call dispatch, check credits or touch `verification-core`.
2. **One ingestion command per platform.** `StandaloneOrderIngestionService` is the only way a Standalone order enters Akeed. It exposes `acceptOne` (manual, and later the API) and `acceptMany` (file import), which differ only in batching and the `hold` option. It owns source resolution, readiness gates, envelope and fingerprint, and transactional acceptance through the shared repository core.
3. **The core stays platform-level.** All Standalone channels share `platform = 'standalone'`, the Standalone normalizer and the Standalone eligibility strategy. `ingestionType` (`manual` | `bulk_import` | later `api`) is envelope metadata for audit and reporting only. No normalizer, strategy, hub or send code may branch on it.
4. **Hold is a core capability, not a CSV feature.** `hold_state` lives on the source-neutral `webhook_events`, so any channel or future spoke can hold and release through the same dispatch path.
5. **Adding a channel means adding one adapter.** E05's API becomes an `ApiOrderChannelAdapter` that calls `acceptOne`. It adds no new repository, gate or envelope. This epic delivers the command E05 plugs into.

## Reuse map — one implementation per rule

Bulk import must not become a second copy of the manual-order path. Every rule below already exists or is extracted once, and **both** the manual endpoint and the import call the shared version. Each extraction is a behavior-preserving refactor, proven by the unchanged manual-order contract suite (`npm run test:contract:manual-orders`) passing before and after.

| Concern | Existing code today | Shared implementation (created in) | Import must not |
| --- | --- | --- | --- |
| Source resolution: role, one active source, Standalone only, onboarding complete | Inline in `OrdersService.createManualOrder` | `StandaloneSourceResolver.resolveWritable(user, codes)`, which takes an error-code map so manual keeps `MANUAL_ORDER_*` and import gets `IMPORT_*` ([US-04.6-02](US-04.6-02-import-batch-model-and-secure-file-intake.md)) | Re-query `findActiveByOrg` or re-check `platformType`/`onboardingStatus` itself |
| Send readiness: entitlement, auto-verify, credit denial, slot availability, retry readiness | `createManualOrder` gates, private `assertCreditEligible` and private `retryReadinessReason` | `StandaloneSendReadinessService.evaluate(source, {required})` returning typed blockers, used by create, retry and import start/release ([US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md)) | Call `CreditEligibilityService` or `hasAvailableSlot` directly |
| Canonical field rules: phone length, name ≤ 255, order number ≤ 100, amount pattern (> 0, ≤ 2 decimals, ≤ 10 integer digits), currency list, payment method ≤ 100 | `CreateManualOrderDto` decorators and `ONBOARDING_SHIPPING_CURRENCIES` | `src/shared/commerce/canonical-order.rules.ts` (constants plus pure validators). The DTO decorators read the same constants ([US-04.6-04](US-04.6-04-row-normalization-validation-and-dedupe.md)) | Declare its own limits or regex |
| COD eligibility, including `assumeCodWhenPaymentMissing` | `OrderEligibilityService` → `StandaloneOrderEligibilityStrategy` | Reused as-is. The import only maps each merchant payment value to a canonical method (`cash_on_delivery` or the original text) and then asks `evaluateOrderForVerification` ([US-04.6-04](US-04.6-04-row-normalization-validation-and-dedupe.md)) | Re-implement the COD/unknown/non-COD decision |
| Phone parsing | `PhoneService.standardize` | `PhoneService` gains `parse(raw, region)`, which returns a typed result. `standardize` and `standardizeMobile` both delegate to it ([US-04.6-04](US-04.6-04-row-normalization-validation-and-dedupe.md)) | Instantiate `PhoneNumberUtil` or add a second parser |
| Order envelope and submission fingerprint | Built inline in `createManualOrder`; read by `StandaloneManualOrderNormalizer` | `buildStandaloneOrderEnvelope({ingestionType, order, extras})` and `fingerprintCanonicalOrder()` in `src/shared/commerce/standalone-order-envelope.ts`. Manual output must be byte-identical ([US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md)) | Hand-build `rawPayload` |
| Idempotency-Key validation | Private `OrdersService.normalizeIdempotencyKey` | `src/shared/validation/idempotency-key.ts` with a caller-supplied error code ([US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md)) | Copy the regex |
| Ingestion command (the adapter boundary) | Inline in `OrdersService.createManualOrder`; US-04-01 asked for a "shared ingestion command" that was never extracted | `StandaloneOrderIngestionService` with `acceptOne` / `acceptMany` taking `CanonicalOrderInput`. `createManualOrder` becomes a thin `ManualOrderChannelAdapter` plus a call to `acceptOne` ([US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md), batch path in [US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md)) | Call the repository, dispatcher or envelope builder directly from `order-imports` |
| Order + event acceptance (transaction, conflict handling, read-back) | `ManualOrderIngestionRepository.accept` | The per-order transaction body is extracted to `acceptWithinTransaction(tx, input, {hold})`. `accept()` (manual) wraps one call, and `acceptMany()` (import) wraps a chunk. The read-back guard is shared. Only the ingestion service calls it ([US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md)) | Add a second repository with its own insert and conflict logic |
| Dispatch and recovery | `WebhookDispatchService.dispatchById`, reconciler, `recoverablePredicate` | Reused. The hold only adds a predicate condition ([US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md)) | Enqueue verification jobs directly |
| Quiet hours | `adjustForQuietHours` | Reused by the release scheduler ([US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md)) | Re-implement time-window maths |
| Lifecycle, retry and cancel after release | `retryGuardStatus` projection, `POST /api/orders/:id/verification/retry`, `POST /api/verifications/:id/cancel` | Reused unchanged. Imported orders use the same dashboard, retry and cancel ([US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md), [US-04.6-08](US-04.6-08-import-history-and-results-export.md)) | Add import-specific retry or cancel endpoints |
| Order list | `GET /api/verifications` via `OrdersRepository.findByOrg` | Adds an `importBatchId` filter to the same query ([US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md)) | Build a second order list |
| Frontend currency list and COD constant | `manualOrderCurrencies`, `MANUAL_ORDER_PAYMENT_METHOD` in `features/orders/domain/manualOrder.model.ts` | Promoted to `src/shared/commerce/orderCommerce.ts`. The manual form re-imports it ([US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md)) | Declare a third currency list |
| Frontend credit/billing blocker messages | `creditErrors.*` translations and the manual-order `billingLink` feedback | Reused for `INSUFFICIENT_CREDITS` and the other credit codes ([US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md)) | Add parallel credit strings |
| Frontend file download | `features/billing/lib/csvDownload.ts#downloadCsv` | Promoted to `src/shared/lib/download.ts` with `downloadBlob(blob, filename)`; `downloadCsv` delegates to it ([US-04.6-08](US-04.6-08-import-history-and-results-export.md)) | Add another anchor/object-URL helper |
| Lifecycle badge and tones | `VerificationStatusBadge`, `lifecycleToneClasses.ts` | Extended with the two hold states ([US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md)) | Create an import-only badge |

The only genuinely new logic is file intake and parsing, header mapping, cell-level normalization (digits, amount text, dates), batch dedupe, the batch and hold state machines, paced release and CSV writing.

## Prioritized user stories and commit boundaries

Delivery rank is the execution order. Dependencies override priority; P1 enablement remains in this epic and must be complete before the final gate when that gate relies on it. All stories start in Backlog. Each story is one reviewable commit boundary.

| Rank | Story | Priority | Type | Direct dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [US-04.6-01 — Add a source-neutral order hold and release primitive](US-04.6-01-source-neutral-order-hold-and-release.md) | P0 | Technical enabler | [US-04-03](../04-standalone-manual-order-mvp/US-04-03-manual-order-verification-lifecycle.md) | Implemented locally — 2026-09-19 |
| 2 | [US-04.6-02 — Accept import files securely and persist parsed rows](US-04.6-02-import-batch-model-and-secure-file-intake.md) | P0 | Feature | [US-04.6-01](US-04.6-01-source-neutral-order-hold-and-release.md) | Implemented locally — 2026-09-19 |
| 3 | [US-04.6-03 — Detect, map and remember columns](US-04.6-03-column-detection-mapping-and-saved-profiles.md) | P0 | Feature | [US-04.6-02](US-04.6-02-import-batch-model-and-secure-file-intake.md) | Implemented locally — 2026-09-19 |
| 4 | [US-04.6-04 — Normalize, validate and deduplicate every row](US-04.6-04-row-normalization-validation-and-dedupe.md) | P0 | Feature | [US-04.6-03](US-04.6-03-column-detection-mapping-and-saved-profiles.md) | Backlog |
| 5 | [US-04.6-05 — Guide the merchant through upload, mapping and review](US-04.6-05-import-wizard-upload-mapping-review-ui.md) | P0 | Feature | [US-04.6-04](US-04.6-04-row-normalization-validation-and-dedupe.md) | Backlog |
| 6 | [US-04.6-06 — Commit ready rows idempotently into held orders](US-04.6-06-idempotent-commit-into-held-orders.md) | P0 | Feature | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) | Backlog |
| 7 | [US-04.6-07 — Start confirmation deliberately with paced release](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md) | P0 | Feature | [US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md) | Backlog |
| 8 | [US-04.6-08 — Track imports and export confirmation results](US-04.6-08-import-history-and-results-export.md) | P0 | Feature | [US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md) | Backlog |
| 9 | [US-04.6-09 — Secure, retain and observe bulk import](US-04.6-09-security-retention-and-observability.md) | P0 | Operations | [US-04.6-08](US-04.6-08-import-history-and-results-export.md) | Backlog |
| 10 | [US-04.6-10 — Release-gate bulk import with real merchant files](US-04.6-10-bulk-import-release-gate.md) | P0 | Quality gate | [US-04.6-09](US-04.6-09-security-retention-and-observability.md) | Backlog |

## Merchant workflow

```text
Import orders (sidebar / dashboard CTA)
  → 1. Upload  .csv / .xlsx  (template download available)
       server: size/type/encoding checks → parse once → persist rows → auto-map
  → 2. Map columns  (auto-detected ✓ / needs attention ⚠ / not provided —)
       + import country, default currency, date format (only if ambiguous),
         payment values → COD / not COD
  → 3. Review  [Ready | Invalid | Duplicate | Excluded] tabs, reasons per row,
       include possible duplicates, date-range banner, download error report
  → Import N orders  (Idempotency-Key; background commit with progress)
  → 4. Imported: "N orders awaiting confirmation — nothing has been sent"
  → Start confirmation dialog: attestation ☐, count, duration, credit estimate,
       shortfall → Buy credits
  → Releasing: progress, pause reason, Stop remaining
  → Batch detail: live outcomes, download results / error report
```

## Canonical state machines

**Batch (`order_import_batches.status`)**

```text
draft ──mapping/validate──▶ draft
draft ──commit──▶ committing ──▶ awaiting_start ──start──▶ releasing ──▶ completed
  │                  │                 │                  │  ▲
  │ 24 h / discard   │ worker crash:   │ 72 h             │  │ resume
  ▼                  │ resumable       ▼                  ▼  │
expired              │            not_started           paused ──stop──▶ stopped
                     └─ unrecoverable ─▶ failed (rows imported so far stay held and startable)
releasing ──stop──▶ stopped
```

- `completed` means every held order has been released; it does not mean every customer replied.
- `stopped`, `not_started` and `expired` are terminal. Released orders always continue their normal lifecycle.

**Row (`order_import_rows.outcome`)**: `ready` | `invalid` | `duplicate` | `excluded`, plus `imported` after commit (with `order_id`). A row whose reference was taken by a concurrent import between review and commit becomes `duplicate` at commit time.

**Order hold (`webhook_events.hold_state`)**: `none` (all existing events) | `held` → `released` | `withdrawn`. A held event has `dispatch_required = false` and is invisible to dispatch and reconciliation. Dashboard lifecycle: `held` → `awaiting_start`, `withdrawn` → `not_started`, `released` → the existing lifecycle.

## Contract summary

All endpoints are session-authenticated (Supabase JWT). The organization and source are derived from the session; batch IDs from another organization return 404.

| Method and path | Purpose | Role |
| --- | --- | --- |
| `GET /api/order-imports/template?format=csv\|xlsx&locale=ar\|en` | Sample file | any member |
| `POST /api/order-imports` (multipart `file`) | Upload, parse and auto-map; returns the batch in `draft` | owner/admin |
| `GET /api/order-imports` | Cursor-paged history | any member |
| `GET /api/order-imports/:id` | Batch detail, mapping, counts, live lifecycle counts | any member |
| `GET /api/order-imports/:id/rows?outcome=&cursor=` | Paged rows with normalized values and issues | any member |
| `PUT /api/order-imports/:id/mapping` | Save mapping and options, then re-validate | owner/admin |
| `PATCH /api/order-imports/:id/rows/:rowNumber` `{ include: boolean }` | Include/exclude a possible duplicate | owner/admin |
| `POST /api/order-imports/:id/commit` (`Idempotency-Key`) | Create held orders from ready rows | owner/admin |
| `GET /api/order-imports/:id/start-quote` | Count, duration, credit estimate, blockers | owner/admin |
| `POST /api/order-imports/:id/start` (`Idempotency-Key`, `{ attestationVersion, quoteToken }`) | Begin paced release | owner/admin |
| `POST /api/order-imports/:id/stop` / `resume` | Withdraw remaining / resume after pause | owner/admin |
| `DELETE /api/order-imports/:id` | Discard a draft (only in `draft`) | owner/admin |
| `GET /api/order-imports/:id/errors.csv` / `results.csv` | Streamed reports | any member |

**Batch-level error codes:** `IMPORT_DISABLED`, `IMPORT_ROLE_REQUIRED`, `IMPORT_SOURCE_UNSUPPORTED`, `IMPORT_SETUP_INCOMPLETE`, `IMPORT_FILE_REQUIRED`, `IMPORT_FILE_TOO_LARGE`, `IMPORT_FILE_TYPE_UNSUPPORTED`, `IMPORT_FILE_PROTECTED`, `IMPORT_FILE_UNREADABLE`, `IMPORT_FILE_EMPTY`, `IMPORT_ROW_LIMIT_EXCEEDED`, `IMPORT_COLUMN_LIMIT_EXCEEDED`, `IMPORT_TOO_MANY_DRAFTS`, `IMPORT_RATE_LIMITED`, `IMPORT_BATCH_NOT_FOUND`, `IMPORT_BATCH_EXPIRED`, `IMPORT_BATCH_STATE_CONFLICT`, `IMPORT_MAPPING_INCOMPLETE`, `IMPORT_NOTHING_TO_IMPORT`, `IMPORT_IDEMPOTENCY_KEY_REQUIRED`, `IMPORT_VALIDATION_FAILED`, `IMPORT_IDEMPOTENCY_CONFLICT`, `IMPORT_ATTESTATION_REQUIRED`, `IMPORT_QUOTE_STALE`, `IMPORT_START_WINDOW_EXPIRED`, `IMPORT_AUTO_VERIFY_DISABLED`, `IMPORT_PLAN_LIMIT_REACHED`, plus the E04.5 credit denial codes (`INSUFFICIENT_CREDITS`, `CREDIT_DEBT_OUTSTANDING`, `CREDIT_ACCOUNT_SUSPENDED`, `CREDIT_ACCOUNT_NOT_PROVISIONED`).

**Row issue codes:** `PHONE_MISSING`, `PHONE_INVALID`, `PHONE_NOT_MOBILE`, `PHONE_MULTIPLE`, `PHONE_SCIENTIFIC_NOTATION`, `NAME_MISSING`, `NAME_TOO_LONG`, `NAME_NOT_TEXT`, `AMOUNT_MISSING`, `AMOUNT_INVALID`, `AMOUNT_NOT_POSITIVE`, `AMOUNT_TOO_LARGE`, `AMOUNT_AMBIGUOUS`, `AMOUNT_TOO_PRECISE`, `CURRENCY_UNSUPPORTED`, `PAYMENT_NOT_COD`, `PAYMENT_UNKNOWN_EXCLUDED`, `ORDER_REF_TOO_LONG`, `ORDER_REF_CONFLICT_IN_FILE`, `DUPLICATE_IN_FILE`, `ALREADY_IMPORTED`, `POSSIBLE_DUPLICATE`, `ORDER_DATE_INVALID`, `ORDER_DATE_FUTURE`, `ORDER_TOO_OLD`, `FIELD_TOO_LONG`, `CSV_MALFORMED_QUOTE` (added by US-04.6-02: an unclosed or stray quote damages only its own row)

## Edge-case catalogue

Every entry is owned by the story in brackets and appears in that story's edge cases or tests.

**File and format** [US-04.6-02]
- Empty file, header-only file, file with only blank rows, a `.csv` that is really an XLSX or a PDF (magic bytes win over the extension), a zero-byte upload, and a dropped connection mid-upload.
- UTF-8 BOM, UTF-16 LE with tabs (Arabic Excel "Unicode text"), Windows-1256 with Arabic text, mixed `\r\n`/`\n`, a trailing delimiter on every line, and a final line without a newline.
- Semicolon-delimited files (European locale Excel), rows with more or fewer cells than the header, and quoted cells containing delimiters, quotes and line breaks. An unterminated quote produces one row issue, not a crashed parse.
- XLSX: a hidden first sheet, multiple sheets, merged cells (value in the top-left cell only), formulas (cached values used, never evaluated), dates stored as serial numbers (1900 leap-year bug respected), phone columns stored as numbers, password-protected, `.xlsm` macros, an oversized shared-strings table (zip bomb), and 1,048,576 formatted but empty rows.
- 5,000 rows accepted; 5,001 rejected before any row is persisted. Cells over 1,000 characters are truncated with `FIELD_TOO_LONG`.

**Mapping** [US-04.6-03]
- Arabic headers with diacritics, tatweel and alef/taa-marbuta variants; English headers in any case and with punctuation.
- Two columns matching the same field (the highest confidence wins, the other is flagged); one column mapped to two fields (rejected).
- Full name split across first/last columns (both can map to name and are joined).
- A required field has no match; the merchant changes the mapping after reviewing; the saved profile no longer matches because a column was renamed.

**Data** [US-04.6-04]
- Phone as `+201012345678`, `00201012345678`, `201012345678`, `01012345678`, `1012345678`, `010-1234-5678`, `010 1234 5678`, Arabic-Indic `٠١٠١٢٣٤٥٦٧٨`, `2.01012E+11`, and two numbers in one cell (`010… / 011…`).
- A Saudi `+966…` number in an Egypt import (valid, keeps its own country), a landline `0223456789`, and a short or long number.
- Name that is empty, whitespace, only digits, only emoji, or over 255 characters (the manual-order limit).
- Amount `750`, `750.5`, `1,250.00`, `1.250,00` (ambiguous unless the file uses `,` as its decimal separator consistently), `EGP 750`, `750 ج.م`, `٧٥٠٫٥٠`, `0`, `-50`, `750.555`, and `100000000`.
- Currency that is unsupported, mixed across the file (allowed per row), or lowercase.
- Payment values `COD`, `Cash`, `كاش`, `عند الاستلام`, `Paid`, `Visa`, `مدفوع`, `InstaPay`, and blank.
- Dates `2026-09-18`, `18/09/2026`, `09/18/2026`, `18-9-26`, an Excel serial, a timestamp with a time zone, text such as `yesterday`, and a date 2 days in the future.

**Duplicates** [US-04.6-04, US-04.6-06]
- The same file uploaded twice (L0 warning; L1 marks every referenced row as already imported).
- The fixed error report re-uploaded (only fixed rows import).
- A Shopify-style line-item export where one order spans 3 rows (collapsed into one order).
- The same reference with a different phone in one file (all conflicting rows invalid).
- A no-reference file uploaded twice on different days (L3 possible duplicate).
- The same customer genuinely ordering twice the same day (L3 possible duplicate, includable).
- A manual order later present in the export (L3 by order number).
- Two batches committed concurrently with overlapping references (exactly one order per reference).

**Operational** [US-04.6-06, US-04.6-07, US-04.6-09]
- Double-click on Import or Start, two tabs committing the same batch, and a retry after a timeout (same `Idempotency-Key` gives the same result; a different key on a non-draft batch gives `IMPORT_BATCH_STATE_CONFLICT`).
- The worker crashes mid-commit or mid-release (resumes without duplicates).
- A browser refresh at any step (the wizard resumes from the batch URL).
- The draft expires while the merchant is reviewing (clear message, re-upload).
- Credits drop between quote and start (`IMPORT_QUOTE_STALE` re-quotes) or during release (auto-pause `INSUFFICIENT_CREDITS`); credit debt appears.
- Auto-verify is switched off, onboarding is reset, or the source is deactivated during release (auto-pause).
- Quiet hours start mid-release (pause, then continue after); the store timezone changes during release (the next tick uses the new value).
- Two batches releasing at once share one org rate; manual orders are never queued behind an import.
- The 72-hour start window lapses; the feature flag is turned off mid-release; a Meta template is paused (existing failure path).
- A merchant deletes a member who started a batch (the batch continues; the audit keeps the actor ID).

## Failure and recovery invariants

1. Parsing, mapping, validating and committing never contact a customer. Only `POST /start` can move an event from `held` to `released`.
2. A held event always has `dispatch_required = false`. A release sets `hold_state = released`, `dispatch_required = true` and `next_dispatch_at` in one statement guarded by `hold_state = 'held'`, so a release is at-most-once per event.
3. At most one order exists per `(integration_id, external_order_id)`, and at most one event per `(platform, store_domain, idempotency_key)`. Both are already enforced by unique indexes and reused, not re-implemented.
4. Commit is resumable. Re-running a chunk after a crash only creates rows that do not yet have an `order_id`, and links existing ones.
5. Each batch counter is derived from rows (or recomputed transactionally), never incremented blindly, so a retry cannot double-count.
6. Withdrawn orders are never billed and never dispatched. A stop that races a release tick leaves every event either `released` (and sent normally) or `withdrawn`, never both.
7. The credit gate at start is advisory; the dispatch claim remains the transactional truth. An order released without credit fails exactly like a manual order (`INSUFFICIENT_CREDITS`, retryable) and triggers the batch auto-pause.
8. Merchant-facing responses contain stable codes and localized messages, never SQL, stack traces or library errors.

## Mockup prompts

**Shared design brief** (prepend to every prompt below):

> High-fidelity UI mockup of "Akeed", a WhatsApp COD order-confirmation SaaS for Egyptian and Gulf e-commerce merchants. Standalone web dashboard with a start-side sidebar (items: Dashboard, Verifications, **Import orders** (active), Templates, Billing, Settings) and a top bar with a credits badge and a "New order" button. Visual language: clean, calm, trustworthy fintech. Primary color emerald-700 (#047857) for main actions, amber-400 accents used sparingly, slate neutrals only, white cards on a very light slate canvas, 12px card radius, soft shadows, generous spacing. Status colors are subtle tinted pills: success green, warning amber, destructive red, info blue. Typography: IBM Plex Sans Arabic for Arabic and Inter for English, clear hierarchy, no tight letter-spacing on Arabic. Show realistic Egyptian data (names like "أحمد علي", "Sara Mostafa", phones like +20 10 1234 5678, amounts in EGP). No lorem ipsum, no stock photos, no emoji in UI chrome. Produce **two frames side by side**: Arabic RTL desktop (1440×900, sidebar on the right) and English LTR desktop (1440×900). Also produce a dark-mode variant of the Arabic frame (slate-950 canvas, slate-900 cards, emerald-500 primary).

| # | Screen | Story |
| --- | --- | --- |
| M1 | Import landing / upload dropzone | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) |
| M2 | Upload rejected (file-level errors) | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) |
| M3 | Column mapping | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) |
| M4 | Review and validation | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) |
| M5 | Mobile review (390 px, Arabic) | [US-04.6-05](US-04.6-05-import-wizard-upload-mapping-review-ui.md) |
| M6 | Committing progress and imported/awaiting start | [US-04.6-06](US-04.6-06-idempotent-commit-into-held-orders.md) |
| M7 | Start confirmation dialog (ready and shortfall variants) | [US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md) |
| M8 | Releasing / paused / stopped batch | [US-04.6-07](US-04.6-07-start-confirmation-checkpoint-and-paced-release.md) |
| M9 | Import history | [US-04.6-08](US-04.6-08-import-history-and-results-export.md) |
| M10 | Batch results detail | [US-04.6-08](US-04.6-08-import-history-and-results-export.md) |

Rules for all mockups: never show "sent" or "delivered" wording for orders that are only imported or held; always show the "Nothing has been sent yet" reassurance until release starts; primary actions sit at the inline end of the footer (left in RTL, right in LTR).

## Metrics and release gate

- `order_import.upload` (outcome, format, encoding, rows, duration_ms), `order_import.validate` (rows by outcome and issue code), `order_import.commit` (created, duplicate_at_commit, duration_ms), `order_import.release` (released per tick, pause reason, lag between planned and actual release), `order_import.start_blocked` (reason).
- Funnel: uploads → mapped → committed → started → completed; rows ready ÷ rows total; rows excluded by reason.
- Quality guard: the WhatsApp block/report rate for imported orders compared with manual orders during the pilot.
- The epic gate is [US-04.6-10](US-04.6-10-bulk-import-release-gate.md). It cannot close while any invariant above lacks automated evidence.

## Dependency and rollout notes

Depends on E04 (manual ingestion, verification lifecycle, dashboard) and E04.5 (credits and eligibility codes). E05 follows and must implement its API as an `ApiOrderChannelAdapter` over `StandaloneOrderIngestionService.acceptOne` from this epic, adding no second ingestion path. It gains no dependency on the file pipeline. Roll out behind `STANDALONE_BULK_IMPORT_ENABLED`, first for pilot organizations. Migrations are additive: new tables, plus nullable/defaulted columns on `webhook_events`. Disabling the flag hides the UI and blocks new operations without touching existing orders. No calendar estimate or staffing commitment is implied by priority.

**New dependencies requiring review:** a streaming CSV parser (`csv-parse`), an XLSX reader, and `iconv-lite` for Windows-1256 and UTF-16. The XLSX reader must be current and without known prototype-pollution or ReDoS advisories. The legacy npm `xlsx@0.18.5` must **not** be used; prefer `exceljs`, or the SheetJS release from its official CDN pinned by integrity hash. Record the choice and its advisory check in US-04.6-02 evidence.

## Evidence discipline

Record implementation, test commands, dates and results in each story's evidence section during implementation, not when this backlog is authored. Label statements **VERIFIED FROM CODE**, **ASSUMPTION / REQUIRES VALIDATION** or **EXTERNAL PLATFORM DEPENDENCY**. WhatsApp quality-rating effects and pacing adequacy are external platform dependencies validated in the pilot.
