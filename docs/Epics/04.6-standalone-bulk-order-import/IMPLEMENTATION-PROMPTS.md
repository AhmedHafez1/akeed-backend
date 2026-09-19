# E04.6 — Implementation prompts

There is one prompt per story. Run them **in order, one story per fresh Claude Code session**, started in `D:\Software_Development\Akeed`. Each prompt is self-contained. It points to the shared rules below, which every session must read first. Don't start a story until the previous story's evidence section records a passing result.

---

## Shared rules

Every story session follows these rules. Each prompt repeats "Follow the shared rules", which means this section.

1. **Read first:** the story file and the [epic README](README.md), especially *Approved product decisions*, *Canonical state machines*, *Contract summary*, *Edge-case catalogue* and *Failure and recovery invariants*. Also read `akeed-backend/AGENTS.md` and, for any UI work, `akeed-frontend/AGENTS.md`. For any frontend change, load the `frontend-dev` skill before writing code.
2. **The story is the spec.** Implement every numbered acceptance criterion and every listed edge case. If code reality contradicts the story, stop and report the conflict with file references before changing scope. Don't silently diverge, and don't implement other stories' scope.
3. **Plan before coding.** Start in plan mode: explore the files named in the story's evidence section, then present a plan that maps each acceptance criterion to files, functions and tests. Wait for approval.
4. **Reuse before adding. There must be one implementation per rule.**
   - The epic README's **Reuse map** table is binding: it names, for every concern, the existing code and the single shared implementation both the manual path and the import must call.
   - Never copy a limit, regex, gate, envelope, eligibility decision or UI helper from the manual-order code. Extract it once (behavior-preserving) and import it.
   - Every extraction must keep the manual endpoint's status codes, error codes, bodies and fingerprints identical. Prove it by running `npm run test:contract:manual-orders` and the orders unit tests **before and after**, and record both results.
   - Before finishing, grep for duplicates you might have introduced (for example the currency list, `/^[A-Za-z0-9._:-]+$/`, the totalPrice regex, `findActiveByOrg`, `resolveDenial`, `hasAvailableSlot`, `PhoneNumberUtil`) and list the hits in the evidence.
   - **Adapter pattern:** follow the epic README section "Architecture — adapters in, one core out". Channel adapters (manual form, file import, later the API) only translate input into `CanonicalOrderInput`. `StandaloneOrderIngestionService` is the only ingestion command. Nothing after the canonical form may branch on channel or `ingestionType`.
   - Match surrounding code style, naming and comment density.
5. **Tenant safety:** the org and source always come from the authenticated session. Every query filters by `org_id`. Another org's batch returns 404. Viewers can't mutate anything.
6. **No customer contact outside `POST /start`.** No code path in this epic may call `dispatchById`, enqueue a send or reserve credit, except the release scheduler in US-04.6-07.
7. **The confirmation engine stays source-agnostic.** Never add an `ingestionType`, import-batch or CSV branch inside `verification-core`, the send path or the webhook normalizer beyond accepting the `bulk_import` envelope.
8. **Errors:** return stable codes from the epic's contract summary, with a human message. Never return SQL, stack traces or library messages to merchants.
9. **Privacy:** never log phone numbers, names, addresses, amounts, file names or cell values. Log IDs, counts, codes and durations through `buildBackendLog`.
10. **Database:**
    - Migrations are additive, created with `npm run db:generate` in `akeed-backend`, and then reviewed by hand. The next migration number follows `drizzle/0035_*`.
    - Don't run migrations against any shared or remote database. Don't run `db:push`.
11. **Files and formatting:**
    - All source files in both apps are **CRLF**, and the workspace is **not** a git repository.
    - Never run prettier or eslint `--fix` over globs. Format only the files you touched, with `npx prettier --write --end-of-line crlf <files>`.
    - New files must be CRLF.
    - Before any bulk codemod, copy the affected folder to a backup.
    - Backend `npm run lint` auto-fixes, so validate with `npx eslint <touched files>` instead.
12. **Frontend conventions:**
    - Semantic tokens only; raw palette classes fail lint. Use logical properties (`ps-`/`pe-`/`ms-`/`me-`/`start-`/`end-`).
    - All strings go in both `public/messages/ar.json` and `en.json` under the `orderImport` namespace (or the namespace named in the story).
    - Phones and amounts are wrapped with `dir="ltr"`/`<bdi>`.
    - Keyboard access, loading, empty and error states. Light and dark, AR and EN, 390/768/1440 widths.
    - Standalone only: nothing appears in Shopify embedded mode.
13. **Feature flag:** everything new is behind `STANDALONE_BULK_IMPORT_ENABLED` (and `BULK_IMPORT_PILOT_ORG_IDS` once US-04.6-10 introduces it). Register new env settings in `src/shared/config` and `env-validation.ts`, with `.env.example` entries.
14. **Tests:**
    - Write the story's listed tests with the existing Jest setup. Add a `test/jest-<name>-contract.json` config when the story adds a contract suite, following `jest-manual-order-ingestion-contract.json`.
    - Existing suites must stay green: `npm test`, `npm run test:contract:manual-orders`, `npm run test:contract:entitlements` and `npm run test:contract:shopify`, plus the billing contract suites (`test/jest-credit-*.json`).
15. **Verify:**
    - Backend: `npx tsc --noEmit -p tsconfig.json`, the new and affected Jest suites, and eslint on the touched files.
    - Frontend: `npx tsc --noEmit`, `npm run lint` on the touched files and `npm run build`. Then run the app in the preview browser and screenshot the new screens in AR RTL and EN, light and dark, desktop and mobile.
    - Report failures honestly, with output.
