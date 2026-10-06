# US-08-06 — Admin: create, edit, submit, activate, retire

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 6 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented (2026-10-06), switch off; the first real submission waits for the product owner to approve its dry run. Evidence: [US-08-06 evidence](../../US-08-06-ADMIN-TEMPLATE-AUTHORING-EVIDENCE.md)
- **Dependencies:** [US-08-05](US-08-05-admin-inspect-templates.md)

## User story and value

As a named template operator, I want to draft, validate, submit and follow a template through Meta review, then activate it, make it a default or retire it. I want each step to be a separate audited action. Then template changes no longer need a developer, a deploy or a hand edit in WhatsApp Manager.

**Business value:** this is the only way new copy reaches customers, including every US-08-07 text. It enforces a naming convention so the legacy naming problems (gap 7) stop growing.

## Scope

- Draft, local validation, submit, follow review, and edit within Meta's limits.
- Activate, deactivate, set default and retire.
- Operator gating and an audit trail.
- The admin UI for all of it.

**Out of scope:**
- Merchant-authored text.
- Media headers.
- Deleting a template at Meta unless open decision 4 allows it.
- Copying a template between environments automatically. Promotion to prod is a manual submit in prod.

## Acceptance criteria

1. **Operator allowlist.**
   - Every write goes under `/api/admin/templates` and needs `AdminAccessGuard` plus a method guard modeled on [`StandaloneBillingOperatorGuard`](../../../src/modules/admin/standalone-billing-operator.guard.ts). US-08-04 already shipped that guard (`WhatsappTemplateOperatorGuard`) and both settings; this story puts the guard on every new write route.
   - The settings are `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED` (default `false`) and `WHATSAPP_TEMPLATE_OPERATOR_IDS` (comma-separated staff UUIDs). With the switch enabled and no IDs, every staff member is an operator (changed 2026-10-06; startup used to fail).
   - A non-operator gets 403 with a stable error code.
   - The session endpoint tells the UI whether the user is an operator, so write controls can be hidden.
2. **Draft.** An operator creates a draft with:
   - purpose and language;
   - name, built from the naming convention in open decision 1;
   - body text with variables;
   - quick-reply buttons (labels; payloads stay `confirm_<id>` and `cancel_<id>` and are set at send time);
   - a variable mapping from neutral variable to Meta parameter, with a sample value for each;
   - category, as the contract record allows.

   Drafts live only in Akeed until they are submitted.
3. **Local validation.** Each rule from the US-08-01 contract record is checked before submit:
   - name format and uniqueness;
   - language code;
   - parameter format and numbering;
   - samples present;
   - button count and label length;
   - body length;
   - the mapping covers every variable;
   - the purpose's required buttons (Confirm and Cancel for COD purposes) are present.

   Each failure names the field and the rule.
4. **Submit and review.**
   - Submit sends the draft to Meta through the neutral port, gaining `createTemplate` (and `editTemplate`, plus `deleteTemplate` only if allowed). It stores the provider template ID and the review status.
   - Review progress arrives through the US-08-04 webhooks and sync. A rejection shows Meta's reason, mapped to a neutral message.
5. **Edits.** An edit follows the contract record, which is stricter than this criterion first read (decided 2026-10-06):
   - Only an approved, rejected or paused template can be edited (record 4.3.1). A template still in review cannot.
   - A template stores can send is never edited in place (record 4.3.9): it must be inactive, not a default and selected by no store. New text for a template in use is a new template, activated once it is approved.
   - An approved template gets one edit in 24 hours and ten in 30 days, in rolling windows counted by Akeed (record 4.3.2, 4.3.10). A rejected or paused template has no limit.
   - Only the text changes. The name, the language, the parameter format and the category of an approved template do not (record 4.3.5, 4.4.2, 4.4.7).
   - An edit the record forbids is refused locally with the rule cited. From the moment an edit is sent the template is not sendable until it is approved again, and staff are warned of this before they confirm.
6. **Separate audited actions.**
   - Activate, deactivate, set default and retire are separate actions.
   - Only an approved template can be activated or made default.
   - Set default swaps atomically within its purpose and language.
   - Every write is audited in `admin_access_audit`: action, actor, key, before and after flags, and request id. Template text is not stored in the audit metadata.
7. **No retiring a template in use.** Retiring or deactivating a template that a store selects, or that is a language default, is refused unless a replacement is named. The replacement must have the same purpose and language and be approved and active. Affected stores move to it in the same transaction, and the move is audited.
8. **Naming.** New templates must follow the naming convention, and the UI generates the name. The legacy names, including `_akeed_cod_verification_professional` and `akeed_cod_verification_direct_`, stay mapped and usable. The convention is never applied to them retroactively.
9. **UI.**
   - The admin UI adds a draft form with a live phone preview of the draft, the validation results, submit, and the review timeline.
   - Each action has a confirmation step that states its effect, for example "12 stores move to …".
   - All text uses next-intl in `ar` and `en`. Write controls are hidden for non-operators and still refused by the backend.
