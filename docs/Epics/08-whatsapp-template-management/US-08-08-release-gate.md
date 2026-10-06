# US-08-08 — Release gate

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 8 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Quality gate
- **Status:** Automated gate passed (2026-10-06); live run, open US-08-01 items and the go/no-go decision pending
- **Dependencies:** [US-08-07](US-08-07-message-improvements.md)

## User story and value

As the product owner, I want automated proof, a live run in dev and prod, a support runbook and a go/no-go recommendation before template management is enabled for real traffic. Then a mistake in the one channel every confirmation depends on is caught before customers see it.

**Business value:** E08 touches every message Akeed sends. This gate shows that nothing changed while the switches are off, that the guardrail holds when Meta says no, and that support can recover without a developer.

## Scope

- Automated contract and regression suites, run in one gate command.
- A live run script for the product owner, dev first and then prod.
- A support runbook.
- Gate evidence.
- A go/no-go recommendation.

**Out of scope:**
- Turning on switches for merchants. That is the product owner's decision after go.
- New features.
- Fixing regressions in other epics, which reopen their own stories.

## Acceptance criteria

1. **Meta template fake.** A Meta template-API fake (`test/contracts/meta-template-provider-fake.ts`) is built only from the US-08-01 contract record and its fixtures. It supports list, create, edit, delete if allowed, rate-limit and error responses. Template webhook payloads are built from the same record.
2. **Contract tests.** Contract tests run against the fake for:
   - the port adapter (US-08-04);
   - sync;
   - submit and edit rules (US-08-06);
   - the free-form window rule (US-08-07b and c).

   Each test names the record finding it covers.
3. **No-behavior-change suite.** The characterization suite from US-08-02 and US-08-03 passes on the release candidate with every US-08-07 switch off. It covers all 8 variants on the first send, the reminder and the onboarding test, with `auto`, `ar` and `en`, and with names present and missing.
4. **Webhook replay and ordering.** These pass:
   - duplicate status, quality and category events;
   - out-of-order events (older after newer);
   - an unknown status value;
   - an invalid signature;
   - a template webhook interleaved with message replies and statuses, with both paths unaffected.
5. **Guardrail and fallback.** These pass:
   - selected approved;
   - selected paused, rejected, disabled, missing or re-categorized, which falls back to the default with a reason;
   - default unavailable, which skips with `template_unavailable` and releases usage;
   - never crossing language;
   - the reminder fallback (US-08-07a);
   - the `auto` style fallback (US-08-07d).
6. **Role and operator controls.**
   - Every `/api/admin/templates` route returns 404 or 403 for non-staff, with the control tower switch off and on.
   - Every write returns 403 for a staff non-operator and for anyone while `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false`.
   - Every write leaves exactly one audit row with no template text, token or phone number.
   - No DTO, log line or fixture contains a token or app secret. A test scans fixtures and captured logs.
7. **Regression gates.** These pass untouched on the release candidate:
   - E01: `npm run test:contract:shopify`;
   - E04: `test:gate:e04`;
   - E05: `test:gate:e05`;
   - E06: `test:gate:e06`;
   - E07: `test:gate:e07`;
   - backend lint (non-fixing), build and test;
   - frontend `npm run build`, `npm run lint`, `npx tsc --noEmit` and `npm run test`.
8. **Gate command.** A `test:gate:e08` script runs criteria 1 to 6 in one command, like the existing epic gates.
9. **Live run script.** `evidence/US-08-08-live-run-script.md` gives the product owner step-by-step checks, run in dev and then in prod, with an expected result and an evidence slot for each:
   1. Run the US-08-01 reconciliation, and compare it with the registry after sync.
   2. Check webhook subscription of the template fields.
   3. Submit a throwaway template.
   4. Follow its review to approved.
   5. Test-send it to a staff phone.
   6. Activate and deactivate it.
   7. Pause or edit-to-review a non-default template, where Meta allows it, and observe fallback and the staff alert.
   8. Retire it with a replacement.
   9. For each enabled US-08-07 item, send one real verification to a staff phone and confirm and cancel it.
