# US-08-08 — Release gate record

- **Story:** [US-08-08 — Release gate](../US-08-08-release-gate.md)
- **Date:** 2026-10-06
- **Release candidate:** `akeed-backend` `develop` at `08c8067`; `akeed-frontend` `develop` at `e4af8ea`. The commit that carries this record adds documents, two fields to the gate report and one tightened fixture check (section 1, run 7).
- **Machine:** the developer laptop (Windows 11, Docker Desktop, 16 GB). No dev server was running.
- **Meta:** no step called Meta or sent a WhatsApp message. Both Meta edges are in-process fakes built from the [US-08-01 contract record](US-08-01-contract-record.md).
- **Live run:** not done. It is the product owner's, with the [live run script](US-08-08-live-run-script.md).

## Verdict in one line

**The automated gate passes on the release candidate (run 6). The recommendation is: go to deploy it with every switch off and to start the dev live run; no-go for turning any switch on in prod until the live run is done and the open US-08-01 items are closed or accepted.**

The decision is the product owner's. Section 9 gives the recommendation per switch.

## 1. What was run, and what happened

Every result below was observed on 2026-10-06. Nothing is carried over from an earlier day.

| # | Command | On | Result |
| --- | --- | --- | --- |
| 1 | `npx tsc --noEmit -p tsconfig.json`, then `npx jest --silent` (backend, alone) | `34d98c0` | Type check clean. 264 suites, 6,639 tests passed. |
| 2 | `npm run test:gate:e07` (E07, E06, E05, E04, E03, E02, E01/Shopify, frontend) | backend `34d98c0`, frontend `e4af8ea` | **Exit 1.** One step failed: E05 "manual, file-import, API and key channels", on `parse-import-file.timing.spec.ts` ("parses a 5,000 × 20 XLSX in under 1 s": 1,297 ms). Every other step of E07, E06, E05, E04, E03 and E02 passed, the frontend lint, unit suite (115 files) and production build included. |
| 3 | `npm run test:gate:e08 -- -OwnOnly` (criteria 1 to 6 only) | the working tree that became `5cbaedd` | **Exit 1.** 15 of 16 steps passed. "template sync and status webhook contract" did not start: Jest could not open a source file (`UNKNOWN: unknown error, realpath ...meta-template-catalog.adapter.ts`), a Windows file error, with 0 tests run. |
| 4 | `scripts/test-whatsapp-template-sync-contract.ps1` (the step that did not start in run 3, alone) | same tree | Passed, 22 tests. |
| 5 | `npm run test:gate:e08` (criteria 1 to 7, one command) | started on backend `5cbaedd`; the product owner committed `2fd3cc6` nine minutes into the run | Exit 0, all 17 steps passed. **Not counted:** the tree changed while it ran, so its steps did not all see the same code. |
| 6 | `npm run test:gate:e08` | backend `08c8067`, frontend `e4af8ea`, both working trees clean before and after | **Exit 0. All 17 steps passed**, the inherited E07 gate among them, with its own 11 steps, E06's 12 and E05's 18 all `PASS` (E04, E03, E02 and E01/Shopify inside them). Full backend regression: 6,640 tests. Frontend unit suite: 115 files. 09:05 to 09:21 UTC. |
| 7 | `npm run test:gate:e08 -- -OwnOnly` | the tree of the commit that carries this record | Exit 0. All 16 own steps passed; the inherited gate was not run again. Report `e08-20261006T092432Z.json`. |

**Reading these honestly.**

- The timing failure in run 2 is a wall-clock limit in an E04.6 parser spec. E08 changed nothing under `src/modules/order-imports`. The same spec passed in run 1 and in the E02 "full backend regression" step of run 2 itself. It is known to miss its limit when the machine is busy. It is still a failed step: run 2 was **not green**.
- The failure in run 3 is not a test result: no test ran. Run 4 shows the suite passes. Run 3 was **not green** either.
- **Two changes arrived from outside this work while it ran**, both now in the product owner's commit `2fd3cc6`. An edit to `drizzle/0060_whatsapp_service_messages.sql` (two guarded statements that repair a foreign key on a database that applied an early draft of `0028`) appeared in the working tree during run 2, which is why that run's report says `backendWorktreeChangedByGate: true`. The commit itself landed during run 5 and also changes the operator rule: with operations on and no operator ID listed, every staff member may write (section 3). Run 6 is the only run in which the whole release candidate, those two changes included, was tested from a clean tree.
- Run 6 is green in one run. Runs 2, 3 and 5 are recorded because they happened.
- Run 5's report names `2fd3cc6` as its commit although it started on `5cbaedd`: the script read the commit at the end. Found in review and fixed in the commit that carries this record; the report now reads the commits before the first step and says whether they moved (`backendCommitChangedDuringGate`).