16. **Close out:** update the story file.
    - Set `Status` to `Implemented locally — <date>` (or `… — release blocked` if an external dependency remains).
    - Append a dated `**IMPLEMENTED LOCALLY — YYYY-MM-DD:**` evidence entry to the Evidence section: files changed, migrations, commands run with pass/fail counts, screenshots path, deviations and known limitations.
    - Update the status column in the epic README table.
    - Don't mark acceptance criteria done without evidence.

---

## US-04.6-01 — Source-neutral order hold and release primitive

```text
Implement US-04.6-01 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-01-source-neutral-order-hold-and-release.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: orders can exist in a durable "held" state that no dispatcher, reconciler or retry can send, until they are explicitly released or withdrawn. Manual and Shopify behavior must not change at all.

Read first:
- src/infrastructure/database/schema.ts (webhook_events)
- src/infrastructure/database/repositories/webhook-events.repository.ts (recoverablePredicate, claimForDispatch, findRecoverable)
- src/modules/webhook-queue/webhook-dispatch.service.ts and webhook-dispatch-reconciler.service.ts
- src/infrastructure/database/repositories/orders.repository.ts (retryGuardStatus/Reason/Retryable CASE expressions, findByOrg, findDashboardOrderById)
- src/modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts
- src/modules/orders/orders.service.ts (retryOrderVerification)
- the frontend lifecycle types, lifecycleToneClasses.ts, VerificationStatusBadge and the verifications status filter in akeed-frontend/src/features/dashboard

Build:
1. Additive migration: webhook_events.hold_state (text, default 'none', CHECK in none/held/released/withdrawn), hold_group_id uuid null, held_at/released_at/withdrawn_at timestamptz null, a partial index on (hold_group_id, hold_state), and CHECK (hold_state <> 'held' OR dispatch_required = false). Update the Drizzle schema.
2. Extend recoverablePredicate once so it requires hold_state IN ('none','released'). Every caller inherits it; no caller-side filtering.
3. WebhookEventsRepository gains releaseHeld(eventIds, dispatchAt) and withdrawHeld({groupId} | {eventIds}):
   - Both are single conditional UPDATEs guarded by hold_state='held' and RETURNING only the changed ids.
   - Withdraw sets status 'skipped' and last_error 'import_not_started'.
4. Lifecycle projection: held → 'awaiting_start', withdrawn → 'not_started', both non-retryable. Add these branches before the existing webhookEvents.status='pending' branch. The retry endpoint rejects them with MANUAL_ORDER_RETRY_NOT_ALLOWED. Update the DTO unions (dto/dashboard.dto.ts) and any status filter validation.
5. The normalizer accepts any ingestionType in one shared constant STANDALONE_INGESTION_CHANNELS = ['manual','bulk_import'] (E05 later appends 'api'), with schemaVersion 1 and the same required fields.
5b. Extract the inline canonicalOrder, submissionFingerprint and rawPayload construction from OrdersService.createManualOrder into src/shared/commerce/standalone-order-envelope.ts:
   - buildStandaloneOrderEnvelope({ingestionType, order, extras}) and fingerprintCanonicalOrder(order).
   - createManualOrder must use it and produce byte-identical output. Add a golden test with recorded fixtures before refactoring.
   - The normalizer's required-field list and the builder share one field definition.
5c. Introduce the ingestion command: src/modules/order-ingestion/standalone-order-ingestion.service.ts with CanonicalOrderInput and acceptOne(ctx, input, {channel, idempotencyKey, hold?}).
   - It owns envelope + fingerprint + repository acceptance + (when not held) dispatchById with the existing 503 semantics.
   - It owns idempotency-key namespacing per channel (manual unchanged; import 'import:<batchId>:<row>'; E05 'api:<key>') and the shared order-reference normalizer (lowercase, strip leading #, remove whitespace → 'ref:<key>'). US-04.6-04 and E05 both call it instead of re-implementing it.
   - Reduce OrdersService.createManualOrder to a ManualOrderChannelAdapter (DTO → CanonicalOrderInput) plus acceptOne, with identical responses, codes and fingerprints (run the manual-order contract suite before and after).
   - Add a static test: nothing outside the ingestion service imports ManualOrderIngestionRepository, and no Standalone code calls dispatchById except the service and the existing retry endpoint.
6. Frontend: extend the lifecycle union, the tone classes (neutral for awaiting_start, muted for not_started), the badge, the filter chips and ar/en translations ("Awaiting start / بانتظار البدء", "Not started / لم يبدأ").

Tests:
- The predicate excludes held and withdrawn rows; releaseHeld is idempotent; withdraw after release is a no-op; release versus withdraw on the same row lets exactly one win.
- The projection covers all four hold states, and existing lifecycle outputs are unchanged (a regression table).
- The normalizer produces equal NormalizedOrder (except rawPayload) for manual and bulk envelopes.
- A static test that fails if src/modules/verification-core contains 'bulk_import', 'hold_group' or 'importBatch'.
- Existing manual-order, entitlement and Shopify contract suites stay green.

Don't build any import tables, endpoints, UI pages or pacing here.
```

## US-04.6-02 — Import batch model and secure file intake

