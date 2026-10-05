# US-08-02 Record template identity per send evidence

**Validated:** 2026-10-05
**Revision:** backend `develop` at `02595e8` (baseline commit `46dc872`, recording `52b6c22`, metrics `02595e8`); frontend untouched
**Decision:** implemented locally, on `develop`, not pushed. There is no switch: no customer-facing message changes. Migration `0053` has been applied to disposable test databases only; each environment applies it at its next boot.

Story: [US-08-02](Epics/08-whatsapp-template-management/US-08-02-record-template-identity-per-send.md). Meta was not called. The only parts of the [US-08-01 contract record](Epics/08-whatsapp-template-management/evidence/US-08-01-contract-record.md) this story relies on are its CODE findings 4.6.6 and 4.7.6 (what Akeed sends today) and the rule that the order of named values does not change (4.6.11). The record is still a draft and US-08-01 is still Backlog; nothing here depends on its open sections.

## What the code had, against the story's evidence note

The story's note held at `038888e`:

- `VerificationSendService` claimed each dispatch with `template_name` `cod_verification` (or `cod_verification:follow_up`) and `language_code` from the store preference, usually `auto`.
- `verifications.template_name` and `language_code` had the defaults `cod_verification` and `ar` and no writer.
- Language and variant were resolved inside `WhatsAppService`, after the claim. The resolved values appeared only in its failure log.

One thing the note did not say: an existing spec (`provider-neutral-entitlement.spec.ts`) sends for an order with no phone. Selection used to sit inside the adapter, which that spec replaces, so a missing phone never reached it. Selection now runs in the send service, so `selectCodTemplate` reads a missing number as a local number instead of throwing. `orders.customer_phone` is `NOT NULL`, so this cannot happen for a stored order.

## Decisions

Product owner, 2026-10-05:

| Question | Decision |
| --- | --- |
| Open decision 1: the never-written `verifications.template_name` and `language_code` | Option (a): written with the real values on each accepted send. The dispatch row's old `template_name` and `language_code` hold the same real values. The two defaults on `verifications` are dropped. Existing rows are not rewritten. |
| Scope of the metrics ("like the admin funnel", which loads Shopify stores only) | Cross-tenant and staff-only, every source together. No platform filter. |
| Open decisions 2 to 5 | The story's proposals: test sends excluded unless `include_test=true`; an outcome credited to the latest accepted dispatch before it; replies are customer confirmations plus customer cancellations; UTC days, at most 92. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| The story says identity is written at claim time; the step brief says the adapter returns what it sent and it is persisted with acceptance | Both. Selection runs before the claim and the claim writes it, which is the only way a send with an unknown outcome can keep it. The adapter then reports what it sent and the acceptance transaction stamps that on the dispatch and the verification. An adapter that reports nothing leaves the claimed values. |
| Purpose backfill (allowed by criterion 4, ruled out by "do not rewrite existing rows") | No backfill. Migration `0053` updates no row. |
| "Ignore rows without identity" against "group them as not recorded" | Both. They never count toward a template, and the response returns them apart under `not_recorded`. |
| Variant key | `<language>.<variant>`, for example `ar.egyptian` (criterion 1). If US-08-03 adopts `cod_confirm.ar.egyptian`, the mapping is a fixed prefix. |
| A test order's follow-up | `test` wins over `reminder` (the order of criterion 2). It does not occur today: a test send schedules no reminder. |
| What the port carries | The whole selection: variant key, resolved language, provider template name and language code, parameter mode and parameter order. The adapter no longer imports the catalog or the language rule. |
| Which merchant outcomes count | None as replies. A merchant's manual confirmation counts for nothing; a merchant's no-reply cancellation counts as a no-reply, because the customer never answered. |
| The CHECK constraints | Added directly, not `NOT VALID` then validated as first planned. Migrations run in one transaction, so the table lock is held either way. |
| `include_test` | Anything other than `true` or `false` answers 400, instead of being read as `false`. |
| Where this file lives | `docs/`, like the other story evidence. The epic's `evidence/` folder holds contract records. |

## Implemented behavior