Gate reports (step names and outcomes, gitignored), in `akeed-backend/.tmp/release-gates/`: run 2 `e07-20261006T075228Z.json`, run 3 `e08-20261006T082656Z.json`, run 5 `e08-20261006T083549Z.json`, **run 6 `e08-20261006T090515Z.json`**.

## 2. Results per acceptance criterion

| AC | Result | Evidence |
| --- | --- | --- |
| 1. Meta template fake | **Met, with a naming difference** | The fake is [`test/contracts/meta-template-api-fake.ts`](../../../../test/contracts/meta-template-api-fake.ts), written in US-08-04 and US-08-06; the story names `meta-template-provider-fake.ts`. It was not renamed, to leave five suites untouched. It supports list, create, edit, rate-limit and error answers, and has no delete because the port has none (record 4.1.5, 4.4.3 rule). A second fake, [`meta-messages-fake.ts`](../../../../test/contracts/meta-messages-fake.ts), covers the `messages` edge and the service window (4.10). `meta-contract.gate-spec.ts` checks both against the record, and checks that all 21 committed webhook payloads are the documented shape of a documented field, one for each of the 14 documented status events. |
| 2. Contract tests against the fake | **Met** | `test/e08-release-gate/meta-contract.gate-spec.ts` (48 tests), each titled with the record finding it covers: adapter (4.1.1, 1.4, 3.2, 3.3, 4.1.3, 4.1.4, 4.1.10, 4.2.2, 4.9.4), sync (4.2.1 and its rule, 5.2, 5.3, 4.9.5), submit and edit rules (4.1 rule, 4.3.1, 4.3.2, 4.3.9, 4.3.10), free-form window (4.10.1 to 4.10.4, 4.10.8). The per-story suites run in the same gate: Meta spoke (312 tests), registry and rules (510), authoring contract (30). |
| 3. No-behavior-change suite | **Met** | `whatsapp-send-payload.characterization.spec.ts` and `settings-template-block.characterization.spec.ts`, 82 tests, with every `WHATSAPP_*` switch cleared from the gate's environment: all 8 variants on the first send, the reminder and the test, `auto`, `ar` and `en`, names present and missing, compared with `JSON.stringify` against the baseline recorded before the epic. Also run with the guardrail on and every template approved. |
| 4. Webhook replay and ordering | **Met** | `webhook-matrix.gate-spec.ts` (19 tests) over HTTP with the real signature guard, template handler, event rules and message service: duplicate status, quality and category events; older after newer; same second with a different value; an undocumented status; `FLAGGED`, `LOCKED`, `REINSTATED`; three kinds of bad signature and a missing one; a template event in one delivery with a button reply and a delivery receipt, each path compared with itself alone; a registry failure; another account's event. PostgreSQL side: `whatsapp-template-sync` contract (22). |
| 5. Guardrail and fallback | **Met, with one difference from the story's wording** | `guardrail-matrix.gate-spec.ts` (53 tests, every registry status) and `whatsapp-template-release-gate.contract-spec.ts` (17 tests on PostgreSQL, section 4). **Difference:** the story lists "re-categorized" among the cases that fall back. The code keeps a re-categorized template sendable and alerts staff. That is what the contract record says (4.5.5: Meta keeps it approved; the rule under 4.5.13) and what US-08-04 decision 5 chose. The gate asserts the record's behavior. The story's sentence should be corrected; no code change is proposed. |
| 6. Role and operator controls | **Met** | `access-controls.gate-spec.ts` (283 tests), section 3. Audit rows: `whatsapp-template-authoring` contract ("one audit row per write, none with template text"), `whatsapp-message-improvements` contract, `admin-templates.controller.spec.ts` (sync) and `admin-template-test-send.service.spec.ts` (no phone, no text). |
| 7. Regression gates | **Met in run 6.** Not green in run 2 | Section 1. E01 (`npm run test:contract:shopify`, inside the E05 gate), E04, E05, E06 and E07 gates; backend non-fixing lint, build and full test; frontend build, lint, type check and unit suite. All passed in run 6, with no file of an earlier epic changed. |
| 8. Gate command | **Met** | `npm run test:gate:e08` ([`scripts/test-e08-release-gate.ps1`](../../../../scripts/test-e08-release-gate.ps1)). It runs criteria 1 to 6 and then the inherited E07 gate. `-- -OwnOnly` skips the inherited gate and writes that in its report. |
| 9. Live run script | **Written, not run** | [US-08-08-live-run-script.md](US-08-08-live-run-script.md). |
| 10. Runbook | **Written** | [US-08-08-template-support-runbook.md](US-08-08-template-support-runbook.md), linked from `INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md` and `ENVIRONMENT.md`. Summary in section 7. |
| 11. Evidence | **Partly met** | This file. Live-run results per environment are empty (section 10). The story names `docs/US-08-08-WHATSAPP-TEMPLATE-RELEASE-GATE-EVIDENCE.md`; that file points here. |