```text
Implement US-04.6-02 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-02-import-batch-model-and-secure-file-intake.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: an owner or admin uploads a .csv or .xlsx file and gets back a persisted draft batch with parsed rows. The file must be parsed exactly once, safely, for every encoding and Excel quirk listed in the story.

Read first:
- The story's Data contract and acceptance criteria 1–12.
- src/modules/orders/orders.controller.ts and orders.service.ts: the guard order (role, single active standalone source, onboarding) to mirror for IMPORT_* codes.
- src/modules/billing/billing.controller.ts: @Throttle usage.
- src/modules/auth/organization-role.ts: assertOrganizationWriteAllowed.
- src/shared/config/* and env-validation.ts: how flags are registered.
- src/app.module.ts: module and queue registration.

Dependency step (do this first and stop for approval): propose the parser libraries.
- A streaming CSV parser, e.g. csv-parse.
- iconv-lite for windows-1256 and UTF-16.
- An XLSX reader. It must NOT be npm xlsx@0.18.5. Evaluate exceljs against the SheetJS CDN build pinned by integrity.
Report versions, weekly maintenance, known advisories (npm audit) and how each supports cached formula values, hidden sheets, cell number formats and an uncompressed-size cap. Wait for my choice before installing.

Build:
1. Additive migration and Drizzle schema for order_import_batches, order_import_rows and order_import_mapping_profiles, exactly as in the story's Data contract, with RLS org_id = get_user_org_id(), the indexes, and a short_code generator (6-char base32, unique per org, retry on collision).
2. The src/modules/order-imports/ module:
   - order-imports.controller.ts, order-imports.service.ts and order-imports.repository.ts.
   - A guard/decorator for flag, standalone source, onboarding and role, reused by later stories.
3. Parsers in src/modules/order-imports/parsers/, all pure and unit-testable, producing Grid = {headers, rows:[{rowNumber, cells}]}:
   - file-sniffer.ts: magic bytes. ZIP containing xl/workbook.xml → xlsx. vbaProject.bin → reject. OLE2 → legacy xls or protected. Other binary → unreadable.
   - text-decoder.ts: BOM → strict UTF-8 → windows-1256. Returns the encoding.
   - csv-grid.parser.ts: delimiter detection over the first 50 non-empty lines (',', ';', tab; ties prefer ','), RFC 4180 quoting including multi-line cells. A malformed quote becomes a row issue, not a crash.
   - xlsx-grid.parser.ts: first visible sheet; cached values only; text-formatted numbers keep their text; serial dates become ISO with the 1900 leap bug honored; merged cells keep the top-left value only; ignored sheet names are listed; a 50 MB uncompressed cap enforced while inflating.
   - header-normalizer.ts: first non-empty row, trim + NFC, blank headers → "Column N", duplicates → " (2)", blank rows dropped, 1,000-char truncation → FIELD_TOO_LONG, extra and missing cells.
3b. Extract the role, single-active-source, standalone and onboarding checks from OrdersService.createManualOrder into StandaloneSourceResolver.resolveWritable(user, codeMap). createManualOrder calls it with its existing MANUAL_ORDER_* codes (identical responses; run the manual-order contract suite before and after). The order-imports guard calls it with the IMPORT_* codes. The resolver is owned by, and called through, StandaloneOrderIngestionService (the adapter boundary from US-04.6-01).
4. POST /api/order-imports (multipart, memory storage, limits: fileSize 5 MB, files 1). Enforce the row, column and draft caps (all env-configurable), a parse time cap of 20 s and @Throttle 10/min per user.
   - Persist the batch plus rows in chunks of 500 inside one transaction.
   - Return the response shape from AC8, including duplicateFileOf (same org and sha256 within 24 h).
5. DELETE /api/order-imports/:id (draft only).
6. GET /api/order-imports/template?format=csv|xlsx&locale=ar|en. Introduce the shared src/modules/order-imports/csv-writer.util.ts now (UTF-8 BOM, CRLF, RFC 4180 quoting, formula escaping of = + - @ \t \r with a ' prefix). US-04.6-08 reuses it.
7. Frontend, API layer only: features/order-imports/api/orderImportsApi.ts with typed upload/discard/template functions, and a fetchWithAuth change so FormData bodies don't get a forced Content-Type (verify existing JSON callers are unaffected).

Tests:
- Build a fixtures folder test/fixtures/order-imports/ with a generator script for every quirk in the story's edge cases and epic catalogue "File and format": UTF-16LE tab, windows-1256, semicolon, BOM plus multiline quotes, hidden first sheet, merged cells, formulas, serial dates, number-formatted phones, protected, xlsm, legacy xls, PDF renamed, zip bomb, 5,000/5,001 rows, 100/101 columns, 5 MB+1, header-only, blank-only.
- An expected Grid per fixture.
- Role, flag, Shopify and onboarding denial; the draft cap; discard; duplicateFileOf; nothing persisted on rejection.
- A timing test that 5,000×20 parses in under 1 s locally (record the actual number).
```

## US-04.6-03 — Column detection, mapping and saved profiles

