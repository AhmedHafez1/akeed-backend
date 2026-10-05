# US-08-03 Template registry and send-path cutover evidence

**Validated:** 2026-10-05
**Revision:** backend `develop` at `d386482` (settings baseline `dc4d789`, migrations and schema `a141a8d`, cutover `d386482`); frontend `develop`, one commit after `d386482` was verified
**Decision:** implemented locally, on `develop`, not pushed. There is no switch: no customer-facing message changes. Migrations `0054` and `0055` have been applied to disposable test databases only; each environment applies them at its next boot.

Story: [US-08-03](Epics/08-whatsapp-template-management/US-08-03-template-registry-and-send-path-cutover.md). Meta was not called. The only parts of the [US-08-01 contract record](Epics/08-whatsapp-template-management/evidence/US-08-01-contract-record.md) this story relies on are its CODE findings 4.6.6 and 4.7.6 (what Akeed sends today) and the worst-case rules 4.6.11 (the order of named values does not change) and 4.6.13 (the language code sent is the one registered). The record is still a draft and US-08-01 is still Backlog.

## What the code had, against the story and the step brief

- **The payload characterization already existed.** US-08-02 committed `whatsapp-send-payload.characterization.spec.ts` and its fixture at `46dc872`: 8 variants on the first send, the reminder and the test, plus `auto`, an unset language, a local number, missing and blank names, an unknown and a missing stored variant, and both parameter formats. It is the baseline of this story. Its fixture and its case list were not edited.
- **No baseline existed for what a merchant sees.** One was recorded before any change (`dc4d789`).
- **The contract record has no reconciliation table.** The step brief asked for the seed's status to come from it; the story (criterion 2) and the epic forbid Meta status in a migration. The product owner decided the seed carries none.
- **The frontend already rendered styles from the response.** What it hard-coded was two TypeScript unions and the label keys.

## Decisions

Product owner, 2026-10-05:

| Question | Decision |
| --- | --- |
| Review status in the seed | None. Status, category, quality and Meta ID stay NULL and come from each environment's sync (US-08-04). Until then a template is sendable when it is active in Akeed. |
| Stable key scheme (open decision 1) | `cod_confirm.<language>.<style>`. Decisions 2, 3 and 4 as proposed. |
| Frontend scope (the story says none, the brief says no hard-coded lists) | The two style unions become `string`; labels stay in next-intl, with the style id as the fallback. The `GET /api/settings` response is byte-identical, provider fields included. |
| The catalog file (the brief says remove, the story says keep) | Kept until the US-08-08 gate as seed source and baseline, with no runtime import. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| A store with no stored key | Read from its old variant column while that column exists, then the language default. A source created after `0055` starts with NULL keys, and its old columns hold the same defaults as before. Without this rule every existing spec fixture, which sets only the old columns, would have changed meaning. |
| Key columns | Nullable, with a foreign key to `whatsapp_templates(key)`. NULL means no choice, so a later change of default needs no data fix. A registry row a store references cannot be deleted; retiring a template is `is_active = false`. |
| Dual write | A settings write sets the key and the old variant column. A style the old CHECK does not allow (none exists yet) leaves the old column as it was. The rule ends with the migration that drops the old columns. |
| The dispatch ledger's variant key | Unchanged: `<language>.<style>`, for example `ar.egyptian`. The registry key is that with the `cod_confirm.` prefix, so US-08-02 metrics stay continuous. |
| What the port carries | `listTemplates()` and `invalidate()`. Selection, fallback and "what may a merchant choose" are pure functions over the rows, so they are tested without a database. |
| No default for a language | The send is skipped as `template_unavailable` before the claim. Settings and the onboarding test answer `503 SETTINGS_TEMPLATE_DEFAULT_UNAVAILABLE`. The seed and the CHECK `NOT is_default OR is_active` make this reachable only if staff remove a default without setting another. |
| Fallback logging | Logged for an unknown, inactive or wrong-language key. Not logged for a store with no stored choice: that is the normal state of a new source. |
| Cache | 60 seconds, per process. A failed refresh serves the last good copy; with no copy the error propagates like any other read before the claim. |
| The rejected-style error | The message is unchanged; the code `SETTINGS_TEMPLATE_STYLE_UNAVAILABLE` is new. The frontend offers only styles the response lists, so it has no translation for it yet. |
| `sort_order` | Added so the settings response keeps the catalog's order. Not in the story's column list. |
| Where the registry service lives | `src/modules/template-registry/`, bound in `app.module.ts` next to `MESSAGING_PORT`. No Meta call, so nothing in the Meta spoke yet. |