**From the story's implementation notes, not done:** the migration rehearsal on a copy of each environment's schema, with counts before and after for the registry seed and the key fill. It needs each environment's database, which this gate did not touch. The counts to take are in the live run script's "Before you start".

## 3. Controls

All of this is asserted by `access-controls.gate-spec.ts`. The routes are read from the controllers by reflection, so a route added later joins the matrix by itself. The staff token check, `AdminAccessGuard` and `WhatsappTemplateOperatorGuard` are the real classes; only Supabase's answer to "whose token is this" is a stand-in.

**Routes covered: 22.** 14 writes and 8 reads, under `/api/admin/templates` and `/api/admin/message-texts`.

| Who | Reads | Writes |
| --- | --- | --- |
| No token | 401 | 401 |
| Merchant owner (Supabase user, not staff) | 403 | 403 |
| Merchant viewer | 403 | 403 |
| Merchant in the embedded Shopify app (Shopify session token) | 403 | 403 |
| Staff without the second factor, where it is required | 403 | 403 |
| A token Supabase does not know | 401 | 401 |
| Staff, not a named operator | 200 | 403 `WHATSAPP_TEMPLATE_OPERATOR_REQUIRED` |
| Named operator, `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false` | 200 | 403 `WHATSAPP_TEMPLATE_OPERATIONS_DISABLED` |
| **Any staff member, operations on and no operator ID listed** | 200 | **2xx** (rule of 2026-10-06, `2fd3cc6`) |
| Any staff member, operations off and no operator ID listed | 200 | 403 `WHATSAPP_TEMPLATE_OPERATIONS_DISABLED` |
| An operator ID that is not on this environment's list | 200 | 403 |
| Named operator | 200 | 2xx |
| Anyone, control tower off | 404 | 404 |

- No service behind a route was reached on any refusal.
- **A merchant, a viewer and a non-staff user reach no template write in any configuration.** An "admin without operator rights" is refused whenever the environment lists at least one operator ID. With an **empty** list, which is the default, there is no such thing as a non-operator: every staff member writes. That is the product owner's rule since `2fd3cc6`; the gate asserts it as written. It differs from the epic rule ("plus an operator allowlist") and from criterion 6 as the story words it, and it has one sharp edge: removing the last ID from the list opens writes to all staff instead of closing them. The runbook says so. **Recommendation: list the operators explicitly in prod.**
- Every route has the staff guard, first. Every route that is not a `GET` has the operator guard. No `GET` has it.
- There is no route that deletes a template at Meta.
- **Secrets.** After every one of the 283 cases, the captured log lines and the response headers and bodies are searched for each session token used and for three configured secrets (app secret, access token, service-role key): none found. The three other gate suites search their captured logs for the fakes' tokens after every test, although the fakes' error messages echo them: none found, after the fix in section 5. All 25 files under `test/fixtures/whatsapp-templates` are scanned for an access token, an `access_token` parameter, a bearer value, an app secret, a signature and a JSON web token: none found. Every number of 12 digits or more in them is one of the synthetic account ID, template IDs or phone.

The story says "404 or 403 for non-staff". A request with no token, or with one Supabase does not know, gets 401. That is the existing admin guard's behavior and is not changed.