- **Selection.** `selectCodTemplate` and `resolveTemplateSendPurpose` in `src/shared/messaging/cod-template-selector.ts`. Same rules as before: the store's forced language wins, `auto` follows the number, an unknown stored variant falls back to the language default.
- **Port.** `MessagingPort.sendVerificationTemplate` takes `template` in place of `preferredLanguage` and `templateSelection`, and its result may carry `template`, the identity sent. `WhatsAppService` builds the same payload from it.
- **Ledger.** `claim` takes `identity` and writes `template_variant_key`, `template_purpose`, `meta_template_name`, `meta_language_code` and `resolved_language` on all five write paths (plan-billed insert and claim, billing-exempt claim, prepaid insert and claim). `markAccepted` takes `sentTemplate`. `markFailedProviderOutcome`, `markOutcomeUnknown` and `resolveNotAccepted` do not touch these columns.
- **Verification.** `template_name` and `language_code` are written in the statement that writes `wa_message_id`, so they describe the same message. A repair uses the dispatch's stored identity only.
- **Logs.** `variantKey`, `templateName`, `languageCode`, `resolvedLanguage` and `purpose` are added to the existing send failure and acceptance logs. No new log line, no name, phone or text.
- **Data.** Migration `0053_dispatch_template_identity.sql` with its `_journal.json` entry: five nullable columns, two checks, a partial index on `accepted_at`, and `DROP DEFAULT` on the two verification columns. Additive and safe to replay.
  - Rollback: deploy the previous release, then optionally drop the index, the two checks and the five columns and restore the two defaults. The statements are in the migration header. No ledger or verification data is lost.
  - The index is built inside the migration transaction and blocks ledger writes while it builds. It uses `IF NOT EXISTS`, so it can be created `CONCURRENTLY` by hand first on a large ledger.
- **Metrics.** `GET /api/admin/templates/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&include_test=` behind `AdminAccessGuard` and the admin throttle, `Cache-Control: private, no-store`. `AdminQueryRepository.findTemplateMetrics`, `AdminTemplateMetricsService`, `admin-template-metrics.policy.ts`. A bad range answers `400 ADMIN_TEMPLATE_METRICS_RANGE_INVALID`.

## Verification

All run on 2026-10-05 on Windows, against the working tree that became `02595e8`. Documentation is the only thing that changed afterwards.

**No customer-facing change.** `whatsapp-send-payload.characterization.spec.ts` drives the real send service and the real Meta adapter and compares the serialized request body with `test/fixtures/whatsapp-templates/send-payloads/baseline.json`.

- The fixture was recorded from `038888e` and committed in `46dc872`, before any production change. The spec only compares.
- 33 cases: the 8 variants on the first send, the reminder and the test path, with the language forced against the number; `auto` with an Arabic, a non-Arabic and a local number; an unset language; missing and blank names; an unknown and a missing stored variant; a missing order number and currency.
- 34 tests passed at `46dc872` and again, with the spec and the fixture unmodified, after the refactor.

**Checks.**

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | no errors |
| `npx eslint <touched files>` | no errors, no warnings |
| `npx prettier --check --end-of-line crlf <touched files>` | pass |
| `npm run log:check` | 0 violations |
| `npx jest` (run alone) | 220 suites, 5817 tests passed |
| `npm run test:core:platform-neutral` | 14 suites, 203 tests passed |
| `npm run test:acceptance:e04` | 1 suite, 6 tests passed |
| `npm run build` | exit 0 |

**Contract suites on PostgreSQL.** Each wrapper in `scripts/` started its own pinned `postgres:17-alpine` container and removed it. All 21 wrappers exited 0: 28 suites, 1023 tests.

| Wrapper | Tests passed |
| --- | --- |
| `test-template-identity-contract` (new) | 18 |
| `test-manual-order-ingestion-contract` | 15 |
| `test-order-imports-contract` | 60 |
| `test-order-import-release-gate-contract` | 21 |
| `test-order-api-contract` (3 suites) | 61 |
| `test-order-api-release-gate-contract` | 24 |
| `test-integration-api-keys-contract` | 11 |
| `test-easyorders-connection-contract` | 59 |
| `test-easyorders-ingestion-contract` | 58 |
| `test-easyorders-outcome-sync-contract` | 33 |
| `test-easyorders-release-gate-contract` | 29 |
| `test-woocommerce-connection-contract` | 168 |
| `test-woocommerce-ingestion-contract` | 85 |
| `test-woocommerce-outcome-sync-contract` | 68 |
| `test-woocommerce-release-gate-contract` | 103 |
| `test-shopify-contract` | 11 |
| `test-platform-boundary-migration-contract` | 4 |
| `test-source-identity-contract` | 1 |
| `test-standalone-provisioning-contract` | 10 |
| `test-verification-overview-contract` | 14 |
| `test-e045-contracts` (6 suites) | 170 |