```text
Implement US-04.6-03 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-03-column-detection-mapping-and-saved-profiles.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: Akeed suggests the right column for each canonical field (Arabic and English headers, Shopify exports), lets the merchant correct it, classifies payment values, and remembers the mapping for the next upload with the same headers.

Read first:
- The story's AC 1–8 and edge cases.
- src/shared/commerce/payment-signals.ts.
- src/modules/onboarding/dto/onboarding.dto.ts (ONBOARDING_SHIPPING_CURRENCIES).
- The integrations columns shippingCurrency, countryCode, timezone and assumeCodWhenPaymentMissing in schema.ts.
- The order-imports module created by US-04.6-02.

Build:
1. src/modules/order-imports/mapping/header-key.ts: the normalization in AC1 (lowercase, strip Arabic diacritics and tatweel, أ/إ/آ→ا, ة→ه, ى→ي, Arabic-Indic digits, remove punctuation and whitespace).
2. mapping/alias-dictionary.ts: every alias in AC2, versioned (MAPPING_DICTIONARY_VERSION).
3. mapping/column-matcher.ts: a pure function (headers, sampleRows) → suggestions with confidence exact/partial/none.
   - Implement the Shopify "Name" ambiguity rule (AC3) and the phone column priority Shipping Phone > Phone > Billing Phone, with alternatives listed.
   - A field can take two columns only for first and last name.
4. mapping/payment-value-classifier.ts: distinct values (up to 50) with counts → cod / not_cod / unknown, using isCashOnDeliveryPaymentSignal plus the import dictionaries in AC6.
5. The upload response (US-04.6-02) now includes suggestions, the payment-value list and date ambiguity detection (every value valid as both DMY and MDY, none disambiguating).
6. PUT /api/order-imports/:id/mapping:
   - A class-validator DTO: mapping plus options {country, defaultCurrency, dateFormat, paymentValueMap}.
   - Enforces the rules in AC4 and AC5: required fields, one column per field, a currency in the list, dateFormat required when ambiguous, every unknown payment value resolved.
   - Draft-only and expiry checks.
   - Persists the mapping, upserts the profile by header_signature (sha256 of the sorted header keys), then calls the validation entry point.
   - Until US-04.6-04 exists, that entry point is a no-op seam, a RowValidationService with a single validateBatch(batchId) method, so US-04.6-04 plugs in without touching the controller.
7. Saved profile auto-apply on upload with source 'saved'. Fall back field by field when a saved header is missing.
8. Default options: country from the store's countryCode, else 'EG'; currency from shippingCurrency.

Tests:
- Table tests for every alias and normalization variant; the Name ambiguity rule both ways; phone priority; payment classification including كاش, عند الاستلام, Paid, مدفوع, InstaPay and blank.
- Mapping validation errors: missing required fields, duplicate column, bad currency, ambiguous date without a format, unresolved payment value.
- A non-draft batch returns IMPORT_BATCH_STATE_CONFLICT; an expired batch returns IMPORT_BATCH_EXPIRED.
- Profile save, auto-apply and partial apply.
- A viewer is denied and another org's batch returns 404.

No UI in this story (US-04.6-05 builds it). No row validation rules (US-04.6-04).
```

## US-04.6-04 — Row normalization, validation and dedupe

```text
Implement US-04.6-04 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-04-row-normalization-validation-and-dedupe.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: every stored row becomes a deterministic outcome (ready / invalid / duplicate / excluded) with all its issue codes and a normalized order, so preview and commit never disagree and no order can be imported twice.

Read first:
- The story's AC 1–13.
- The epic edge-case catalogue sections "Data" and "Duplicates".
- src/shared/services/phone.service.ts.
- src/shared/commerce/payment-signals.ts.
- The unique_external_order_per_integration index and the orders columns in schema.ts.
- src/modules/order-imports/ (the RowValidationService seam from US-04.6-03).

Build:
0. Extract src/shared/commerce/canonical-order.rules.ts holding the constants and pure validators now embedded in CreateManualOrderDto: phone length 7–20, name ≤ 255, orderNumber ≤ 100, the totalPrice pattern, the currency list (ONBOARDING_SHIPPING_CURRENCIES) and paymentMethod ≤ 100. Refactor the DTO decorators to read them, with unchanged messages. The import validator must call these, not re-declare them.
1. PhoneService gains one core parse(raw, region) returning a typed result. The existing standardize() (unchanged behavior and exceptions) and the new standardizeMobile(raw, region) both delegate to it, so there is only one libphonenumber path.
   - standardizeMobile returns {ok, e164} | {ok:false, code}, with codes PHONE_INVALID, PHONE_NOT_MOBILE and PHONE_SCIENTIFIC_NOTATION.
   - Accepts MOBILE and FIXED_LINE_OR_MOBILE. Treats 00 as +. A leading + keeps its own country. EG 10-digit numbers starting with 1 are accepted.
   - Keep standardize() unchanged for existing callers.
2. src/modules/order-imports/validation/: pure functions with no I/O, one file per concern.
   - text.ts: NFC; Arabic-Indic and Persian digits; ٫ and ٬; strip zero-width and bidi characters.
   - phone.ts: multiple-number detection (PHONE_MULTIPLE).
   - name.ts: NAME_MISSING, NAME_TOO_LONG at the shared limit (255), NAME_NOT_TEXT via a Unicode letter check; first and last name joined.
   - amount.ts: the separator rules exactly as AC4 and the currency word/symbol strip list. It then validates with the shared totalPrice rule (map its failure to AMOUNT_NOT_POSITIVE, AMOUNT_TOO_PRECISE or AMOUNT_TOO_LARGE). Output a 2-decimal string.
   - currency.ts: symbol/word → ISO, the default currency, the allowed list.
   - payment.ts: uses paymentValueMap only to choose the canonical paymentMethod: 'cash_on_delivery' for cod values (original kept in paymentMethodOriginal), the original text for not_cod, '' for blank. The ready/excluded decision is then made by the existing OrderEligibilityService.evaluateOrderForVerification with the source integration: non_cod_payment_method → PAYMENT_NOT_COD, missing_payment_signal → PAYMENT_UNKNOWN_EXCLUDED. Do NOT re-implement assumeCodWhenPaymentMissing.
   - date.ts: ISO, DMY/MDY/YMD, Excel serial, ISO with offset. Interpreted in the store timezone. Future more than 1 day → invalid. Older than 7 days → excluded (env BULK_IMPORT_MAX_ORDER_AGE_DAYS=7).
   - reference.ts: at most the shared orderNumber limit (100); the key comes from the ingestion command's shared order-reference normalizer (US-04.6-01), not a local copy; dedupe_key 'ref:<key>'.
3. row-validator.ts composes these into {normalized, outcome, issues}, with precedence invalid > duplicate > excluded > ready.
4. RowValidationService.validateBatch(batchId):
   - Loads rows, validates them, then runs the in-file dedupe (L2): line-item collapse into the lowest row with collapsed_into; conflicting references are all invalid; reference-less identical rows collapse.
   - L1: one set query of ref keys against orders.external_order_id for the source → ALREADY_IMPORTED with the existing order id.
   - L3: one query for (phone, amount) within 7 days and one for order_number (case-insensitive) within 30 days → POSSIBLE_DUPLICATE with params, excluded, preserving include_override.
   - Writes rows in chunks of 500, recomputes counts and order_date_min/max from rows, and stores validationVersion on the batch.
5. GET /api/order-imports/:id/rows?outcome=&cursor=&limit (max 100), ordered by row number.
6. PATCH /api/order-imports/:id/rows/:rowNumber {include}: only POSSIBLE_DUPLICATE rows, draft only; recomputes counts.
7. Return and persist the issue codes exactly as named in the epic contract. Add the issue-code → message catalogue to the frontend now in ar/en: orderImport.issues.<CODE> with ICU params.

Tests:
- A table-driven test with every example in the story and the epic "Data" catalogue, each asserting its exact code and normalized value.
- The Shopify 3-line-item order collapses; the same ref with a different phone makes all rows invalid; L1 and L3 against seeded orders (integration test); include_override survives re-validation.
- Determinism: validating twice gives an identical result.
- Performance: 5,000 rows validated in under 2 s excluding I/O (record the number).
- Re-mapping (country change) re-normalizes from raw.
```

