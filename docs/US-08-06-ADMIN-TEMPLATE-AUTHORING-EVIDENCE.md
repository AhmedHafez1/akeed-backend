# US-08-06 Admin: create, edit, submit, activate, retire evidence

**Validated:** 2026-10-06
**Revision:** backend `develop` at `7342fc0`; frontend `develop` at `63e8c9d`
**Decision:** implemented, with `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED` off. No customer-facing message changed. **Not marked Done:** no template has been submitted to a real Meta account. The first real submission waits for the product owner to approve the dry run below, and the story's own rollout step (one full draft, submit, approve, activate and retire cycle on a throwaway template in dev) has not been run. Also, nobody has opened the new pages against a real environment yet. The inherited E01 to E07 release gates were not run to the end; the product owner moved them to the E08 gate.

Story: [US-08-06](Epics/08-whatsapp-template-management/US-08-06-admin-create-edit-submit-activate-retire.md). Meta was not called from this work: every create, edit and list in the tests reaches only the in-process fake `test/contracts/meta-template-api-fake.ts`.

## Decisions

Product owner, 2026-10-06:

| Topic | Decision |
| --- | --- |
| Open decision 1, naming | `akeed_<purpose>_<style>_v<n>`; the language is carried by Meta's language code. Legacy names are untouched. |
| Open decision 2, approval | One operator for every action, each audited. No four-eyes in software. |
| Open decision 3, promotion | The draft is re-entered in prod. Nothing is copied between environments. |
| Open decision 4, delete at Meta | Never. Retire is local only, and the port has no delete. |
| Open decision 5, variables | Limited to customer, store, order and total. |
| Purposes | `cod_confirmation` only. The "exactly Confirm then Cancel" rule is declared per purpose, so `cod_reminder` inherits it in US-08-07. |
| Edits | The contract record wins over criterion 5 as first written: no edit while in review (4.3.1), and no edit in place of a template that is active, a default or selected by a store (4.3.9). The story text is updated. |

Taken while building, for review:

| Topic | Decision |
| --- | --- |
| What was already there | US-08-04 shipped `WhatsappTemplateOperatorGuard`, both settings and the startup check. This story added a spec for the guard, put it on every new write route and added `template_operations` to `GET /api/admin/session`. |
| Where drafts live | A separate table, `whatsapp_template_drafts`. The registry row is inserted only once Meta has confirmed the template (a create answer, or adoption), inactive and never a default. So a draft is never `missing` in a sync and no send path can read one. |
| Idempotent submit | Local, not Meta's: only a `draft` can be claimed for a submit, under a row lock. A second submit at once answers `409 WHATSAPP_TEMPLATE_SUBMIT_IN_PROGRESS`; a submit of a submitted draft answers the stored result. |
| Reading before creating | Before every create the verified, unfiltered `listTemplates()` is read and matched on name and language. A template Meta already holds is adopted. This needs neither a duplicate-name error code nor the `name` filter, which the contract record does not specify. |
| Ambiguous outcome | No answer, a 5xx or a body without a Graph code is `unresolved`. The draft becomes `submit_unknown` and nothing is sent again until an operator runs "Check at Meta" (`POST /drafts/:id/reconcile`), which reads the list: found, the template is adopted; not found, the draft can be submitted again. A `submitting` claim older than 5 minutes reads as `submit_unknown`. |
| Never retried | A create and an edit are each sent once with a 15-second deadline (contract record 4.1 rule). |
| The body syntax | The operator writes Akeed's placeholders (`{{customer}}`); the provider parameter is the value's own name for a named template and its first-use position for a positional one. Meta's syntax is built in `meta-template-components.builder.ts`. |
| Category | Always the purpose's registered category (`utility`). `allow_category_change` is not sent, so Meta's default applies; the submit confirmation states the risk. |
| Versions | The next draft of a purpose, language and style gets the next `v<n>`. Purpose, language and style are fixed once a draft is saved. |
| Registry style and key | `<style>_v<n>` and `cod_confirm.<language>.<style>_v<n>`. The merchant label of a versioned style is the base style's label plus the version (`templateStyleLabel`). |
| Retire against deactivate | Deactivate is reversible. Retire sets `retired_at` and is permanent. Both need a replacement when a store selects the template or it is a language default. |
| "In use" | Any store whose language column resolves to the key, active or not, read the way a send reads it (`COALESCE(key, 'cod_confirm.<lang>.' \|\| variant)`). The dialog shows the total and how many are active. |
| Store move | The store's key is set to the replacement. The old variant column follows only when the replacement is one of its values (the dual-write rule of US-08-03), so its CHECK always holds. |
| A withdrawn default | The replacement becomes the default in the same transaction. |
| Concurrency | Every lifecycle write and every edit start locks all templates of the purpose and language, in key order, before deciding. Two default changes therefore run one after the other and never meet the unique index. Template webhooks lock in the same order. |
| Approval is required | Activate, set default and a replacement all need `review_status = 'approved'`, so an environment must have synced before any of them works. |
| Edit record | `whatsapp_template_edits`, written before the edit is sent. `applied` and `unknown` count against the limits; `refused` does not. |
| After an edit | The row is set to `pending` at once, and `status_event_at` raised, until a sync or a webhook says otherwise (record 4.3.8). |
| Editable templates | Only templates written in Akeed (they have a draft row). The eight seeded templates have no text in Akeed to edit. |
| Rejection reason | `rejected_reason` is read on the list and `reason` on the status webhook, mapped to neutral values and stored in `whatsapp_templates.rejection_reason`. |
| Audit | One `admin_access_audit` row per write, inserted in the write's own transaction. Metadata: template key, flags before and after, replacement key, moved-store count, Meta's reference. Never template text. A refused lifecycle action writes nothing (the access guard still audits the request). |
| Validation over HTTP | `POST /drafts/validate` is the one source of rules; the form shows its findings after a short pause in typing. It sits behind the operator guard like every write route. |
| Where the services live | In `src/modules/admin`, next to the test-send service, not in `modules/template-registry` as the plan first said: they throw HTTP exceptions with stable codes. |
| Dialogs | A template-specific confirmation dialog on the shared `Dialog`, not the billing one, whose text is in the billing namespace. |

## Implemented behavior

- **Migration `0058_whatsapp_template_authoring.sql`.** `whatsapp_template_drafts`, `whatsapp_template_edits`, and `retired_at` and `rejection_reason` on `whatsapp_templates`. Additive, safe to replay, writes no row, service-role only. Rollback is in its header.
- **Neutral layer.** `template-draft.types.ts`, `template-draft.validation.ts`, `template-lifecycle.policy.ts`, `template-legacy-variants.ts`; `createTemplate`, `editTemplate` and `TemplateSubmissionError` on `TEMPLATE_CATALOG_PORT`.
- **Meta spoke.** `meta-template-components.builder.ts`; create, edit, error mapping and `rejected_reason` in `meta-template-catalog.adapter.ts` and `meta-template.mapping.ts`; the webhook reads `reason`.
- **Repositories.** `whatsapp-template-drafts.repository.ts`, `whatsapp-template-lifecycle.repository.ts`.
- **Admin API.** `AdminTemplateAuthoringController`, `AdminTemplateDraftService`, `AdminTemplateLifecycleService`, `dto/admin-template-authoring.dto.ts`; 17 new stable codes in `WHATSAPP_TEMPLATE_ERROR_CODES`, none renamed.

| Route | Who |
| --- | --- |
| `GET /api/admin/templates/drafts`, `GET /drafts/:id`, `GET /:key/impact` | Any staff member |
| `POST /drafts/validate`, `POST /drafts`, `PATCH /drafts/:id`, `DELETE /drafts/:id` | Operator |
| `POST /drafts/:id/submit`, `POST /drafts/:id/reconcile`, `POST /:key/edit` | Operator; each calls Meta |
| `POST /:key/activate`, `/deactivate`, `/set-default`, `/retire` | Operator |