10. **Runbook.** `evidence/US-08-08-template-support-runbook.md` covers:
    - a template paused, rejected, disabled or re-categorized: what the customer sees, what the store sees, how to choose and activate a replacement;
    - rollback to the code-seeded defaults (the US-08-03 seed): turn off the guardrail and US-08-07 switches, and reset defaults to the seeded rows;
    - pausing template writes (`WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false`);
    - stopping sync;
    - which logs and alert codes to read;
    - what never to do, such as editing a live template in WhatsApp Manager without updating the registry.
11. **Evidence.** Gate evidence is recorded in `docs/US-08-08-WHATSAPP-TEMPLATE-RELEASE-GATE-EVIDENCE.md` with:
    - commands, date, commits of both repositories and outcomes;
    - live-run results per environment;
    - known limitations;
    - a go/no-go recommendation per switch.

    The story status and the epic README table are updated.

## Open decisions (product owner)

1. **Rollout order.** The proposal is all of dev first, then prod. In prod, sync, then guardrail, then each US-08-07 item one at a time.
2. **Live run.** Who runs it with each environment's credentials? And may it use a real merchant store, or only a staff test store? The proposal is a staff test store.
3. **Measurement period and rollback trigger.** How long each US-08-07 item is measured before the next is enabled (proposal: 7 days). What rollback threshold applies, for example a confirmation-rate drop of more than X points versus the previous period.
4. **Retiring the legacy 8.** Whether retiring the legacy 8 variants or dropping the old `integrations` variant columns belongs to this gate or to a later cleanup. The proposal is later cleanup.

## Reconciled at the gate (2026-10-06)

Where this story and the code or the contract record disagreed. Details are in the [gate record](evidence/US-08-08-release-gate.md).

- **Criterion 1, file name.** The fake is `test/contracts/meta-template-api-fake.ts`, written by US-08-04. It was not renamed. A second fake, `meta-messages-fake.ts`, covers the `messages` edge.
- **Criterion 5, "re-categorized".** A re-categorized template does not fall back: Meta keeps it approved (record 4.5.5), so it stays sendable and staff are alerted (US-08-04 decision 5). The gate asserts that.
- **Criterion 6, "404 or 403 for non-staff".** A request with no token, or with a token Supabase does not know, gets 401 from the existing admin guard.
- **Criterion 6, "403 for a staff non-operator".** True while the environment lists at least one operator ID. Since `2fd3cc6` (2026-10-06) an empty `WHATSAPP_TEMPLATE_OPERATOR_IDS` lets every staff member write while operations are on.
- **Criterion 11, file location.** The record is `evidence/US-08-08-release-gate.md`; `docs/US-08-08-WHATSAPP-TEMPLATE-RELEASE-GATE-EVIDENCE.md` points to it.
- **Open decision 4.** The old variant columns and the code catalog were left in place. Both are still read; see section 6 of the record for the proposed two-release clean-up.
- **Data note.** The migration rehearsal on each environment's schema was not done by the gate; its counts are in the live run script.

## Implementation notes

- **Backend:**
  - The fake and its configuration follow the existing contract layout in [`test/contracts/`](../../../test/contracts), for example [`woocommerce-provider-fake.ts`](../../../test/contracts/woocommerce-provider-fake.ts).
  - Add `test/jest-e08-*.json` configurations and a `test:gate:e08` script, like `test:gate:e07`.
- **Frontend:** Include the US-08-05, US-08-06 and US-08-07g tests in the gate run.
- **Data:** Migration rehearsal on a copy of each environment's schema, with counts before and after for the registry seed and the integrations key fill.
- **Operations:** Link the runbook from [`docs/INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`](../../INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md) and [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md).

## Test requirements

Criteria 1 to 8 are automated. Criterion 9 is manual and dated. The gate fails if any automated suite fails, or if any live step blocks go without a recorded, accepted limitation.

## Migration and rollout

- No new migration.
- Go enables nothing by itself. Each switch is turned on by the product owner as the recommendation lists.
- **Rollback** follows the runbook.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The existing gates are `test:gate:e02` to `test:gate:e07` and `test:contract:shopify` (E01) in [`package.json`](../../../package.json).
- There is no Meta template fake or Meta contract configuration today.

**ASSUMPTION / REQUIRES VALIDATION:** that both Meta apps allow a throwaway template to be created and reviewed for the live run.

**EXTERNAL PLATFORM DEPENDENCY:** the live Meta apps (dev and prod) and their template review.