## US-04.6-05 — Upload, mapping and review wizard UI

```text
Implement US-04.6-05 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-05-import-wizard-upload-mapping-review-ui.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md. Load the frontend-dev skill before writing any code.

Goal: a merchant, in Arabic or English, on desktop or phone, can upload a file, confirm the column mapping, see exactly which orders are ready and why others aren't, and resume at any point by URL. The UI must say "nothing has been sent" at every step.

Read first:
- The story's AC 1–12 and mockup prompts M1–M5.
- The epic's shared design brief.
- akeed-frontend: src/app/[locale]/verifications/page.tsx (page/skin pattern and useAkeedMode gating); src/shared/layout/StandaloneSidebar.tsx; src/shared/ui/index.ts; features/orders (api/domain/skins pattern, manualOrderApi error codes); features/onboarding/ui/standalone/components (OnboardingStepRail, OnboardingStepProgress); src/shared/query/keys.ts and domainEvents.ts; src/shared/lib/auth.ts and http.ts; public/messages/{ar,en}.json.
- The backend contracts from US-04.6-02 to 04 (controller DTOs).

Build:
1. features/order-imports/{api,domain,ui,skins/standalone}: typed API (upload with XHR progress, getBatch, getRows, putMapping, patchRow, discard, templates), queryKeys.orderImports.{list,detail,rows}, and mutations.
1b. Reuse, don't copy:
   - Promote manualOrderCurrencies and MANUAL_ORDER_PAYMENT_METHOD to src/shared/commerce/orderCommerce.ts and re-import them in the manual form.
   - Export ALLOWED_COUNTRIES from shared/ui/international-phone-input.tsx for the country picker.
   - Use ApiError/getErrorMessage, Badge and VerificationStatusBadge tones.
2. Routes /[locale]/imports/new and /[locale]/imports/[batchId]. The batch page chooses its step from the server status. Unknown or other-org batches show a not-found state. Expired drafts show the "expired after 24 hours" state. Shopify embedded mode redirects to the dashboard.
3. Stepper: extract OnboardingStepRail/Progress into src/shared/ui/stepper if they are onboarding-coupled, without changing onboarding's appearance (screenshot onboarding before and after).
4. Upload step (M1/M2): dropzone plus button (keyboard operable, accept .csv,.xlsx), a client pre-check, a progress bar then "Reading your orders…", template links, the open-drafts list, every file-level error code mapped to title + explanation + one action, and the duplicate-file banner.
5. Map step (M3): the field rows with select, samples and confidence icon; required-field errors; the Import settings panel (country, currency, date format only when ambiguous); Payment values toggles; ignored columns collapsed. Save calls PUT /mapping.
6. Review step (M4): tiles, the date-range and old-orders banners plus the permanent "Nothing has been sent" banner, tabs, the paged table with all localized reasons, "Include anyway" with optimistic PATCH and rollback, "Download rows to fix" (wire it to /errors.csv; it shows disabled with a tooltip until US-04.6-08 exists), the primary "Import {n} orders" (disabled at 0), Back and Discard with confirmation. The Import button calls the commit endpoint from US-04.6-06; until then it's disabled behind a TODO referencing US-04.6-06.
7. Mobile (M5): "Step X of 3", stacked mapping, row cards and a sticky primary action.
8. Viewer read-only mode. Focus moves to the step heading on step change. Status is shown with text and icon, not color alone.
9. A temporary entry link (a "New import" button on the verifications page header). The final sidebar entry lands in US-04.6-08.

Verify:
- tsc, lint on the touched files and build.
- Run the app with preview_start and walk the flow with real fixtures from test/fixtures/order-imports (arabic-excel.xlsx, shopify-orders-export.csv, a protected file).
- Screenshots for M1–M5 in AR RTL and EN, light and dark, at 1440 and 390, saved to akeed-frontend/output/playwright/order-imports/.
- Compare against the mockup prompts and list any deviations.
```

## US-04.6-06 — Idempotent commit into held orders