## 4. Guardrail, end to end

`whatsapp-template-release-gate.contract-spec.ts` runs on PostgreSQL with the real sync, registry, send service, dispatch ledger and usage accounting. A template's status is changed at the template fake; the real sync writes it; what reaches the `messages` fake is what a customer would receive.

| Case | Sent to the customer | Recorded | Usage |
| --- | --- | --- | --- |
| Chosen template approved (Standalone and Shopify) | The chosen template | Dispatch with its identity, no fallback reason | One |
| Chosen template `PAUSED`, `DISABLED` or `REJECTED` | The language default. The chosen one never. | `template_fallback_reason = not_approved`, `template_skipped_key` = the chosen key | One |
| Chosen template and the default both `PAUSED`, `DISABLED` or `REJECTED` (Standalone and Shopify) | **Nothing** | Outcome `skipped` / `template_unavailable`, a log line with the verification, **no dispatch row** | **None.** Usage, credit ledger and credit account rows are identical before and after |
| Chosen template no longer listed by Meta | The default | `missing`, then `not_approved` on the dispatch | One |
| Chosen template switched off in Akeed, approved at Meta | The default | `key_inactive` | One |
| Every Arabic template paused, English approved | Nothing in Arabic; the English order is sent in English | Skip as above | None for the Arabic order |
| Template paused after the first send | The reminder carries the default | `not_approved` on the reminder's dispatch | One |
| Template and default down after the first send | No reminder | Skip; still one dispatch row for the verification | None for the reminder |
| Approved again | The chosen template again | No fallback reason | One |
| Guardrail switch off | The chosen template, whatever Meta says | — | One |

Where the skip is written on the verification itself (`failed` with the reason, or `follow_up_skipped`) is asserted by `verification-hub.service.spec.ts` and the automation specs, in the gate's unit steps. It is not asserted on PostgreSQL in one flow with the rows above.

## 5. Defects found

| # | Defect | Fix |
| --- | --- | --- |
| 1 | `WhatsAppService` logged, and put into the error it threw, the provider's error message exactly as it came (`context`, `errorMessage`, `stack`). An error that quoted the request would have written the access token to the log. Found by pointing the new `messages` fake, whose errors echo the token like the template fake's do, at the real send. Real Meta errors are not known to quote the token; this is the same worst case the template adapter was already built for. | Fixed in `5cbaedd`: the token and its URL-encoded form are removed from the context, the message and the stack before they are logged or thrown, for template and text sends. No payload changes: the characterization suite passes. |

Found and **not** fixed, because they are outside this gate:

- A failed template send still logs the customer's phone (`to`). The epic README lists it as a known issue tracked separately.
- `parse-import-file.timing.spec.ts` (E04.6) fails its 1-second limit on a busy machine. It belongs to E04.6.

Found by the code review of this story's own diff, and fixed in the commit that carries this record:

- The gate report named the commit read at the end of the run (section 1).
- The fixture check for real account identifiers matched only an ID followed by a `time` member, so it checked nothing in four fixture files. It now checks every long number in every fixture.

## 6. Old variant columns and the code catalog: left in place

Step 5 of the gate brief was to remove them only if every check was green. The final run (run 6) is green. They were still **not** removed, and this is a decision the product owner may overrule. The reasons:

1. **The gate was green only at the fourth attempt.** Runs 2 and 3 each had a failed step and run 5 straddled a commit (section 1). None of that is an E08 defect, but it is not the footing to start a change to every send from.
2. **The columns are not dead.** A source created after migration `0055` starts with no key, and the send path, Settings, the merchant test, the health SQL and the retire-with-replacement move all read its old variant column instead (`storedTemplateKey` in `template-selector.ts`, `STORE_AR_KEY` / `STORE_EN_KEY` in `whatsapp-template-sync.repository.ts`). Dropping the columns first needs a backfill of keys and a change to how a new source gets its default. That is a change to every send, made after the gate that is supposed to describe the release.
3. **The catalog is not dead.** `scripts/spikes/whatsapp-templates/reconcile.mjs` imports it, and step 1 of the live run uses that script. The prod reconciliation is still open. The specs' seeded registry is also built from it.
4. **Dropping the columns in this release would break a rolling deploy and the rollback.** The running release names both columns in every `integrations` query. A migration that drops them at boot fails those queries until every instance is replaced, and it ends the "redeploy the previous release" rollback that `0055` kept the dual write for. The live run has not happened yet.