- **Frontend.** `TemplateDraftsPanel` on the templates list; `TemplateDraftEditorPage` and `TemplateDraftForm` (live phone preview, value picker, per-field findings, submit confirmation, review tracking, text edit); `TemplateActionsPanel` on the template page (activate, make default, deactivate, retire, each with a confirmation that states the stores affected); routes `/[locale]/admin/templates/drafts/new` and `/drafts/[id]`; 201 new keys in the `adminTemplates` namespace of `ar.json` and `en.json`.

## Acceptance criteria

| # | Covered by |
| --- | --- |
| 1 | `whatsapp-template-operator.guard.spec.ts` (switch off, non-operator, operator, startup failure); `admin-template-authoring.controller.spec.ts` (each of the 11 write routes: operator allowed, staff 403, switch off 403, non-staff 403; the session flag). |
| 2 | `admin-template-draft.service.spec.ts`; contract "keeps a draft out of the registry until the provider holds it". |
| 3 | `template-draft.validation.spec.ts`: one block per rule, valid and invalid, each naming its record finding. |
| 4 | `meta-template-catalog.adapter.write.spec.ts` (create, every 4.1.11 code, ambiguous outcomes, no retry, rejection reasons); draft service spec (stored ID, adoption, refusal, double submit); contract "follows review through sync and the status webhook". |
| 5 | `template-lifecycle.policy.spec.ts` (edit rules); `admin-template-lifecycle.service.spec.ts` (allowed, forbidden with the rule cited, re-review); contract "edit" block (24-hour and 30-day windows, one of two edits at once). |
| 6 | Policy spec; contract "activate and set default" (unapproved refused, atomic swap, audit row with flags before and after, concurrent default changes). |
| 7 | Contract "deactivate and retire" (refused without a replacement and nothing written; stores with a key, without a key and inactive all move; old variant column; default handed over). |
| 8 | `buildTemplateName` and the name rules in the validation spec; the characterization suites prove the legacy names are sent unchanged. |
| 9 | `TemplateDraftEditorPage.test.tsx`, `TemplateActionsPanel.test.tsx`, `admin-template-drafts.model.test.ts`, `adminTemplates.messages.test.tsx`. |
| 10 | The environment label and account suffix on the drafts panel, the editor and the submit confirmation (frontend tests). |

## Dry run of the first real submission

Not sent. `meta-template-catalog.adapter.write.spec.ts` builds this request with the real validation and the real adapter, against the fake, and compares it with `test/fixtures/whatsapp-templates/dry-run/first-submission.json`. The account ID and the token are placeholders; nothing else is changed.

```
POST https://graph.facebook.com/v24.0/<WA_BUSINESS_ACCOUNT_ID>/message_templates
Authorization: Bearer <WA_ACCESS_TOKEN>
(one attempt, 15-second deadline, no retry)
```

```json
{
  "name": "akeed_cod_confirm_throwaway_v1",
  "language": "en",
  "category": "UTILITY",
  "parameter_format": "NAMED",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{customer}},\n\nThis is a test of the order confirmation from {{store}}. Your cash on delivery order {{order}} comes to {{total}}.\n\nPlease confirm the order so we can ship it.",
      "example": {
        "body_text_named_params": [
          { "param_name": "customer", "example": "Ahmed" },
          { "param_name": "store", "example": "Akeed Store" },
          { "param_name": "order", "example": "TEST-1" },
          { "param_name": "total", "example": "250.00 USD" }
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Confirm order" },
        { "type": "QUICK_REPLY", "text": "Cancel order" }
      ]
    }
  ]
}
```

Before it, the same submit sends one `GET /{WABA_ID}/message_templates` to check Meta does not already hold the name. After it, the registry gets one row, `cod_confirm.en.throwaway_v1`, inactive and not a default, with the ID and review status Meta answers.