## Implemented behavior

- **Data.** `0054_whatsapp_templates_registry.sql` creates `whatsapp_templates` (service-role only, row security on) and seeds the 8 rows with `ON CONFLICT ("key") DO NOTHING`. The seed rows were generated from the catalog file, not typed. `0055_integration_template_keys.sql` adds `integrations.cod_template_ar_key` and `cod_template_en_key` and fills them from the old columns. Both are additive and safe to replay.
  - Rollback: deploy the previous release, which reads the catalog and the old columns. Then, optionally, drop the two columns and the table; the statements are in the migration headers. A previous release writes only the old columns, so before rolling forward again rerun the two backfill statements without their `IS NULL` condition.
- **Port and rules.** `TEMPLATE_REGISTRY_PORT` (`src/shared/ports/template-registry.port.ts`), neutral types in `template-registry.types.ts`, pure rules in `template-selector.ts`, `WhatsappTemplatesRepository`, and `TemplateRegistryService`.
- **Send.** `VerificationSendService` selects through the port. `WhatsAppService` builds body parameters from the registry's parameter format and variables; the buttons, the URL and the `Customer` / `Akeed Store` fallbacks are untouched.
- **Settings and onboarding test.** `OnboardingService.getTemplateSettings`, `OnboardingStateService.updateSettings` and `OnboardingTestService` read the registry. The DTO no longer lists style names.
- **Catalog.** `cod-template-catalog.ts` is unchanged. Runtime code does not import it.
- **Frontend.** `ArabicCodTemplateVariantId` and `EnglishCodTemplateVariantId` are `string`. Both Message tabs label a style through `templateStyleLabel`. No message key was added or changed.

## Verification

All run on 2026-10-05 on Windows. No dev server was running. Contract suites ran against disposable `postgres:17-alpine` containers, never the application database.

**No customer-facing change.**

- `whatsapp-send-payload.characterization.spec.ts`: 34 of 34 pass before any change and after the cutover. `git diff 6c45c12 -- test/fixtures/whatsapp-templates/send-payloads/baseline.json` is empty. The spec gained one line of wiring: the registry argument.
- `settings-template-block.characterization.spec.ts`: 14 of 14 pass on both sides. `git diff dc4d789 -- test/fixtures/whatsapp-templates/settings/baseline.json` is empty.

**Backend.**