**Proposed, as its own change after go:** (a) a release that backfills keys, gives new sources a key, and stops reading and writing the two columns, with the characterization suite's store inputs moved to keys and the gate run again; (b) one release later, migration `0061` drops the columns and their two CHECKs. The catalog file can go once `reconcile.mjs` reads the registry seed instead, after the prod reconciliation. Rollback of (b): `ALTER TABLE integrations ADD COLUMN ...` and refill from the keys.

## 7. Support runbook

The full text is [US-08-08-template-support-runbook.md](US-08-08-template-support-runbook.md). In short:

- **A template is paused or rejected.** With the guardrail on, stores that chose it send the language default and the dispatch says `not_approved`. If the default is down too, nothing is sent, no usage is taken and the store sees a failed verification that can be retried. A pause ends by itself (3 hours, then 6); a third one disables the template. A rejected or disabled template is replaced: activate an approved template of the same language, then retire the broken one with it as the replacement, which moves every store in one step.
- **Fall back to the seeded defaults.** Turn off `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` and the seven US-08-07 switches and restart. That alone restores the sending the characterization suite pins. Only if the default flags themselves were moved: **Make default** on `cod_confirm.ar.standard` and `cod_confirm.en.friendly`, or the one reset statement in the runbook, on the product owner's word.
- **Pause template writes without touching sends.** `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=false` and restart. Every write, Sync now and staff test send answers 403 for everyone. Sends, the scheduled sync and the webhooks carry on.
- **Stop the sync.** `WHATSAPP_TEMPLATE_SYNC_ENABLED=false`. With the guardrail still on, sends keep following the last snapshot, which goes stale: turn the guardrail off too if the sync stays off for more than a few hours.
- **Never** edit or delete a live template in WhatsApp Manager, swap its buttons, or copy an ID or status between environments.

## 8. Open US-08-01 unknowns

The record is still a **draft** with no verdict. By the rule of this gate, **any open item blocks release**. Each has a worst-case rule the code follows and a test, so none blocks *deploying* the release candidate with every switch off; they block *turning switches on*.

**Not yet observed or decided:**

| Item | What is open | Closed by |
| --- | --- | --- |
| Record state | Draft; "verdict in one line: not given yet" | US-08-01 closing |
| 3.5 | The prod app's templates were reported, not read. The report was wrong for `en` / `direct` (record 5.5) | Live run step 1 on prod |
| 5.2 | `en` / `direct` is sent under a name the dev app does not hold. **Decided 2026-10-07** (epic README decision 6): the row keeps its name, which prod already holds (record 5.5), and the template is created in dev | The dev sync that shows `cod_confirm.en.direct` as Approved (live run step 1). Until then that style is refused by Meta in dev only |
| Section 7 | Variant usage per environment was never counted | The read-only query in the kit README, both environments |
| US-08-04 | Webhook subscription of the three template fields is not confirmed | Live run step 2 |
| US-08-07 | Copy drafts are not approved | Product owner |

**UNKNOWN findings in the record:**

| Finding | Unknown | Worst-case rule in force | Blocks | Can the live run close it? |
| --- | --- | --- | --- | --- |
| 4.10.8 | Does a button tap open the service window | Text is best effort, once, 131047 is a skip | **Items b and c** | Yes: step 10, dev |
| 4.3.8 | Status and sendability between an edit and re-approval | Not sendable until `approved` is read again | Editing a template | Yes: step 7b |
| 4.3.9 | What a failed edit review leaves | A template in use is never edited in place | Editing a template | Only if a review fails |
| 4.2.11, 4.2.12, 4.8.17 | Meaning of `LIMIT_EXCEEDED`, `IN_APPEAL`, `FLAGGED`, `LOCKED`, `REINSTATED`; what a pause ending looks like | Only `APPROVED` is sendable; a sync decides | Guardrail (it errs towards not sending) | Partly: step 6 shows `APPROVED`; a pause cannot be provoked |
| 4.8.15, 4.8.16, 4.8.18 | Webhook order, language code form, answer deadline | Ordered by `entry.time` per field; `-` and `_` alike; answered at once | Sync and webhooks | Partly: step 6 shows one real payload |
| 4.9.5 | Management calls per hour | Sync every 6 hours, manual cooldown, never loops | Sync | No |
| 4.1.7 | Archive and unarchive endpoints | Not used; by hand in WhatsApp Manager | Nothing in E08 | No |
| 4.3.10 | Whether edit windows roll | Akeed counts rolling windows itself | Editing | No |
| 4.4.7 | Whether an edit can change the parameter format | It never does | Nothing | No |
| 4.5.13 | How many messages a marketing re-categorization would stop | Alert, keep sending | A product decision if it happens | No |
| 4.6.11, 4.6.12, 4.6.13, 4.6.14 | Order of named values, value limits, language fallback at Meta, the parameter ratio | Send exactly what is sent today; warn on the ratio | Nothing while payloads are unchanged; new templates (ratio) | 4.6.14 partly: step 5 |
| 4.7.8, 4.7.9 | Payload length, documented shape of the send-time button | Buttons stay exactly as today | Nothing | No |