10. **Environments.** A template created in one environment exists only in that environment's WhatsApp Business Account. The UI states which environment it is in. Promotion to prod is a separate submit there, following open decision 3.

## Open decisions (product owner)

All decided on 2026-10-06.

1. **Naming convention.** **Decided:** `akeed_<purpose>_<style>_v<n>`, lowercase with underscores, for example `akeed_cod_confirm_egyptian_v1`, with the language carried by Meta's language code rather than in the name. The registry key of such a template is `cod_confirm.<language>.<style>_v<n>`.
2. **Approval.** **Decided:** one operator for every action, each one audited. A second approver is not enforced by software, as for billing operations.
3. **Dev to prod promotion.** **Decided:** (a) the operator re-enters the draft in prod. Nothing is copied between environments.
4. **Delete at Meta.** **Decided:** never. Retire is local only, and the provider port has no delete.
5. **Variable set.** **Decided:** yes, new templates are limited to customer, store, order and total.
6. **Purposes (raised by the step brief).** **Decided:** drafts are `cod_confirmation` only. The rule "exactly Confirm then Cancel" is declared per purpose, so `cod_reminder` inherits it when [US-08-07](US-08-07-message-improvements.md) adds that purpose.

## Implementation notes

- **Backend:**
  - Port methods sit beside `listTemplates` from US-08-04.
  - The Meta adapter maps the neutral draft to Meta's component JSON, which stays inside the spoke.
  - Validation rules live in one neutral module with values taken from the contract record. Each rule's test names the record finding it enforces.
  - Operator config goes next to [`standalone-billing-operations.config.ts`](../../../src/shared/config/standalone-billing-operations.config.ts).
- **Frontend:**
  - Extend the US-08-05 pages: a draft form, a review timeline and action dialogs, using the existing admin UI components and `shared/ui/whatsapp` for the preview.
  - Add keys to the `adminTemplates` namespace.
- **Data:**
  - A migration adds draft fields (or a drafts table), the provider template ID, and a review history if US-08-04 did not.
  - The integrations key references from US-08-03 are updated by the retire move.
  - Include a `_journal.json` entry and a rollback.
- **Operations:**
  - Document the two new variables in [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md).
  - Write a short operator guide in the runbook that US-08-08 publishes.

## Test requirements

- Guard tests:
  - switch off returns 403;
  - a non-operator returns 403;
  - an operator is allowed;
  - enabled with no IDs fails at startup.
- Validation: one test per contract-record rule, with valid and invalid cases.
- Meta fake:
  - submit with the stored ID;
  - rejection reason mapping;
  - an allowed edit, a forbidden edit, and an edit that triggers re-review (not sendable until approved);
  - a duplicate submit is idempotent.
- Lifecycle:
  - activate unapproved is refused;
  - set default swaps atomically;
  - retire in use without a replacement is refused;
  - retire with a replacement moves stores in one transaction;
  - each action writes one audit row with no template text.
- Frontend:
  - the form validates in `ar` and `en`;
  - controls are hidden for non-operators;
  - the confirmation dialog states the effect;
  - RTL rendering.
- All repository checks pass in both repos. The characterization suite and the E01, E04, E05, E06 and E07 regressions pass untouched.

## Migration and rollout

- Ship with `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false`.
- Enable it in dev for one operator and run one full draft → submit → approve → activate → retire cycle on a throwaway template before prod.
- **Rollback:** turn off the switch. Templates already approved and active keep working, and the code-seeded defaults remain valid.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The operator gating pattern is `STANDALONE_BILLING_OPERATIONS_ENABLED` and `STANDALONE_BILLING_OPERATOR_IDS`, enforced by `StandaloneBillingOperatorGuard` after `AdminAccessGuard` ([`standalone-billing-operator.guard.ts`](../../../src/modules/admin/standalone-billing-operator.guard.ts)).
- Staff audit goes to `admin_access_audit` ([`schema.ts`](../../../src/infrastructure/database/schema.ts)).
- Button payloads are `confirm_<verificationId>` and `cancel_<verificationId>`, parsed by [`customer-reply-intent.ts`](../../../src/shared/verification/customer-reply-intent.ts).

**ASSUMPTION / REQUIRES VALIDATION:** every Meta limit, field and status used here comes from the US-08-01 record.

**EXTERNAL PLATFORM DEPENDENCY:** Meta template management API (create, edit and possibly delete), proven live in US-08-08.