**What the new tests cover, by acceptance criterion.**

| Criterion | Evidence |
| --- | --- |
| 1, 2 Identity and purpose on every new dispatch | Unit: `verification-send.template-identity.spec.ts` (first send, reminder, onboarding test and Settings test for Shopify, Standalone, EasyOrders and WooCommerce); `verification-message-dispatches.template-identity.spec.ts` (each claim path). Contract: a manual order, a bulk import release, an API order, a reminder and an onboarding test on Standalone; first send and reminder for plan-billed Shopify, EasyOrders and WooCommerce stores. |
| 3 Identity on the verification | Contract: the verification carries the accepted send's name and code in every case above, follows the reminder when the store changed style in between, and is `NULL` before any acceptance. |
| 4 Old rows | Contract: the header's rollback is run on a ledger with rows, a `legacy_unknown` row is added, `0053` is applied twice, and every row reads back unchanged with the new columns `NULL`. Unit: `dispatch-template-identity-migration.spec.ts`. |
| 5 Neutral selection, byte-identical payloads | `cod-template-selector.spec.ts` and the characterization spec. |
| 6 Metrics | Contract: mixed purposes, attribution with and without a reminder, a late reminder, two languages of one provider name, merchant-resolved outcomes, rows without identity, test orders, range boundaries, a second tenant and an empty range. Unit: policy, service, and the HTTP boundary (404 feature off, 401 no token, 403 non-staff, 400 bad range, 200 staff). |
| 7 Logs | `npm run log:check`; the added fields are identifiers only. |
| 8 Other sources unaffected | The existing unit and contract suites above. |
| An unknown-outcome send keeps its identity | Unit and contract: a failed provider call leaves an `outcome_unknown` row with its identity; a staff resolution then projects it. A confirmed rejection keeps it too. |

**Existing tests that were edited.**

- Seven contract schema setups gained one line each, applying `0053` after `0045`: the `release-gate`, `source-conformance`, `credit-usage` and `paymob-billing` harnesses and the `easyorders-ingestion`, `woocommerce-ingestion` and `woocommerce-outcome-sync` suites. Drizzle names every column on insert and select, so a ledger without the columns cannot be used. No assertion changed.
- `whatsapp.service.spec.ts`: its two direct calls to the adapter pass `template: selectCodTemplate(...)` in place of the removed parameters. The expected payloads are unchanged.
- `verification-send.service.spec.ts` and every source's own suite were not edited.

## Not run, and limits

- The `test:gate:e02` to `test:gate:e07` scripts were not run as scripts. The contract suites behind them were run one by one, as listed.
- `test:contract:entitlements` has no wrapper script and was not run. It does not touch the dispatch ledger.
- No frontend check was run: `akeed-frontend` is unchanged. Its admin store page already shows `template_name ?? 'Unknown'`.
- "Each source" is proven at the send service and the ledger, where every source converges. Each source's own webhook ingestion was not replayed with identity assertions; its existing suite proves it still sends.
- The harness's fake messaging port reports no template, so the Standalone contract cases prove the claim-time write. The adapter-reported path is proven by the plan-billed cases, one dedicated case, and the unit specs.
- No request was sent to Meta and no WhatsApp message was sent.

## Open items

1. US-08-01 is still Backlog and its record is a draft. This story is Done ahead of it.
2. Verifications created before this release keep `cod_verification` and `ar`. They cannot be told from real values by the column alone, and the admin store detail still shows them for old rows. Whether to show "not recorded" there instead is a question for US-08-05.
3. The frontend needs a translation for `ADMIN_TEMPLATE_METRICS_RANGE_INVALID` when US-08-05 builds the page.
4. If the ledger is large in production, create the `accepted_at` index `CONCURRENTLY` before deploying (see Data above).
