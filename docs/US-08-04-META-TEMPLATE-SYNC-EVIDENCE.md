# US-08-04 Meta sync, status webhooks and send guardrail evidence

**Validated:** 2026-10-05
**Revision:** backend `develop` at `2509d9c` (guardrail and migrations `c959e15`, sync, webhooks, alerts and health `08b90f0`, regression setup `2509d9c`); frontend `develop` at `d54770f`
**Decision:** implemented with every switch off. No customer-facing message changes. **Not marked Done:** the story waits for the product owner to confirm that the Meta app webhook fields below are subscribed. Migrations `0056` and `0057` have been applied to disposable test databases only; each environment applies them at its next boot.

Story: [US-08-04](Epics/08-whatsapp-template-management/US-08-04-meta-sync-status-webhooks-and-send-guardrail.md). Meta was not called. Everything this story knows about Meta comes from the [US-08-01 contract record](Epics/08-whatsapp-template-management/evidence/US-08-01-contract-record.md), which is still a draft: its DOCUMENTED findings (4.1, 4.2, 4.5, 4.8, 4.9), CODE findings and worst-case rules. Webhook tests use the step 1 fixtures in `test/fixtures/whatsapp-templates/webhooks/` unchanged.

## Decisions

Product owner, 2026-10-05, each as proposed:

| Open decision | Decision |
| --- | --- |
| 1 Sync cadence | Every 6 hours, plus on demand; webhooks are the primary signal. |
| 2 Alert channel | Per-store health signal plus a `buildBackendLog` alert line. No email. |
| 3 Before the first sync | Send as today: with the guardrail on and no sync yet, a row is sendable when it is active. |
| 4 Language default unavailable | Skip and record. Automation is not paused. |
| 5 Category change | Alert and keep sending (the record's worst-case rule for 4.5.13). |
| List-response shape (not in the record) | Strict worst case: `components` read only in the creation syntax, `quality_score` only as a documented string; anything else `unknown`. PROVISIONAL until the US-08-01 live run commits `template-list.json`. |
| Dispatch columns vs. "regression tests untouched" | Keep the two dispatch columns and add `0056` to the migration list of the suites that already apply `0053`, as US-08-02 did. No assertion changes. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| Where template webhooks are read | From the signed raw body, after the unchanged message handling. The global `ValidationPipe` (`whitelist: true`) strips `field`, `entry.id`, `entry.time` and every template member from the DTO, so the DTO could not carry them without changing the message path's input. `whatsapp.webhook.service.ts` and the DTO are not edited. |
| Webhooks while sync is off | Acknowledged and ignored, as before this story. Sync and webhooks share `WHATSAPP_TEMPLATE_SYNC_ENABLED`, because every webhook schedules a sync. |
| `message_template_components_update` | Not read. The sync detects changed text; the story names status, quality and category only. |
| Neutral values in the database | `review_status`, `category`, `quality` and `pending_category` hold neutral values (`approved`, `paused`, `utility`, `high`, …), never Meta's strings. The 0054 columns have no CHECK, so none was added. |
| Statuses with no documented meaning for sending | `FLAGGED`, `LOCKED`, `REINSTATED` and `UNARCHIVED` keep their own neutral value, none sendable, and every webhook schedules a sync (rules 4.2.11, 4.2.12). |
| Matching | By Meta name and language code with `-` and `_` read alike. The template ID is stored but never the only key; a webhook's ID is kept exact as a string above 2^53. |
| Event order | `entry[].time` per template and field. A sync raises all three event times to its own start. The same second with a different value is stored as `conflict` and settled by the scheduled sync. |
| A fully skipped first send | It was left `pending` with only a log line (US-08-03 code). `template_unavailable` is now a send-failure and retryable reason, so the verification becomes `failed` with that reason and the merchant can retry. This is the smallest change that makes the skip visible on the dashboard. |
| Which fallbacks the dispatch records | Every fallback except "the store has no stored choice": `key_unknown`, `key_inactive`, `wrong_language`, `not_approved`. Three US-08-02/03 assertions on the claim's exact `identity` gained the two new fields. |
| The registry reader | Selects only the columns it maps, which all exist since 0054, so it never depends on a later migration having run. |
| Migration split | `0056` is the two dispatch columns; `0057` is the registry columns and the two new tables. Regression suites that apply `0053` need only `0056`. |
| Manual sync | Runs inline (one page for Akeed's 8 templates). Answers 409 when sync is off, already running, or within 5 minutes of the last finished run. A run that ran and failed is a 201 whose run says `failed`. |
| Abandoned runs | A run still `running` after 15 minutes is closed as `abandoned` when the next one starts. |
| Alert scope | On a transition only, for a template in use (a language default, or sent by at least one active store). |
| Health signal | `template_unavailable` at two severities, like `onboarding_incomplete`: critical when no template can be sent for a language the store sends in, attention when a fallback stands in or the template sent was re-categorized. The admin frontend shows an unknown code title-cased, so it needs no change; US-08-05 owns the template UI. |
| Operator settings | `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED` and `WHATSAPP_TEMPLATE_OPERATOR_IDS`, the names US-08-06 gives, introduced here for the sync route. The session endpoint flag stays with US-08-06. |

## Implemented behavior

- **Port and adapter.** `TEMPLATE_CATALOG_PORT` (`src/shared/ports/template-catalog.port.ts`), neutral types in `src/shared/messaging/template-provider.types.ts`, `MetaTemplateCatalogAdapter` and `meta-template.mapping.ts` in the Meta spoke. Bound in `app.module.ts` next to `MESSAGING_PORT`.
- **Sync.** `WhatsappTemplateSyncService`, queue `whatsapp-template-sync` (producer, processor, 6-hour scheduler), `WhatsappTemplateSyncRepository`. Admin: `POST /api/admin/templates/sync` (operator) and `GET /api/admin/templates/sync/runs` (staff).
- **Webhooks.** `MetaTemplateWebhookHandler` (spoke) and `TemplateStatusService` with the pure rules in `template-sync.rules.ts`.
- **Guardrail.** `selectTemplateForSend` and `resolveTemplate` take the guardrail; `TemplateRegistryService.sendGuardrailEnabled()` reads the switch; the claim writes the fallback columns.
- **Alerts and health.** `TemplateAlertService`; `admin-template-health.sql.ts` and two columns in the admin store pipeline.
- **Config.** `whatsapp-template.config.ts`, validated in `validateEnv`. `WA_BUSINESS_ACCOUNT_ID` is required only when sync is on.
- **Data.** `0056_dispatch_template_fallback.sql`, `0057_whatsapp_template_sync.sql`, both additive and safe to replay, rollback in their headers. The 0057 rollback was run in the contract suite and reapplied.
- **Frontend.** `template_unavailable` is an explained dashboard reason in `en.json` and `ar.json`. The copy names no template text.

## Verification

All run on 2026-10-05 on Linux, in a cloud container.

**Environment limits, stated plainly.**

- The network policy denies `cdn.sheetjs.com`, so the `xlsx` package (backend dependency) could not be installed. Backend dependencies were installed without it. Every suite that imports `xlsx` fails to load. The same 10 unit suites (order imports and the order API HTTP spec) fail identically on `develop` before any change.
- Docker has no daemon here. Contract suites ran against a local **PostgreSQL 16** cluster on port 55432, not the pinned `postgres:17-alpine` image the PowerShell scripts start. The scripts themselves (`.ps1`) were not run.
- The frontend needed Linux native modules the lockfile does not carry (`@tailwindcss/oxide-linux-x64-gnu`, `lightningcss-linux-x64-gnu`, `@parcel/watcher-linux-x64-glibc`, `@swc/core-linux-x64-gnu`). They were installed into `node_modules` only; `package.json` and `package-lock.json` are unchanged.

**No customer-facing change.**

- `whatsapp-send-payload.characterization.spec.ts`: the 33 recorded cases pass, plus the same 33 with the guardrail on and every template synced as approved (criterion 8). `settings-template-block.characterization.spec.ts`: 14 pass. `git diff a0c630f -- test/fixtures/` is empty.

**Backend.**

| Check | Result |
| --- | --- |
| `npx jest` on `develop` before any change (`a0c630f`) | 226 suites: 216 pass, 10 fail to load `xlsx`; 5527 tests, 6 fail (the same suites) |
| `npx jest` after | 237 suites: 227 pass, the same 10 fail to load `xlsx`; 5769 tests, the same 6 fail |
| `npx tsc --noEmit -p tsconfig.json` | clean apart from the `xlsx` imports |
| `npx eslint <changed files>` (no `--fix`) | 0 problems |
| `npx prettier --check <changed files>` | clean |
| `npm run log:check` | 0 violations |
| `npm run test:core:platform-neutral` | 16 suites, 221 tests pass |
| `npm run test:acceptance:e04` | 6 tests pass |
| `npm run build` | fails only on the missing `xlsx` module |
| Nest dependency graph | With a stub `xlsx` (removed afterwards), `AppModule` boots its application context: the catalog port resolves to the Meta adapter, the guardrail switch reads through, the handler and the admin service are wired. |

Contract suites, one after another, against the local PostgreSQL:

| Suite | Before (`a0c630f`) | After |
| --- | --- | --- |
| `whatsapp-template-sync` (new) | — | 18 pass |
| `whatsapp-template-registry` | 28 pass | 28 pass |
| `shopify` (E01) | — | 11 pass |
| `manual-orders`, `standalone-provisioning`, `integration-keys`, `source-identity`, `entitlements`, `verification-overview` | — | 15, 10, 11, 1, 7, 14 pass |
| `easyorders-connection`, `-ingestion`, `-outcome-sync`, `-release-gate` (E06) | ingestion 58, release gate 29 pass | 59, 58, 33, 29 pass |
| `woocommerce-connection`, `-ingestion`, `-outcome-sync`, `-release-gate` (E07) | ingestion 85, outcome sync 68, release gate 103 pass | 168, 85, 68, 103 pass |
| `platform-boundary-migration` (E02) | — | 4 pass |
| `credit-foundation`, `credit-usage`, `paymob-checkout`, `billing-operations`, `billing-observability` (E04.5) | — | 40, 22, 29, 38, 31 pass |
| `order-imports`, `order-import-release-gate`, `order-api`, `order-api-release-gate`, `template-identity` | — | not runnable: they load `xlsx` |

The E06 and E07 ingestion, outcome-sync and release-gate suites failed before their setup gained `0056` (the dispatch relation selects the two new columns). With that one setup line they pass. In one full sequential run `easyorders-connection` had 9 failures while a frontend build ran alongside; alone it passes 59 of 59.

**Frontend.**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors; the same 4 unused-variable warnings in two dashboard files this story did not touch |
| `npx vitest run` | 105 files, 1294 tests, all pass |
| `npm run build` | exit 0 |

**Not run.**

- The PowerShell release gates and the `.ps1` contract wrappers.
- Anything against Meta: no sync, no webhook delivery, no send. The adapter, the webhook shapes and the event order are proven only against the contract record and its fixtures. US-08-08 proves them live.
- The migrations on a database with real data.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| 1 Port and adapter | `meta-template-catalog.adapter.spec.ts` (every status, category and quality value, an unknown value, pagination by cursor only, the page cap, rate limits 4, 80007 and 80008, permission and token errors, an error echoing the token with no token in any log line), `meta-template.mapping.spec.ts`. |
| 2 Sync | `whatsapp-template-sync.service.spec.ts` (fills every column, idempotent re-run, a Meta template with no row reported, a row Meta lacks marked `missing`, drift, re-categorization, single run, cooldown, switch off) and the contract suite. |
| 2 Failed sync | Same spec, "during a Meta outage": a 503, a dropped connection, a rate limit, an expired token, a rate limit mid-pagination with no further request, and a failed registry write. Each changes no row, records a failed run with a neutral code, and logs `template_sync_failed`. Contract: a 503 leaves every row byte-identical. |
| 3 Webhooks | `meta-template-webhook.handler.spec.ts` (all 21 fixtures, each field, unknown value, wrong account, large ID, `-`/`_` language, batched delivery, never throws), `template-status.service.spec.ts` (duplicate, out of order, per-field order, same-second conflict, older than the last sync, unregistered, alerts), `whatsapp.webhook.controller.spec.ts` (invalid and missing signature rejected by the real guard; signed status, quality and category deliveries routed through the global pipe; a messages delivery reaches the message service as before), and the contract suite. `whatsapp.webhook.service.spec.ts` is untouched and passes. |
| 4 Guardrail | `template-selector.spec.ts` (approved; paused with an approved default falls back as `not_approved`; every other status; both unavailable gives `default_unavailable`; never crosses language; switch off; never synced; re-categorized stays sendable), `verification-send.guardrail.spec.ts` (fallback recorded on the claim; default also unavailable skips before the claim, so no usage is reserved; paused mid-queue between first send and reminder, both with a fallback and a skip; switch off; never synced), `verification-hub.service.spec.ts` (`template_unavailable` marks the verification failed). |
| 5 Fresh environment | Never-synced cases in the selector and send specs; decision and switch in `docs/ENVIRONMENT.md`. |
| 6 Staff alerts | `template-status.service.spec.ts` asserts the whole alert line (no template text, no customer data), sync alerts in the sync spec; `admin-health-rule.service.spec.ts`; the contract suite runs the health SQL against stores: healthy, degraded, unavailable, a language the store never sends, the old variant column, a re-categorized template, store counts. |
| 7 Configuration | `whatsapp-template.config.spec.ts`, including `validateEnv` refusing sync without `WA_BUSINESS_ACCOUNT_ID`; docs updated. |
| 8 No customer-facing change | The characterization with the guardrail on. |
| Admin route and operator gating | `admin-templates.controller.spec.ts`: non-staff 403, unauthenticated 401, control tower off 404, non-operator and operations off 403 with stable codes, operator sync audited with counts only, refusals 409, run list for staff, route inventory. |

## Edits to existing tests

- **Migration `0056` added next to `0053`**, setup only: `test/contracts/credit-usage-harness.ts`, `paymob-billing-harness.ts`, `release-gate-harness.ts`, `source-conformance-harness.ts`, `test/easyorders-ingestion.contract-spec.ts`, `test/woocommerce-ingestion.contract-spec.ts`, `test/woocommerce-outcome-sync.contract-spec.ts`.
- **The claim's exact `identity`** in `verification-send.template-identity.spec.ts` (one case) and `verification-send.template-registry.spec.ts` (three cases) now includes `fallbackReason` and `skippedKey`.
- **Additions only:** `template_unavailable` in the `verification-hub.service.spec.ts` failure-reason cases; the new code in `admin-health-rule.service.spec.ts`'s known list, order arrays and counts; a second `describe` and a registry argument in the payload characterization.

## Meta app webhook fields

Subscribe, in **App Dashboard > WhatsApp > Configuration**, in the dev app and the prod app:

- `messages` (already subscribed)
- `message_template_status_update`
- `message_template_quality_update`
- `template_category_update`

The three template fields need `whatsapp_business_management`, and the app must be subscribed to the WhatsApp Business Account (`subscribed_apps`). `message_template_components_update` is not needed.

## Known limitations

- The list response's `components` and `quality_score` shapes are not in the contract record. Until the US-08-01 live run, a shape other than the documented creation syntax reads as `unknown`: no snapshot, no drift, no quality from sync. Status, which alone decides sending, is unaffected.
- The registry is cached for 60 seconds per process. Another instance can send a just-paused template for up to a minute; Meta's refusal (132015) is already a recorded rejection.
- The alert is a log line; nothing pages anyone (decision 2). A transition that happens while no store uses the template and no default is set does not alert.
- A manual sync that is refused while a webhook follow-up is running leaves the follow-up as the sync of record.
- The admin frontend shows the new health code title-cased in English ("Template Unavailable") until US-08-05.