```text
Implement US-04.6-06 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-06-idempotent-commit-into-held-orders.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: "Import N orders" creates each ready row's order and held event exactly once, survives double-clicks, refreshes, concurrent batches and worker crashes, and never sends anything.

Read first:
- The story's AC 1–9.
- Epic invariants 2–5.
- src/infrastructure/database/repositories/manual-order-ingestion.repository.ts (transaction, onConflictDoNothing, assertPersisted).
- src/modules/orders/orders.service.ts (idempotency key normalization, envelope and fingerprint building).
- src/shared/queue/job-options.ts.
- The BullMQ queue registration in app.module.ts and webhook-queue.module.ts.
- US-04.6-01's releaseHeld and withdrawHeld (not used here, but understand the hold columns).

Build:
1. Use the shared buildStandaloneOrderEnvelope from US-04.6-01. Extract the private OrdersService.normalizeIdempotencyKey to src/shared/validation/idempotency-key.ts with a caller-supplied code map (manual keeps MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED and MANUAL_ORDER_VALIDATION_FAILED; import uses IMPORT_IDEMPOTENCY_KEY_REQUIRED and IMPORT_VALIDATION_FAILED).
2. The commit job never touches persistence directly. A FileImportChannelAdapter maps each ready row to CanonicalOrderInput, and the job calls StandaloneOrderIngestionService.acceptMany(ctx, inputs, {channel: 'bulk_import', hold: {groupId: batchId}}). Add acceptMany to the service. There is NO new ingestion repository; refactor ManualOrderIngestionRepository underneath the service:
   - Extract the per-order body of runAcceptance into acceptWithinTransaction(tx, input, {hold}).
   - accept() (manual) is one transaction around one call, with unchanged behavior and errors.
   - Add acceptMany(inputs, {hold}), one transaction per chunk of 200, each row in its own savepoint (nested tx.transaction) so one conflicting row rolls back only itself.
   - Generalize assertPersisted to a list of ids.
   - Run the manual-order contract suite before and after.
   Per row:
   - Insert the webhook_event (idempotency_key import:<batchId>:<rowNumber>, hold_state held, hold_group_id, dispatch_required false) with onConflictDoNothing, reloading the existing event on conflict.
   - Insert the order with onConflictDoNothing on (integration_id, external_order_id).
   - If the order conflicts because of a different owner, set the row to duplicate/ALREADY_IMPORTED and delete the event just inserted.
   - Otherwise link order_id and webhook_event_id and set outcome 'imported'.
   - After the transaction, do a read-back assertion for the chunk's order ids.
3. externalOrderId is ref:<key> or imp:<batchId>:<rowNumber>. orderNumber is the reference as written or IMP-<shortCode>-<rowNumber>. rawPayload uses ingestionType 'bulk_import' with importBatchId and importRowNumber.
4. POST /api/order-imports/:id/commit:
   - Idempotency-Key validation (reuse the manual normalizer).
   - A conditional UPDATE from draft to committing that sets commit_idempotency_key.
   - Same-key replay, different-key IMPORT_BATCH_STATE_CONFLICT, cross-batch key IMPORT_IDEMPOTENCY_CONFLICT, IMPORT_NOTHING_TO_IMPORT, IMPORT_BATCH_EXPIRED.
   - Enqueue import.commit with jobId import-commit-<batchId> on a new 'order-import' BullMQ queue (concurrency 2, shared job options).
5. The import.commit processor: processes only ready rows without order_id in row order; recomputes counts after each chunk; exposes progress through GET /:id; on completion sets awaiting_start, committed_at and start_deadline_at = +72h (env BULK_IMPORT_START_WINDOW_HOURS). After 5 failures of a chunk, sets the batch to failed while keeping imported rows held.
6. Frontend:
   - The committing view (M6 frame A) polls every 2 s.
   - The imported view (M6 frame B): counts, deadline note, "Start WhatsApp confirmation" (disabled with a note until US-04.6-07), "Review orders" linking to verifications?importBatchId=<id>, and "Download report".
   - Emit the order.created domain event on completion.
   - Wire the review-step Import button.
7. Backend: support ?importBatchId= on GET /api/verifications (org-scoped, via orders.raw_payload->>'importBatchId' or a join through order_import_rows). Frontend: a dismissible "From import: {file}" chip.

Tests:
- Same key twice gives one job; two tabs with different keys; a key reused on another batch.
- Two batches with overlapping refs committed concurrently: exactly one order per ref, and the loser row is ALREADY_IMPORTED with no orphan event.
- Crash-resume (throw after chunk N, re-run): no duplicates and correct counts.
- A chunk failing 5 times leaves the batch failed with a consistent partial import.
- Commit creates zero dispatches, zero credit holds and zero verification rows.
- The manual-order contract suite stays green.

Verify in the browser with a fixture: commit, refresh mid-commit, double-click, and check the verifications list shows "Awaiting start".
```

## US-04.6-07 — Start confirmation checkpoint and paced release