| Check | Result |
| --- | --- |
| `npx jest` before any change | 221 suites, 5831 tests, all pass |
| `npx jest` after the cutover | 226 suites, 5899 tests, all pass |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint <touched files>` | 0 errors; 4 warnings, all on lines that existed before in `onboarding-state.service.spec.ts` |
| `npm run log:check` | 0 violations |
| `npm run test:core:platform-neutral` | 15 suites, 212 tests pass |
| `npm run test:acceptance:e04` | 6 tests pass |
| `npm run build` | exit 0 |
| `scripts/test-whatsapp-template-registry-contract.ps1` (new) | 28 tests pass |
| The 21 other `scripts/test-*contract*.ps1`, one after another | all exit 0 |

The 21 are: `e045` (six suites: 40, 10, 22, 29, 38, 31 tests), `easyorders-connection` 59, `easyorders-ingestion` 58, `easyorders-outcome-sync` 33, `easyorders-release-gate` 29, `integration-api-keys` 11, `manual-order-ingestion` 15, `order-api` 61, `order-api-release-gate` 24, `order-import-release-gate` 21, `order-imports` 60, `platform-boundary-migration` 4, `shopify` 11, `source-identity` 1, `standalone-provisioning` 10, `template-identity` 18, `verification-overview` 14, `woocommerce-connection` 168, `woocommerce-ingestion` 85, `woocommerce-outcome-sync` 68, `woocommerce-release-gate` 103.

**Frontend.**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors; 4 unused-variable warnings in two dashboard files this story did not touch |
| `npx vitest run` | 105 files, 1294 tests, all pass |
| `next build` into a throwaway `NEXT_DIST_DIR` | exit 0; `tsconfig.json` restored and the directory removed |

**Not run.**

- The PowerShell release gates (`npm run test:gate:e02` to `e07`). Their contract suites ran through the scripts above; the gate wrappers themselves did not.
- `npm run e2e:order-imports` (Playwright) and any check in a browser. The Message tab and the onboarding test were not looked at on a running app.
- The migrations on a database with real data. Before the first deploy, count the stores per old variant and compare with the keys after `0055`.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| 1 Registry table | `0054`; contract: constraints, one default per purpose and language, a default is active, row security. |
| 2 Seed | Contract: the rows read through the real repository equal the catalog by `JSON.stringify`; legacy names verbatim; no Meta data; rerun is a no-op and keeps a staff edit. |
| 3 Store settings | Contract: backfill for every old value, idempotent, old columns kept, foreign key. `onboarding-state.template-styles.spec.ts`: valid, unknown, inactive and wrong-language writes, and the dual write. |
| 4 Send path, onboarding test, settings | The two characterization specs; `verification-send.template-registry.spec.ts`. |
| 5 Byte-identical payloads | The payload characterization, fixture unchanged. |
| 6 Fallback for unknown stored values | `template-selector.spec.ts`, `verification-send.template-registry.spec.ts` (the log line and its reason), and the contract suite against real rows. |
| 7 Neutral types | Core and services import only the port and the neutral types. **Not met in full:** the settings response still carries `metaTemplateName` and `metaLanguageCode`, by decision, so the response does not change. |
| 8 Preview text | The `preview` column, seeded from the catalog; the settings characterization. |

## Wiring edits to existing tests

No assertion in an existing test was changed. These files changed only as listed.

- **The registry constructor argument** (`seededTemplateRegistry()`), added where a service is built by hand:
  - `src/infrastructure/spokes/meta/whatsapp-send-payload.characterization.spec.ts`, `whatsapp.service.spec.ts`
  - `src/infrastructure/spokes/woocommerce/woocommerce-setup.onboarding.spec.ts`
  - `src/modules/onboarding/`: `onboarding-setup.spec.ts`, `onboarding-state.service.spec.ts`, `onboarding.service.spec.ts`, `provider-neutral-settings.spec.ts`, `settings-template-block.characterization.spec.ts`, `source-setup.spec.ts`
  - `src/modules/verification-core/`: `provider-neutral-entitlement.spec.ts`, `verification-send.service.spec.ts`, `verification-send.template-identity.spec.ts`
  - `src/modules/verifications/onboarding-test.service.spec.ts`
  - `test/contracts/release-gate-harness.ts`, `test/contracts/source-conformance-harness.ts`
  - `test/easyorders-ingestion.contract-spec.ts`, `test/standalone-manual-mvp.acceptance-spec.ts`, `test/template-identity.contract-spec.ts`, `test/woocommerce-ingestion.contract-spec.ts`, `test/woocommerce-outcome-sync.contract-spec.ts`
- **Two nullable columns in a hand-written `integrations` table:** `test/easyorders-connection.contract-spec.ts`, `test/standalone-provisioning.contract-spec.ts`, `test/woocommerce-connection.contract-spec.ts`.
- **`whatsapp.service.spec.ts`** also gained a local `selectCodTemplate` helper over the new selector, because the function it imported is gone. Its expected payloads are unchanged.
- **`cod-template-selector.spec.ts`** kept its purpose cases. Its selection cases moved to `template-selector.spec.ts`, restated against registry keys and extended with the fallback reasons.

`0054` and `0055` were not added to the migration list in `test/order-imports.contract-spec.ts`. That suite's `integrations` table has no variant columns, which `0055` reads, and it does not list `0053` either. The new contract suite applies both migrations twice instead.

## Known limitations

- Nothing confirms the seeded names, codes and formats against Meta. US-08-01's reconciliation has not run; the code's current payload is the baseline, as the story states.
- A template is sent when it is active in Akeed. Meta's review status is not read until US-08-04.
- A change to the registry reaches other processes within 60 seconds, not at once. Nothing writes the registry yet.
- A store whose key column is NULL follows its old variant column, not a new default, until the old columns are dropped.
