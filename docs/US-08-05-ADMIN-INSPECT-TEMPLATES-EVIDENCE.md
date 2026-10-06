# US-08-05 Admin: inspect templates evidence

**Validated:** 2026-10-05 and 2026-10-06
**Revision:** backend `develop` at `a01e1e7` (list-response read and contract record `52138b2`, endpoints and test send `a01e1e7`); frontend `develop` at `cdd1cfb`
**Decision:** implemented. No migration and no customer-facing message change. The staff test send stays off until `WHATSAPP_TEMPLATE_TEST_PHONES` is set. **Not marked Done:** nobody has opened the pages against a real environment yet, and the story depends on [US-08-04](US-08-04-META-TEMPLATE-SYNC-EVIDENCE.md), which still waits for the Meta webhook subscription to be confirmed.

Story: [US-08-05](Epics/08-whatsapp-template-management/US-08-05-admin-inspect-templates.md). Meta was not called from this work. The product owner ran the US-08-01 read-only kit on the dev app on 2026-10-05; its output is now sections 3, 5 and 6 of the [contract record](Epics/08-whatsapp-template-management/evidence/US-08-01-contract-record.md) and the fixture `test/fixtures/whatsapp-templates/template-list.json`.

## Decisions

Product owner, 2026-10-05:

| Topic | Decision |
| --- | --- |
| Open decision 1, test phones | `WHATSAPP_TEMPLATE_TEST_PHONES`, an environment variable per environment. Empty means test sends are off. |
| Open decision 2, stores using a template | Store name, platform and a link to the admin store page. A Standalone source shows no address, as on the Stores page. |
| Open decision 3, default range | The last 30 days (the proposal). |
| Test send shape | As the story says, not as the step brief said: sent through the messaging port, with no order, verification or dispatch. So a staff test does not appear in template metrics. |
| Findings of the dev run | Record them as VERIFIED and read `quality_score.score`. Do not rename `en/direct`. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| Where Meta's placeholder syntax is read | In the Meta spoke (`meta-template-text.ts`). `TemplateCatalogPort` gained `describeComponents(snapshot)`, which returns text and parameter segments. The admin module, the drift rules and the renderer never parse `{{…}}` from Meta. |
| What counts as drift | A pure comparison (`src/shared/messaging/template-drift.ts`). **Send** differences: parameter format, the set of variables, and anything other than exactly two quick-reply buttons. **Preview** differences: the body text against the hand-kept preview (whitespace ignored) and the two button labels. A header or footer at Meta counts as a text difference, because the preview has none. |
| Language-code difference | Rows are matched to Meta by name and language code, so a different code shows as `missing`, not as its own kind. |
| A template Meta lacks | State `missing`. Akeed's own preview is shown in the phone, labelled as such. |
| `sendable` on the pages | Active and, once the environment has synced, approved, whether or not the guardrail switch is on. It shows what the guardrail would allow. |
| Test send strictness | The same rule as `sendable`: stricter than a store's send while the guardrail is off. |
| Test send limits | The onboarding test's constants (30 seconds, 5 per 24 hours), counted per staff member from `admin_access_audit` rows, plus a route throttle of 5 per minute. No new table. |
| Test send record | One audit row, `whatsapp-templates.test-send`, with `{ templateKey, purpose: 'test' }`. A refused or failed test writes none (the access guard still audits the request). |
| Sample values | Shared with the onboarding test (`TEST-1`, `250.00 USD`, `أحمد` / `Ahmed`), plus a sample store name (`متجر أكيد` / `Akeed Store`), since staff have no store. |
| Rates | Replies and confirmations divided by the sends WhatsApp accepted in the range, merchant tests excluded. A reminder is its own send, so a template with many reminders reads lower than "per order". |
| Filters | Applied in the browser: the registry has 8 rows. |
| Routes | `GET /api/admin/templates`, `GET /api/admin/templates/:key`, `POST /api/admin/templates/:key/test-send`. `GET /api/admin/templates/metrics` stays in `AdminController`, which is registered first; a test pins that. |
| Metrics per purpose | `findTemplateMetricsByPurpose` shares the `sent` and `credited` CTEs of `findTemplateMetrics`, whose output is unchanged. |
| Frontend error and header text | The pages do not use `AdminErrorPanel` or the header's "Last updated", because both hard-code English. |
| Commits | One backend feature commit instead of the two the plan named: the controller serves the reads and the test send together. |

## Implemented behavior