```text
Implement US-04.6-07 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-07-start-confirmation-checkpoint-and-paced-release.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: the merchant deliberately starts confirmation after seeing the count, duration and credit cost and attesting consent. Akeed then releases held orders at a safe per-organization pace, pauses for quiet hours or blockers, and can be stopped. This is the only code in the epic allowed to trigger sends.

Read first:
- The story's AC 1–12, mockups M7 and M8, and epic invariants 1, 2, 6 and 7.
- src/modules/orders/orders.service.ts (the gate sequence in createManualOrder and retryOrderVerification, assertCreditEligible).
- src/modules/verification-core/credit-eligibility.service.ts and billing-entitlement.service.ts.
- src/shared/billing/credit-eligibility.ts.
- src/shared/utils/quiet-hours.util.ts.
- src/modules/verification-automation/* (how delayed and repeatable jobs are used).
- src/modules/webhook-queue/webhook-dispatch.service.ts (dispatchById outcomes).
- The billing purchase flow in akeed-frontend/src/features/billing.

Build:
1. Extract StandaloneSendReadinessService.evaluate(source, {required: N}). It absorbs the entitlement, auto-verify, credit and slot gates of createManualOrder AND the private assertCreditEligible and retryReadinessReason. After the refactor, orders.service.ts and order-imports must contain no direct calls to CreditEligibilityService.resolveDenial or hasAvailableSlot. It returns typed blockers:
   - IMPORT_AUTO_VERIFY_DISABLED, IMPORT_SETUP_INCOMPLETE.
   - The credit denial codes, including INSUFFICIENT_CREDITS with a shortfall.
   - IMPORT_PLAN_LIMIT_REACHED in periodic mode.
   Refactor createManualOrder and retryOrderVerification to use it with no change in behavior or error codes. The existing manual-order tests are the proof: run them before and after.
2. GET /:id/start-quote as in AC1. The quoteToken is an HMAC (a new env secret, validated) over batchId, N, the balance snapshot and expiry (10 minutes). estimatedDurationMinutes = ceil(N/rate) plus the minutes of quiet-hours windows overlapping that span, in the store timezone.
3. POST /:id/start with Idempotency-Key and {attestationVersion:'bulk-import-consent-v1', quoteToken}:
   - IMPORT_ATTESTATION_REQUIRED and IMPORT_QUOTE_STALE (return a fresh quote); re-evaluate the blockers.
   - An atomic transition to releasing that sets the immutable attestation fields and appends an event.
   - Ensure the org release scheduler exists. Same-key replay; different-key conflict.
4. The import.release repeatable job per org (jobId import-release-<orgId>, every 30 s, rate env BULK_IMPORT_RELEASE_PER_MINUTE default 20, bounds 1–120). Each tick:
   - If quiet hours apply (re-read settings), set quietHoursUntil and release nothing.
   - Else evaluate readiness with required = 1. On any blocker, pause all the org's releasing batches with paused_reason.
   - Else select up to ceil(rate×0.5) held events across releasing batches (oldest started_at, then row_number), call releaseHeld and dispatchById for each released id (log failures; the reconciler covers them), mark batches with no remaining held events completed, and remove the repeatable job when none are releasing.
   - Re-register schedulers on worker boot for orgs with releasing batches.
5. POST /:id/stop (withdrawHeld, stopped, returns released and withdrawn counts, idempotent) and POST /:id/resume (re-run the gates, no new attestation; staff_paused can't be resumed by the merchant).
6. The hourly import.expire job: withdraw awaiting_start and paused batches past start_deadline_at, then mark them not_started.
7. Frontend:
   - StartConfirmationDialog (M7 plus the shortfall and auto-verify variants). Buy credits reuses the billing purchase flow with returnTo=/imports/{id} and re-quotes on return.
   - The releasing, paused and stopped panels (M8) poll every 5 s, with live lifecycle counts from GET /:id.
   - The Stop confirmation dialog.
   - Emit domain events on start and stop so the verification and billing queries refresh.
   - Reuse the existing creditErrors.* translations and the manual-order billingLink feedback pattern for credit blockers. Don't add parallel strings.

Tests (use a fake clock and a fake messaging port, never real Meta):
- Quote maths with follow-up on and off in credit and periodic modes; every blocker; stale quote; wrong attestation version; idempotent start, stop and resume.
- Two batches share one org rate; quiet hours crossing midnight pause and resume; a balance drop mid-release auto-pauses and resume continues; a stop racing a tick means no event is both released and withdrawn; completion; 72 h expiry.
- No event is dispatched twice. Withdrawn events have zero credit reservations.
- Manual order latency is unaffected while a batch is releasing (manual orders never touch the scheduler).
- The manual-order, credit-usage and entitlement contract suites stay green.

Verify in the browser: the shortfall variant, buy-credits return, start, paused banner (simulate by lowering credits), stop, with screenshots of M7 and M8 in AR and EN, light and dark.
```

## US-04.6-08 — Import history and results export

```text
Implement US-04.6-08 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-08-import-history-and-results-export.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md. Load the frontend-dev skill before any UI work.

Goal: merchants see every import and its live outcome, and can download an Excel-safe results file and a fix-and-re-upload error file. For merchants without an integration, the results file is the product.

Read first:
- The story's AC 1–8 and mockups M9 and M10.
- src/infrastructure/database/repositories/orders.repository.ts (the retryGuardStatus expression to reuse for lifecycle counts).
- src/modules/order-imports/csv-writer.util.ts (from US-04.6-02).
- akeed-frontend/src/shared/layout/StandaloneSidebar.tsx, the dashboard Standalone empty state, features/orders/skins/standalone/ManualOrderTopBarAction.tsx, and features/billing/lib/csvDownload.ts.

Build:
1. GET /api/order-imports (cursor, 20 per page, newest first) and GET /:id with the full detail from AC2. Compute lifecycle counts in one grouped query using the shared projection, not per-order reads.
2. GET /:id/results.csv and /:id/errors.csv:
   - Streamed with keyset pagination through a Readable; constant memory.
   - Columns and order exactly as AC3 and AC4; locale=ar|en headers and localized reasons and statuses (server-side message catalogue mirroring the frontend keys).
   - The store timezone for timestamps; phones written as '+20… (escaped).
   - The sanitized Content-Disposition with filename*, and Cache-Control: no-store. Any member can download.
   - After the 90-day row purge, fall back to imported orders via raw_payload.importBatchId and say so in the detail response.
3. The header matcher (US-04.6-03) ignores akeed_row, akeed_status and akeed_reason on re-upload.
4. Frontend:
   - The sidebar item "Import orders / استيراد الطلبات" (Standalone plus flag).
   - /imports history (M9) with day grouping, status badges, progress, the actions menu and an empty state.
   - Batch detail (M10) with the outcome cards, a token-built stacked bar, "Mapping used" and downloads via an authenticated fetch → Blob (never a token in the URL).
   - Promote features/billing/lib/csvDownload.ts to src/shared/lib/download.ts with downloadBlob(blob, filename), keeping downloadCsv as a wrapper (update the billing import), and use it for both downloads.
   - An "Import from file" secondary entry in the dashboard empty state and next to the manual order action.
   - Enable the review-step "Download rows to fix". Remove the temporary link from US-04.6-05.

Tests:
- The formula-injection table (= + - @ tab CR, names starting with - or +, =HYPERLINK); BOM and CRLF; Arabic round-trip read back by an XLSX/CSV test reader.
- Streaming memory stays bounded for 5,000 rows; results include every source row; errors.csv round trip (edit a fixture's errors.csv, re-upload, and only the fixed rows become ready while the others are ALREADY_IMPORTED).
- Authorization for viewer, other org and flag off; the post-retention fallback.

Verify in the browser: history, detail and both downloads opened and inspected. Screenshots of M9 and M10 in AR and EN, light and dark, at 1440 and 390.
```