Unknowns the live run cannot close stay open with their worst-case rule. Releasing with them is an acceptance the product owner records, per item, in the live run script's sign-off.

## 9. Go / no-go recommendation

**Deploying the release candidate with every switch off: go.** With the switches off, every customer message is byte-identical to before the epic (criterion 3), and the one code change of this gate removes a token from error logs.

**Turning switches on: no-go today.** The record is a draft, prod has not been read, and the live run has not been done.

| Switch | Recommendation | What it waits for |
| --- | --- | --- |
| `WHATSAPP_TEMPLATE_SYNC_ENABLED` | **Go in dev now**, as live run step 1. Prod after the dev run reconciles | It only reads Meta. Needs `WA_BUSINESS_ACCOUNT_ID` and a token with `whatsapp_business_management` |
| `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED`, operator IDs, test phones | **Go in dev now**, for the live run. Prod after the dev run, **with `WHATSAPP_TEMPLATE_OPERATOR_IDS` filled in**: an empty list lets every staff member write | Nothing else. Off is the instant rollback |
| `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` | **No-go** | The environment's first sync read and compared; the variant usage count; in dev, `akeed_cod_verification_direct_` approved and synced (record 5.2 decision) |
| a. `WHATSAPP_REMINDER_TEMPLATE_ENABLED` | **No-go** | Approved copy, and a reminder template approved at Meta in that environment |
| b. `WHATSAPP_ACKNOWLEDGMENT_ENABLED` | **No-go** | Record 4.10.8 verified "yes" (live run step 10) and approved copy |
| c. `WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED` | **No-go** | The same two |
| d. `WHATSAPP_ARABIC_STYLE_AUTO_ENABLED` | **No-go in prod; go in dev after the guardrail is on there** | It sends existing approved templates, but it changes what customers of stores on `auto` receive; measure before prod |
| e. `WHATSAPP_LOCALIZED_FALLBACKS_ENABLED` | **No-go** | The four fallback texts approved and entered |
| f. `WHATSAPP_AMOUNT_FORMATTING_ENABLED` | **No-go in prod; go in dev** | The amount table approved. It changes a value every customer reads |
| g. `WHATSAPP_SNAPSHOT_PREVIEW_ENABLED` | **Go in dev after the first sync; prod after its first sync** | Merchant-facing only; no customer message changes |

Order, following the story's proposal: all of dev first; in prod sync, then operations, then the guardrail, then one US-08-07 item at a time. The measurement period between items and the rollback threshold (story open decision 3) are not decided.

## 10. Live-run results

| Environment | Date | Result |
| --- | --- | --- |
| dev | — | Not run |
| prod | — | Not run |

When the product owner hands back the filled script and the query results of its section D, its reconciliation table (R1 to R10) is filled in against the dispatch records and the per-template metrics, and this section and the verdict are updated.

## 11. Known limitations

- The gate proves behavior against fakes built from the record. Where the record is DOCUMENTED and not VERIFIED, the fake is a reading of Meta's documentation, not of Meta.
- All webhook payloads are documented shapes; none was captured from Meta.
- The gate was green in one run only in run 6 (section 1).
- The migration rehearsal on environment schemas was not done.
- No staging run of the admin pages was made by this gate; the frontend evidence is the unit suite and the production build.
- The skip reason on the verification row and the no-usage proof are asserted in different suites (section 4).