- **Contract record and list read (`52138b2`).** Sections 3, 5 and 6 of the record; the sanitized list fixture; `mapQuality` reads `{ score, date }`; `describeComponents` on the catalog port.
- **Backend (`a01e1e7`).** `AdminTemplateInspectionService` and `admin-template-view.ts` (list and detail), `AdminTemplateTestSendService`, `template-drift.ts`, `template-rendering.ts`, `template-text.types.ts`; repository reads `findAllForInspection`, `findForInspection`, `activeStoresUsingKey`, `eventsForTemplate`, `findTemplateMetricsByPurpose`, `latestAllowedAt`, `countAllowedSince`; `WHATSAPP_TEMPLATE_TEST_PHONES` in `whatsapp-template.config.ts`; seven new stable error codes in `WHATSAPP_TEMPLATE_ERROR_CODES`.
- **Frontend (`cdd1cfb`).** `TemplatesAdminPage`, `TemplateDetailAdminPage`, `TemplateAdminUi`, `useAdminTemplates`, `adminTemplatesApi`, `admin-templates.model`; routes `/[locale]/admin/templates` and `/[locale]/admin/templates/[key]`; a Templates entry in `AdminShell`; the `adminTemplates` namespace (208 keys) in `ar.json` and `en.json`.
- **Data.** None. No migration.

## Verification

All run on 2026-10-05 on the product owner's Windows machine, with Docker for the disposable PostgreSQL 17 containers.

**Baseline before any change (`91aad07`).** `npx jest`: 237 suites, 6141 tests, all pass. `npx tsc --noEmit -p tsconfig.json`: clean. `npm run log:check`: 0 violations. `scripts/test-whatsapp-template-sync-contract.ps1`: 18 pass. This is also the first full local run of US-08-04, whose own evidence could not load `xlsx`.

**No customer-facing change.** `whatsapp-send-payload.characterization.spec.ts` and `settings-template-block.characterization.spec.ts` pass untouched; `git diff 91aad07 -- test/fixtures/whatsapp-templates/send-payloads test/fixtures/whatsapp-templates/settings` is empty. The staff test send posts the recorded `<variant>/test` payload for all 8 templates, differing only in the recipient, the store name and the button ID.

**Backend, after.**