## US-04.6-09 — Security, retention and observability

```text
Implement US-04.6-09 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-09-security-retention-and-observability.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: bulk customer data is tenant-isolated, minimally retained, fully audited and observable, and there is a tested kill switch and runbook before any pilot.

Read first:
- The story's AC 1–9.
- The epic metrics section.
- src/shared/logging/backend-log.util.ts.
- admin_access_audit and its repository.
- The admin store view in akeed-frontend/src/app/[locale]/admin/stores/[integrationId].
- The existing admin guards (ADMIN_CONTROL_TOWER_ENABLED, AAL2).
- src/shared/config env validation.

Build:
1. An authorization matrix test over every order-import endpoint × {owner, admin, viewer, other-org owner, unauthenticated, Shopify org, flag off}, with expected status and code. Fix any gap found; don't weaken the test.
2. Hardening review of the intake: memory-only storage, buffer released, the parser timeout (20 s), XLSX external links, macros and objects ignored, request body excluded from error/log middleware. Document the review in the evidence.
3. order_import_batches.events jsonb, append-only through a single repository method. Backfill the transitions written by US-04.6-06 and 07 to use it. Add the indexes (status, expires_at) and (committed_at).
4. The daily import.purge job exactly as AC3 (batched 1,000, idempotent), plus mapping-profile cleanup at 365 days.
5. The kill switch as AC7 across all endpoints and the UI. Staff pause: an admin endpoint behind the existing admin guards sets paused_reason 'staff_paused' on an org's releasing batches, audited in admin_access_audit. The merchant UI shows "Paused by Akeed support" with resume hidden.
6. The admin read-only batch panel on the admin store page (no row data), with access audited.
7. Metrics and alert hooks for every event in the epic metrics list, plus the four alerts in AC6. Use the existing observability conventions (see the E04.5 US-04.5-07 implementation).
8. A PII log scan test: run upload → commit → start → release → export with a fixture of unique marker values, capture all logger output, and assert none of the marker phones, names, addresses, amounts or the file name appear.
9. Write docs/runbooks/bulk-order-import.md covering the topics in AC9, with concrete SQL and admin steps.

Tests: the matrix; purge boundaries (day 89 vs 91, draft 23 h vs 25 h); purge during an export; the parser timeout; kill-switch behavior per endpoint; staff pause beats merchant resume; the PII scan.
```

## US-04.6-10 — Bulk import release gate

```text
Execute US-04.6-10 from akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/US-04.6-10-bulk-import-release-gate.md.
Follow the shared rules in akeed-backend/docs/Epics/04.6-standalone-bulk-order-import/IMPLEMENTATION-PROMPTS.md.

Goal: produce recorded evidence for a go/no-go decision on enabling bulk import for all Standalone merchants. This is a verification story: fix only defects that the gate uncovers, each noted in the evidence with the owning story.

Read first:
- The story's AC 1–9, the whole epic README (every edge-case catalogue entry must map to a passing test or a pilot observation) and the evidence sections of US-04.6-01..09.

Do:
1. Complete test/fixtures/order-imports/ with every file in AC1 and a JSON manifest per file (per-row expected outcome and issue codes), generated by a committed script. Real merchant samples must be anonymized first; ask me for them, and don't invent them.
2. Build a traceability table (epic edge case → test name or pilot observation) and append it to this story's evidence. Any unmapped entry blocks the gate: write the missing test.
3. End-to-end: a backend integration test plus a Playwright flow for arabic-excel.xlsx covering upload → map → review → commit → start → release (fake messaging port) → simulated confirm/cancel replies → results.csv, which must match the manifest. Assert zero sends before start.
4. The equivalence proof (AC3): the same order through manual creation and through import produces identical verification, dispatch-ledger kinds, credit ledger, follow-up/no-reply jobs and dashboard lifecycle (normalize ids and timestamps). Also the static no-branch check on verification-core and the send services.
4a. The architecture check: order-imports and orders reach persistence and dispatch only through StandaloneOrderIngestionService (or the release scheduler), and nothing in verification-core, the normalizers or the eligibility strategies reads ingestionType.
4b. The static duplication check from story AC3, which proves every row of the epic README Reuse map: no second currency list, idempotency-key regex, totalPrice pattern, PhoneNumberUtil instance, source-resolution check, direct resolveDenial/hasAvailableSlot call outside StandaloneSendReadinessService, second ingestion repository or second download helper. Also re-run npm run test:contract:manual-orders and record that the manual responses and fingerprints are unchanged.
5. The concurrency suite (AC4) and the regression suites (AC5): npm test and every test:contract:* script. Record each command and its pass count.
6. Performance (AC6) on a staging-like environment. If one isn't available, run locally, record the hardware, and mark it TARGET VALIDATION REQUIRED.
7. Add BULK_IMPORT_PILOT_ORG_IDS (an allow-list checked together with the flag) with tests.
8. Prepare, but don't run, the pilot and quality-review checklist (AC7, AC8): per-merchant recording template, daily WhatsApp quality-rating and template-status check log, and rollback steps. Live pilot steps involve real customers and external platforms: stop and hand them to me instead of executing them.
9. Draft the go/no-go record with a decision placeholder for each ASSUMPTION (release rate, 7-day age window, L3 windows, 72 h start window) and the evidence available so far.

Close-out: set this story to "Implemented locally — release blocked (pilot pending)" unless I provide pilot results. Update the epic README status, and update the root docs/Epics/README.md status line only after a recorded "go".
```