## Verification

All run on 2026-10-06 on the product owner's Windows machine, with Docker for the disposable PostgreSQL 17 containers.

| Check | Result |
| --- | --- |
| Backend `npx tsc --noEmit -p tsconfig.json` | No errors |
| Backend `npx eslint` on every touched file | No errors, no warnings |
| Backend `npx prettier --check --end-of-line crlf` on every touched file | Clean |
| Backend `npm run log:check` | 0 violations |
| Backend `npx jest` | 251 suites, 6,476 tests passed |
| Backend `npm run test:core:platform-neutral` | 16 suites, 221 tests passed |
| `scripts/test-whatsapp-template-authoring-contract.ps1` (new) | 30 tests passed |
| `scripts/test-whatsapp-template-sync-contract.ps1` | 22 tests passed |
| `scripts/test-whatsapp-template-registry-contract.ps1` | 28 tests passed |
| `scripts/test-template-identity-contract.ps1` | 19 tests passed |
| Backend build | `npx tsc -p tsconfig.build.json` into a scratch directory: compiled. `nest build` ran inside the gate below. |
| Frontend `npx tsc --noEmit` | No errors |
| Frontend `npm run lint` | 0 errors, the 4 unused-variable warnings that were already there |
| Frontend `npm run test` | 112 files, 1,390 tests passed |
| Frontend `next build` into a throwaway directory | Compiled; both new routes listed |
| `npm run test:gate:e07` (inherits E01 to E06) | **Not completed.** Started once and stopped on the product owner's instruction: the gates run at the end, with the E08 gate (US-08-08). Before it was stopped, every E07, E06, E04 and E03 step it had reached and the E05 backend steps had passed, with no failing suite in its log; it was inside the E05 frontend unit step. The E01 to E07 regression gates are therefore still owed for this story. |

**Characterization.** `whatsapp-send-payload.characterization.spec.ts` and `settings-template-block.characterization.spec.ts` pass with their baselines untouched: the Meta payload of every existing variant and language is byte-identical.

**Existing tests changed, and why.**

- `meta-template-catalog.adapter.spec.ts`: the list now asks for `rejected_reason`.
- `meta-template-webhook.handler.spec.ts`: a status event now carries the rejection reason.
- `admin-template-inspection.service.spec.ts`: its catalog fake gained the two new port methods.
- `whatsapp-template-sync.contract-spec.ts`: applies `0058`, because a status event writes `rejection_reason`.
- Frontend `TemplatesAdminPage.test.tsx` and `TemplateDetailAdminPage.test.tsx`: the two tests that pinned "no write control" now pin where the write controls are and that non-operators have none.

No Shopify, Standalone, EasyOrders or WooCommerce test was changed.

## Known limitations and what is left

- **No live proof.** Every Meta limit and shape used here is the contract record's, most of it DOCUMENTED, not VERIFIED. The record's gaps (what a duplicate name answers, whether the `name` filter is exact, the status between an edit and its re-approval, how soon a new template is listed) stay open until the US-08-08 live run. The design does not depend on the first two.
- **A check right after a lost answer.** If Meta lists a new template with a delay, "Check at Meta" can answer "not at Meta" for a template that exists. The next submit reads the list again before creating, so the worst case is one refused create, not a duplicate.
- **A new style has no merchant label.** A versioned seeded style reads "Egyptian 2"; a style nobody has named shows its slug in Settings until a label is added.
- **The registry cache is per instance.** An activate or retire reaches other instances within 60 seconds, as before.
- **Pages behind staff login.** Verified by component tests in both locales, not in a browser.
- **Operator guide.** The story asks for one in the runbook US-08-08 publishes; it is not written yet.

## Rollback

Set `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false`: every template write answers 403, and templates already approved and active keep sending. The schema can stay. To remove it, deploy the previous release and run the statements in the header of `0058`.