| Check | Result |
| --- | --- |
| `npx jest` | 244 suites, 6224 tests, all pass |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint <touched files>` (no `--fix`) | 0 problems |
| `npx prettier --check --end-of-line crlf <touched files>` | clean |
| `npm run log:check` | 0 violations |
| `npm run test:core:platform-neutral` | 16 suites, 221 tests pass |
| `scripts/test-whatsapp-template-sync-contract.ps1` | 22 pass (18 before, 4 new) |
| `scripts/test-template-identity-contract.ps1` | 19 pass (1 new) |
| `npm run test:gate:e07` | Did not pass as one run. See "Release gate" below. |

**Frontend, after.**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors; the same 4 unused-variable warnings in two dashboard files this story did not touch |
| `npx vitest run` | 109 files, 1342 tests, all pass (105 files and 1294 tests before) |
| `NEXT_DIST_DIR=.next-us0805 npx next build` | succeeded; the build's `tsconfig.json` edit was reverted and the folder removed |

**Not run.**

- The pages in a browser. They sit behind staff login, which was not entered.
- Anything against Meta from this work: no sync, no test send, no webhook.
- The prod app. The product owner reports it holds the same templates as dev.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| 1 List page | `TemplatesAdminPage.test.tsx`: every column in `en` and `ar`, RTL, filters by language, status and active flag, reset, date range, loading, empty and error states. `admin-template-inspection.service.spec.ts`: every row, store counts, never-synced. `admin-templates.model.test.ts`. |
| 1 Metrics | `admin-template-inspection.service.spec.ts` "takes each template metrics from the repository query": the rows of `findTemplateMetrics` map one to one by variant key, with unrecorded sends left out. Contract: `template-identity` "splits one template by purpose, adding up to its row". |
| 2 Detail page | `TemplateDetailAdminPage.test.tsx`: named Arabic template right to left on an English page, positional English template left to right on an Arabic page, variable mapping for both, per-purpose metrics, stores with links, status history. `template-rendering.spec.ts`, `meta-template-text.spec.ts`. Contract: stores by name with their total, and events newest first, against PostgreSQL. |
| 3 Drift | `template-drift.spec.ts`: equal, body differs, button label differs, button structure differs, format differs, variables differ, missing, unreadable, not synced. `meta-template-drift.fixture.spec.ts`: against the dev app's templates, 7 text differences and `en/direct` missing. Frontend: both severities and the missing notice, in both locales. |
| 4 Sync now | `TemplatesAdminPage.test.tsx`: result counts, the missing keys and the templates only Meta has; a failed run; a 409 by code; no button for non-operators or while sync is off. |
| 5 Test send | `admin-template-test-send.service.spec.ts`: listed phone, unlisted phone, empty list, unknown key, paused, missing and inactive templates, cooldown, daily limit, provider failure, an audit row and logs without the phone or the text, a new ID per send, the recorded payload for all 8 templates. `whatsapp.webhook.staff-test.spec.ts`: a button tap or a typed answer to a test finalizes nothing. |
| 6 Access control | `admin-templates.controller.spec.ts`: every route for unauthenticated (401), merchant owner, viewer and staff without MFA (403), control tower off (404); test send and sync for non-operators and with operations off (403 with codes); body validation; `templates/metrics` still routed; route inventory. No phone, token or account ID in a list response. |
| 7 Frontend conventions | `AdminShell`, `AdminUi` components and next-intl; `adminTemplates.messages.test.tsx`: the same keys in both locales, every backend code and every status translated, the Templates navigation entry in both locales. The render helper throws on a missing key. |

## Edits to existing tests

- `meta-template.mapping.spec.ts` and `meta-template-catalog.adapter.spec.ts`: one case each pinned the provisional rule that a `{ score }` object reads as `unknown`. Both now expect the verified shape to be read. Additions otherwise.
- `admin-templates.controller.spec.ts`: the module mounts `AdminController` too, the deny and 404 cases cover the new routes, and the route inventory lists them. No existing assertion was weakened.
- `test/whatsapp-template-sync.contract-spec.ts` and `test/template-identity.contract-spec.ts`: additions only.
- `whatsapp-template.config.spec.ts`: additions only.

## Rollback

Nothing customer-facing depends on this story. Unset `WHATSAPP_TEMPLATE_TEST_PHONES` to turn test sends off. To remove the pages, revert `cdd1cfb` (frontend) and `a01e1e7` (backend). `52138b2` can stay: it only makes the quality column real.

## Known limitations

- **`en/direct` is missing at Meta** under the name the code sends (contract record 5.2). The pages show it; nothing here fixes it. It needs a product decision.
- Before the environment's first sync every template reads "Not synced yet" and the phone shows Akeed's own preview.
- A staff test is not counted in template metrics and leaves no dispatch row.
- A failed test send is logged by `WhatsAppService` with the recipient's number, the plain-phone log issue the epic already lists as out of scope.
- A delivery receipt for a staff test names a message Akeed did not record; it is handled like any receipt for an unknown message.
- The store list on the detail page stops at 100 stores and says so.
- The admin Stores pages still show `template_unavailable` title-cased in English: they have no label map to extend and hard-code their text.
- The contract record is still a draft for prod, for webhooks and for the variant usage count.

## Release gate

`npm run test:gate:e07` inherits the E06, E05, E04, E03, E02 and E01/Shopify gates and the frontend checks. It was run once, on clean worktrees at the revisions above, and **exited 1**. Report: `.tmp/release-gates/e07-20261005T205059Z.json`.

- **Passed in that run:** all 10 of E07's own steps; all 11 of E06's own steps; 15 of E05's own steps (the E05 release-gate contract, the order API, key, manual-order, order-import, entitlement, Shopify and E04.5 credit and billing contracts among them) and its frontend reuse map; the E04 acceptance (6 tests) and manual-order contract (15); and, inside the E02 gate, the platform-neutral core, the Shopify adapter contract, the full backend regression (244 suites, 6224 tests), the migration rehearsal, the Shopify characterization, source identity, the backend build, the backend lint, and the frontend route types, typecheck and dual-mode fixture typecheck.
- **Failed in that run, both by the machine running out of memory:** the E02 gate's `frontend non-fixing lint` (ESLint died with `Fatal process out of memory: Zone` before printing a result) and the E05 gate's frontend unit suite (`FATAL ERROR: ... JavaScript heap out of memory`). Neither printed a lint error or a failing test.
- **Not reached in that run**, because the E02 gate stops at its first failure: the frontend isolated production build, and the E03 gate's own log check, tenant and role guard specs and Standalone provisioning contract.

A full rerun of the E06 gate was started and stopped at its third step at the product owner's request to finalize. Instead, each step that crashed or was not reached was run on its own on 2026-10-06, at the same revisions:

| Step | Result |
| --- | --- |
| Frontend `npm run lint` | 0 errors, the same 4 warnings |
| Frontend `npm run test` | 109 files, 1342 tests, all pass |
| Frontend isolated production build (`NEXT_DIST_DIR`) | compiled; both template routes built |
| E03 tenant and role guard specs | 6 suites, 107 tests pass |
| E03 log check | 0 violations (also a passing step of the E06 and E07 gates) |
| Standalone provisioning contract | passed as a step of the E06 gate in the same run |

So every check the gate contains has passed at these revisions, but **no single gate run is green**. A clean `npm run test:gate:e07` is still owed before the US-08-08 release gate.
