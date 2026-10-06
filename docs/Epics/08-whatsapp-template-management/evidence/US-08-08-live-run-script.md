# US-08-08 — Live run script

- **Story:** [US-08-08 — Release gate](../US-08-08-release-gate.md), acceptance criterion 9
- **Written:** 2026-10-06
- **Who runs it:** the product owner, with that environment's own credentials. Run all of it on **dev** first. Run it on **prod** only after the dev run is reconciled.
- **What it is not:** it is not automated and nothing in the repository runs it. No test, script or agent calls Meta or sends a WhatsApp message for this run.

Fill in the "Evidence" lines as you go. Do not paste tokens, app secrets, phone numbers of customers, or template IDs into this file: write dates, counts, statuses and template **names**. When you finish, hand back this file and the query results of [section D](#d-reconcile-the-run); the reconciliation table there is then filled in against them.

## Before you start

| Check | dev | prod |
| --- | --- | --- |
| The release candidate is deployed (commits in the [gate record](US-08-08-release-gate.md)) | ☐ | ☐ |
| Migrations `0053` to `0060` applied at boot (no migration error in the boot log) | ☐ | ☐ |
| A staff test store exists, with a staff phone as the customer. **No real merchant store is used.** | ☐ | ☐ |
| `WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=true`, and `WHATSAPP_TEMPLATE_OPERATOR_IDS` holds your Supabase user ID. An empty list lets every staff member write; in prod, name the operators | ☐ | ☐ |
| `WHATSAPP_TEMPLATE_TEST_PHONES` holds the staff phone | ☐ | ☐ |
| `WA_BUSINESS_ACCOUNT_ID` is set, and the token has `whatsapp_business_management` (record 4.1.8) | ☐ | ☐ |
| Every US-08-07 switch is **off**, and `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` is **off** | ☐ | ☐ |
| Run start time (UTC), for the queries in section D | `____` | `____` |

**Migration counts (story implementation note).** Before the release candidate boots in an environment, and again after, run this read-only query and write both results down. After: `templates` is 8 or more, and `stores_without_ar_key` and `stores_without_en_key` count only stores created after the migration or stores whose old style has no registry row.

```sql
select
  (select count(*) from whatsapp_templates) as templates,
  (select count(*) from whatsapp_templates where is_default) as defaults,
  (select count(*) from integrations) as stores,
  (select count(*) from integrations where cod_template_ar_key is null) as stores_without_ar_key,
  (select count(*) from integrations where cod_template_en_key is null) as stores_without_en_key;
```

Before the first boot the first two sub-queries fail because the table does not exist yet; record the `stores` count alone.

- dev: before `____`, after `____`. prod: before `____`, after `____`.

**Prod only.** Steps 7 and 8 change what real stores send. Read the warning on each before you press anything, and do them in a quiet hour.

## A. Read-only steps

### 1. Reconcile Meta against the registry (AC 9.1)

1. From `akeed-backend`, with the environment's two variables loaded:

   ```powershell
   node --env-file=.env scripts/spikes/whatsapp-templates/list-templates.mjs --env dev
   ```

   ```powershell
   node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev
   ```

   For prod use the prod variables and `--env prod`, then add `--compare prod` to the second command run with `--env dev`.
2. Turn on `WHATSAPP_TEMPLATE_SYNC_ENABLED=true`, restart, open **Admin › Templates** and press **Sync now**.

**Expected.**
- The script's last line says the access token is not in the output files.
- The sync finishes as **Succeeded**. "Missing at Meta" lists exactly `cod_confirm.en.direct`, and "At Meta, not in Akeed" lists `akeed_cod_verification_direct` [`en`] and `hello_world` [`en_US`] (record 5.2, 5.3). Anything else is a finding: stop and record it.
- Every other registry template shows **Approved**, category Utility.
- The status, category and quality of each template on the page equal the script's output for the same name and language.

**Evidence.**
- dev: date `____`, templates at Meta `__`, missing `____`, extra `____`, differences between page and script `____`
- prod: date `____`, templates at Meta `__`, missing `____`, extra `____`, differences `____`
- This closes record 3.5 (prod not observed) when the prod run is read.

### 2. Webhook subscription of the template fields (AC 9.2)

In the Meta **App Dashboard › WhatsApp › Configuration**, check that the app is subscribed to `messages`, `message_template_status_update`, `message_template_quality_update` and `template_category_update` (record 4.8.1, 4.8.2). Subscribe the missing ones.

**Expected.** All four are listed. After step 4 below, the template page's history shows an event that arrived by webhook, not only by sync.

**Evidence.** dev: fields subscribed `____`, date `____`. prod: `____`, `____`.

### 3. Inspect (US-08-05)

Open three templates on **Admin › Templates**: the Arabic default, the English default and `cod_confirm.en.direct`.

**Expected.**
- Each shows Meta's own text in the phone preview, with sample values, in the right direction (RTL for Arabic).
- The two defaults show a **preview** difference (amber), not a **send** difference (red): record 6.1 found no hand-kept preview equal to Meta's text.
- `cod_confirm.en.direct` shows **Missing at Meta**.
- "Stores" lists your test store under the styles it chose.

**Evidence.** dev: `____`. prod: `____`. Any red (send) difference: `____`.

## B. Write steps

### 4. Test send (AC 9.5, on an existing template)

On the Arabic default, press **Send test** with the staff phone. Repeat on the English default.

**Expected.**
- Each message arrives within a minute, with sample values and two buttons.
- Tapping a button changes nothing in Akeed (the test's buttons name no verification).
- A second test within 30 seconds is refused; a phone that is not on the list is refused.
- The audit log has one `whatsapp-templates.test-send` row per send with the template key and **no phone**.

**Evidence.** dev: received `__` of 2, date `____`. prod: `__` of 2, `____`.

### 5. Draft and submit one throwaway template (AC 9.3)

1. **New draft**: purpose COD confirmation, a language, a style name such as `gate`, the four values, Confirm then Cancel.
2. **Dev:** any clear text will do. **Prod: write text you would be content for a real customer to read**, because step 7 makes it a default for a few minutes. Do not use the word "test" in a prod body.
3. Fix whatever validation marks, **Save draft**, then **Submit to Meta** once.

**Expected.**
- The generated name is `akeed_cod_confirm_<style>_v1`.
- One request goes to Meta. The draft becomes **Submitted**, and the registry gains one row that is **inactive and not a default**.
- No store's choice and no send changes.
- If Meta does not answer, the draft reads **Needs a check at Meta**. Press **Check at Meta**; do not submit again.

**Evidence.** dev: template name `____`, submit time `____`, first status `____`. prod: `____`, `____`, `____`.
This checks the story's assumption that each app allows a throwaway template: dev `____`, prod `____`.

### 6. Follow the review to approved (AC 9.4)

Wait. Meta's review can take up to 24 hours (record 4.2.3). Reload the template page; press **Sync now** if nothing has changed after an hour.

**Expected.** The status moves from **In review** to **Approved**, by webhook or by sync. If it is **Rejected**, the reason is shown; write it down, fix the text in a new draft and submit again.

**Evidence.** dev: approved at `____`, learned by webhook ☐ / sync ☐, minutes in review `___`. prod: `____`.
- Record 4.2.2 (first status of a create): observed `____`.
- Record 4.8.17 (members sent with `APPROVED`): the template history shows `____`.

Then **Send test** with the new template to the staff phone.

**Evidence.** dev: received ☐, text as written ☐, Confirm is the first button ☐. prod: ☐ ☐ ☐.

### 7. Activate, make default, and observe (AC 9.6)

1. **Activate** the new template. In the test store's **Settings › Message**, check that the new style can be chosen. Choose it and save.
2. **Make default** on the new template.

   > **Prod warning.** From this click until step 8, every store with no stored choice in that language, and every fallback, sends the throwaway template. Keep this window to a few minutes.
3. **Deactivate** it again is *refused* while a store selects it or it is the default without a replacement: confirm the page asks for a replacement.

**Expected.**
- Activating is refused for a template Meta has not approved, and allowed once it is.
- After **Make default**, exactly one template of that language is the default; the old default is still active.
- Each action writes one audit row with the flags before and after.

**Evidence.** dev: activated `____`, default at `____`. prod: `____`, `____`.

### 7b. Fallback and the staff alert (AC 9.7), dev only unless the product owner says otherwise

Turn on `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED=true` and restart. Make a non-default template unsendable where Meta allows it:
- **Option A:** edit the throwaway template's text (**Edit text**) after first moving the default back and taking the test store off it. It goes to review and reads **In review** (record 4.3.8 rule).
- **Option B:** point the test store's English style at `cod_confirm.en.direct`, which is **Missing at Meta** in both apps.

Then place one order in that language from the test store.

**Expected.**
- The customer phone receives the **language default**, not the unsendable template.
- The dispatch records `template_fallback_reason = not_approved` and the passed-over key.
- A `whatsapp-template-alert` log line exists for a template in use; the test store shows no `template_unavailable` signal, because the default stood in.

**Evidence.** dev: option `_`, received default ☐, fallback row ☐, alert line ☐.
- Record 4.3.8 (status between an edit and re-approval): observed `____`.
- Record 4.3.9 (after a failed edit review), only if it happens: `____`.

Turn the guardrail back **off** before continuing, unless you are deliberately leaving it on in dev.

### 8. Retire with a replacement (AC 9.8)

On the throwaway template press **Retire** and choose the **original default** of that language as the replacement.

**Expected.**
- The original template is the default again.
- The test store's choice moved to the replacement.
- The throwaway template is retired and cannot be activated again. Nothing was deleted at Meta: it still appears in WhatsApp Manager.

**Evidence.** dev: retired at `____`, default restored ☐, store moved ☐. prod: `____`, ☐, ☐.

Run the first query of the runbook's [section 4, step 2](US-08-08-template-support-runbook.md#step-2-check-whether-the-registry-itself-still-is-the-seeded-one) and confirm the defaults are `cod_confirm.ar.standard` and `cod_confirm.en.friendly`.

## C. Real orders

### 9. One real order per language (AC 9.9, with every US-08-07 switch off)

From the staff test store, with the staff phone as the customer:

1. Set the store's message language to **Arabic**. Place one COD order. When the message arrives, tap **Confirm**.
2. Set it to **English**. Place one COD order. Tap **Cancel**.

**Expected.**
- Each message is the store's chosen style in the forced language, with the store name, the order number and the total as before E08 (`349.50 SAR`, not a localized amount).
- The first verification ends **Confirmed**, the second **Canceled**, each with the reply recorded.
- No acknowledgment follows either tap (switch off).
- One usage (or one credit) is taken per order.

**Evidence.**

| | Arabic order | English order |
| --- | --- | --- |
| dev: order number | `____` | `____` |
| dev: style received | `____` | `____` |
| dev: outcome | `____` | `____` |
| prod: order number | `____` | `____` |
| prod: style received | `____` | `____` |
| prod: outcome | `____` | `____` |

### 10. Record 4.10.8: does a button tap open the service window? (dev only)

This is the one UNKNOWN the record assigns to this gate.

1. Add the `ack_confirmed` and `ack_canceled` texts for both languages on **Admin › Message texts**.
2. Turn on `WHATSAPP_ACKNOWLEDGMENT_ENABLED=true` and restart.
3. Place one order from the test store to a staff phone **that has not written to the Akeed number in the last 24 hours**. Tap **Confirm** and do nothing else.

**Expected, either way is a result.**
- The acknowledgment arrives: a tap opens the window. Record 4.10.8 becomes VERIFIED "yes".
- Nothing arrives and the service message is recorded as skipped with `window_closed`: a tap does not open it. Record 4.10.8 becomes VERIFIED "no", and items b and c stay off.

**Evidence.** dev: date `____`, phone had been silent for 24 hours ☐, acknowledgment received ☐ / skipped `window_closed` ☐.

Turn the switch off again.

### 11. Each US-08-07 item you intend to enable (AC 9.9)

Only for items whose copy is approved. One at a time: turn the switch on, restart, send one real verification from the test store, confirm one and cancel one, read the result, turn it off.

| Item | Switch | What to look for | dev | prod |
| --- | --- | --- | --- | --- |
| a | `WHATSAPP_REMINDER_TEMPLATE_ENABLED` | Needs an approved, active `cod_reminder` template. The reminder is the chosen reminder text, not a repeat. | `____` | `____` |
| b | `WHATSAPP_ACKNOWLEDGMENT_ENABLED` | Only if step 10 says "yes". One text after a confirm, one after a cancel, in the send's language. | `____` | `____` |
| c | `WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED` | Only if step 10 says "yes". Reply to the message with free text Akeed cannot read: one nudge, once. | `____` | `____` |
| d | `WHATSAPP_ARABIC_STYLE_AUTO_ENABLED` | Store on `auto`: a `+20` number gets the Egyptian style, a `+966` number the Gulf style. | `____` | `____` |
| e | `WHATSAPP_LOCALIZED_FALLBACKS_ENABLED` | An order with no customer name reads the Arabic or English fallback word, not `Customer`. | `____` | `____` |
| f | `WHATSAPP_AMOUNT_FORMATTING_ENABLED` | The total reads `1,250.00 ج.م` in Arabic and `EGP 1,250.00` in English. | `____` | `____` |
| g | `WHATSAPP_SNAPSHOT_PREVIEW_ENABLED` | The Settings preview equals the message received in step 9, word for word. | `____` | `____` |

## D. Reconcile the run

Run these read-only queries in the environment's SQL editor and hand back the rows. Replace the two placeholders: the test store's integration ID and the run's start time in UTC.

**D1. Every dispatch of the run.**

```sql
select d.created_at, d.kind, d.state, d.template_purpose, d.template_variant_key,
       d.meta_template_name, d.meta_language_code, d.resolved_language,
       d.template_fallback_reason, d.template_skipped_key,
       d.usage_reserved, d.accepted_at is not null as accepted,
       d.delivered_at is not null as delivered, d.read_at is not null as read,
       v.status as verification_status, o.is_test
from verification_message_dispatches d
join verifications v on v.id = d.verification_id
join orders o on o.id = v.order_id
where d.integration_id = '<TEST_STORE_INTEGRATION_ID>'
  and d.created_at >= '<RUN_START_UTC>'
order by d.created_at;
```

**D2. What the verifications themselves record.**

```sql
select v.created_at, v.status, v.template_name, v.language_code,
       v.confirmation_source, v.cancellation_source, v.metadata->>'reason' as reason
from verifications v
join orders o on o.id = v.order_id
where o.integration_id = '<TEST_STORE_INTEGRATION_ID>'
  and v.created_at >= '<RUN_START_UTC>'
order by v.created_at;
```

**D3. Template writes of the run, from the audit log.**

```sql
select created_at, action, outcome, metadata
from admin_access_audit
where created_at >= '<RUN_START_UTC>'
  and (action like 'whatsapp-template%' or action like 'whatsapp-message-text%')
order by created_at;
```

**D4. Sync runs and template events of the run.**

```sql
select started_at, trigger, status, error_code, provider_template_count,
       updated_count, missing_keys, unknown_at_provider
from whatsapp_template_sync_runs
where started_at >= '<RUN_START_UTC>' order by started_at;

select received_at, field, outcome
from whatsapp_template_events
where received_at >= '<RUN_START_UTC>' order by received_at;
```

**D5. Service messages (step 10 and items b, c).**

```sql
select created_at, kind, state, skip_reason
from verification_service_messages
where created_at >= '<RUN_START_UTC>' order by created_at;
```

**D6. Per-template metrics.** On **Admin › Templates**, set the range to the run's dates and note, for each template the run sent, the number of sends, confirmed, canceled and reminders. Merchant tests and staff tests are not counted.

### Reconciliation table

Filled in from D1 to D6 after the run. A row that does not reconcile blocks go.

| # | What must agree | dev | prod |
| --- | --- | --- | --- |
| R1 | Step 9: two `initial` dispatches, `accepted`, each with the template name and language code the phone showed, no fallback reason, `usage_reserved = true` | `____` | `____` |
| R2 | Step 9: `verifications.template_name` and `language_code` equal the dispatch's `meta_template_name` and `meta_language_code` | `____` | `____` |
| R3 | Step 9: one verification `confirmed` and one `canceled`, both by the customer | `____` | `____` |
| R4 | Step 7b: one dispatch with `template_fallback_reason = not_approved` and the skipped key; the name sent is the language default | `____` | n/a |
| R5 | Steps 4 and 6: staff test sends appear in **no** dispatch row and in **no** metric; each has one audit row | `____` | `____` |
| R6 | Steps 5 to 8: one audit row per write (create, submit, activate, set-default, retire), none with template text | `____` | `____` |
| R7 | Step 1: the sync run's `missing_keys` and `unknown_at_provider` equal the reconciliation script's lists | `____` | `____` |
| R8 | D6: per template, sends in the metrics equal the count of accepted, non-test dispatches in D1 for that `template_variant_key`; confirmed and canceled equal D2 | `____` | `____` |
| R9 | Step 10: one `acknowledgment` row, `sent` or `skipped` / `window_closed`, matching what the phone showed; no dispatch and no usage for it | `____` | n/a |
| R10 | After step 8: the defaults are the two seeded ones and the throwaway template is retired | `____` | `____` |

## E. Sign-off

| | dev | prod |
| --- | --- | --- |
| Run finished (date) | `____` | `____` |
| Rows R1 to R10 reconcile | ☐ | ☐ |
| Limitations accepted (list) | `____` | `____` |
| Run by | `____` | `____` |
